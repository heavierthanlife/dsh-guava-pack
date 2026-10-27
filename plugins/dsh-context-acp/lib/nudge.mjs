/**
 * dsh-context-acp — pre-step nudge 策略（C 负责）。
 *
 * ## 为什么 nudge 存在
 *
 * ACP 模式下引擎**不**在常规压力时自动压缩（`compactIfNeeded('pressure')` 返回
 * null），何时压、压哪段交给模型。但模型不会自己盯着 token 数，所以必须在
 * 压力到线时提醒它一次。提醒点选在 `agent/pre-step`：这是每步模型调用前
 * 唯一能追加一条 user-role 提醒、且与真实 turn 走同一条分发路径的 waterfall。
 *
 * ## 三条规则（纯函数，便于单测）
 *
 *   `decideNudge` 只做判定，不做 IO：
 *     压力阈值（`pressureRatio`）→ 每 turn 上限（`maxPerTurn`）→
 *     冷却步数（`cooldownSteps`）→ 自上次 nudge 的 token 增长（`growthTokens`）。
 *   顺序是刻意的：先便宜且决定性的条件，再历史条件；reason 字符串稳定，
 *   面板/日志可以直接展示（不翻译、不拼动态文本）。
 *
 * ## 注入方式（与 P3 任务书的一处必要偏离）
 *
 * 任务书要求「不给 source、只进本次请求投影、不写 session 日志」。实测
 * `dsh-agent-loop` 的 `step()` 会对 `decision.messages` 的**每一条**读取
 * `message.source.kind`，并在 firstAttempt 时 `session.append('user/message', …)`：
 *
 *   for (const message of decision.messages)
 *     if (message.source.kind === 'runtime-context') { … } else session.append(…)
 *
 * 也就是说 pre-step 注入的消息**必然**进日志；没有 source 会直接抛
 * `Cannot read properties of undefined (reading 'kind')`，把整个 turn 弄挂。
 * 所以这里给一条诚实、可扩展的 source（`kind: 'context-acp'`，`form: 'notice'`），
 * 与内置 `dsh-time-context` 的注入形状一致。代价是每次 nudge 会留下一条
 * user 消息（有 cooldown/maxPerTurn 限制，量可控），下次请求模型会看到它。
 *
 * ## 失败必须安静
 *
 * nudge 是增强，不是 turn 的必要条件。任何异常都只能记进共享 state
 * （`recordError`，面板可见）然后原样返回 `next()` 的结果 —— 绝不能让
 * 一个提醒把整个 turn 弄挂。
 *
 * @module dsh-context-acp/nudge
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { buildLedger } from './ledger.mjs';
import { markArmed, recordError, recordNudge, recordSkip, resetTurn, stateOf } from './state.mjs';

/** runtime.nudge 缺项时的兜底（与 config/acp.json 保持一致）。 */
const DEFAULT_NUDGE = Object.freeze({
  pressureRatio: 0.65,
  growthTokens: 12000,
  cooldownSteps: 6,
  maxPerTurn: 2,
});

/** 有限正数？用于所有「用量/窗口」输入 —— NaN/0/负数一律视为没有数据。 */
function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 有限非负数（配置项允许 0，例如关闭增长门槛）。 */
function isNonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 纯策略：根据当前压力与历史决定是否 nudge。
 *
 * `nextState` 只包含策略自己拥有的四个字段；调用方通常直接把它交给
 * `recordNudge`/`resetTurn`，所以这里**不**返回整个 state 的副本，避免
 * 两套字段名漂移。
 *
 * @param {object} params
 * @param {number} params.usedTokens 当前估算占用
 * @param {number} params.contextWindow 模型窗口
 * @param {object} [params.nudge] 配置（runtime.nudge）
 * @param {object} [params.state] 每 agent 的 nudge 状态
 * @param {number} [params.step] 当前 step（冷却判定）
 * @returns {{ nudge: boolean, reason: string, nextState: object }}
 */
export function decideNudge({ usedTokens, contextWindow, nudge, state, step } = {}) {
  const config = nudge !== null && typeof nudge === 'object' ? nudge : {};
  const current = {
    lastNudgeStep: Number.isFinite(state?.lastNudgeStep) ? state.lastNudgeStep : -1,
    lastNudgeTokens: Number.isFinite(state?.lastNudgeTokens) ? state.lastNudgeTokens : 0,
    turnNudges: Number.isFinite(state?.turnNudges) ? state.turnNudges : 0,
    lastTurn: state?.lastTurn,
  };

  /** 未命中：nextState 与输入等价（只带策略字段）。 */
  const skip = (reason) => ({ nudge: false, reason, nextState: { ...current } });

  // 1) 没有可信的压力数据：不猜、不 nudge。
  if (!isPositiveFinite(usedTokens) || !isPositiveFinite(contextWindow)) return skip('no-pressure');

  const pressureRatio = isNonNegativeFinite(config.pressureRatio) ? config.pressureRatio : DEFAULT_NUDGE.pressureRatio;
  const maxPerTurn = isNonNegativeFinite(config.maxPerTurn) ? config.maxPerTurn : DEFAULT_NUDGE.maxPerTurn;
  const cooldownSteps = isNonNegativeFinite(config.cooldownSteps) ? config.cooldownSteps : DEFAULT_NUDGE.cooldownSteps;
  const growthTokens = isNonNegativeFinite(config.growthTokens) ? config.growthTokens : DEFAULT_NUDGE.growthTokens;

  // 2) 未到阈值：这是绝大多数 step 的结论，必须便宜。
  if (usedTokens / contextWindow < pressureRatio) return skip('below-threshold');

  // 3) 每 turn 上限：防止一个 turn 里每步都念经。
  if (current.turnNudges >= maxPerTurn) return skip('turn-cap');

  // 4) 冷却：同一段压力不在相邻几步里重复提醒。step 缺失时跳过冷却判定
  //    （没有 step 就没有"相邻"语义，硬套会永远 cooldown）。
  if (
    current.lastNudgeStep >= 0
    && Number.isFinite(step)
    && step - current.lastNudgeStep < cooldownSteps
  ) {
    return skip('cooldown');
  }

  // 5) 增长门槛：压力高但没涨（例如刚压完）时不催第二次。
  if (
    current.lastNudgeTokens > 0
    && usedTokens - current.lastNudgeTokens < growthTokens
  ) {
    return skip('insufficient-growth');
  }

  return {
    nudge: true,
    reason: 'pressure',
    nextState: {
      ...current,
      lastNudgeStep: Number.isFinite(step) ? step : current.lastNudgeStep,
      lastNudgeTokens: usedTokens,
      turnNudges: current.turnNudges + 1,
    },
  };
}

/** 千分位（不用 toLocaleString：文本要可缓存、跨环境一致）。 */
function formatTokens(value) {
  if (!isPositiveFinite(value)) return '—';
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 构建 nudge 文本（稳定、可缓存：无时间戳、无随机值）。
 *
 * 文本同时承担两个职责：给出当前压力的事实，以及「下一步做什么」的操作
 * 规则。规则必须具体到工具名，否则模型会回一句"好的，我会注意"然后继续堆。
 *
 * @param {object} params
 * @param {number} params.usedTokens
 * @param {number} params.contextWindow
 * @param {number|Array} [params.blocks] 当前块数（也接受账本数组）
 * @param {number} [params.tierMax] 最高 tier
 * @returns {string}
 */
export function renderNudge({ usedTokens, contextWindow, blocks, tierMax } = {}) {
  const blockCount = Array.isArray(blocks)
    ? blocks.length
    : isNonNegativeFinite(blocks) ? Math.trunc(blocks) : 0;
  const highestTier = isNonNegativeFinite(tierMax)
    ? Math.trunc(tierMax)
    : Array.isArray(blocks)
      ? blocks.reduce((max, block) => (isNonNegativeFinite(block?.tier) ? Math.max(max, block.tier) : max), 0)
      : 0;
  const percent = isPositiveFinite(usedTokens) && isPositiveFinite(contextWindow)
    ? Math.round((usedTokens / contextWindow) * 100)
    : null;
  const usage = percent === null
    ? '上下文占用未知'
    : `当前占用 ${formatTokens(usedTokens)} / ${formatTokens(contextWindow)}（${percent}%）`;

  return [
    `[acp-nudge] ${usage}，已压 ${blockCount} 块（最高 tier ${highestTier}）。`,
    '',
    '现在由你决定是否压缩，按这个顺序做：',
    '1. 先调 `acp_status` 看账本：块目录、tier、被压区间与 token，确认哪一段已经过时。',
    '2. 选一个连续、只靠摘要也能继续工作的区间，用 `compress` 提交你自己写的无损摘要：保留精确文件路径、命令、错误串、标识符、数值、函数签名和用户明确要求。',
    '3. 不要压缩策略文件（AGENTS.md 等）的当前副本、skill 目录（<available_skills>）和当前用户消息所在区间 —— 工具会拒绝并点名。',
    '4. 压掉的原文可以 `decompress` 分页取回，`search_context` 能检索摘要与原文；压错了不是永久丢失。',
    '',
    '摘要不是总结，是让工作能继续的压缩：该保留的事实一条都不能丢。',
  ].join('\n');
}

/**
 * 测试钩子：`DSH_ACP_TEST_PRESSURE="used:window"`（也接受逗号分隔）。
 *
 * 只在测试进程里设置。放在压力读取的第一位，是为了让 nudge 的单测不依赖
 * tokenMeter / llm / sessionProjections 三个宿主服务；生产环境不设这个变量，
 * 行为完全不受影响。
 *
 * @returns {{ usedTokens: number, contextWindow: number } | undefined}
 */
function readTestPressure() {
  const raw = process.env.DSH_ACP_TEST_PRESSURE;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parts = raw.split(/[:,]/).map((part) => Number(part.trim()));
  if (parts.length !== 2) return undefined;
  const [usedTokens, contextWindow] = parts;
  if (!isPositiveFinite(usedTokens) || !isPositiveFinite(contextWindow)) return undefined;
  return { usedTokens, contextWindow };
}

/**
 * 读宿主 `contextPressure` 投影（首选来源）。
 *
 * 用 `projectedTokens`（下一次请求的估算）而不是 `pressureTokens`（上次请求的
 * 供应商回报）：nudge 发生在**下一次请求之前**，前者才是模型即将面对的压力。
 * 但可用性门槛仍按契约要求 `contextWindow` + `pressureTokens` 同时存在。
 *
 * @param {object} deps
 * @param {object} agent
 * @returns {{ usedTokens: number, contextWindow: number } | undefined}
 */
function readProjectionPressure(deps, agent) {
  try {
    const view = deps.ctx?.get?.('sessionProjections')
      ?.snapshot?.(agent?.session, ['contextPressure'])
      ?.values?.contextPressure;
    if (view === null || typeof view !== 'object') return undefined;
    if (!isPositiveFinite(view.contextWindow) || !isPositiveFinite(view.pressureTokens)) return undefined;
    const usedTokens = isPositiveFinite(view.projectedTokens) ? view.projectedTokens : view.pressureTokens;
    return { usedTokens, contextWindow: view.contextWindow };
  } catch {
    return undefined;
  }
}

/**
 * 读宿主 tokenMeter + 模型窗口（兜底来源）。
 *
 * 模型窗口来自 `llm.resolveModelInfo(provider, model)`，按 route 缓存 Promise：
 * 同一会话的每一步都问一次没必要，而 resolveModelInfo 可能真的打网络/读注册表。
 * 服务还没挂载时**不缓存**（Cordis 的服务可以后到），失败才缓存 null。
 *
 * @param {object} deps
 * @param {object} agent
 * @param {Map<string, Promise<number|null>>} windowCache
 * @returns {Promise<{ usedTokens: number, contextWindow: number } | undefined>}
 */
async function readMeterPressure(deps, agent, windowCache) {
  try {
    const meter = deps.tokenMeter?.();
    if (typeof meter?.measure !== 'function') return undefined;
    const measured = await meter.measure(agent?.session);
    const usedTokens = measured?.totalTokens;
    if (!isPositiveFinite(usedTokens)) return undefined;

    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    if (typeof provider !== 'string' || provider === '') return undefined;
    if (typeof model !== 'string' || model === '') return undefined;

    const contextWindow = await resolveContextWindow(deps, provider, model, windowCache);
    if (!isPositiveFinite(contextWindow)) return undefined;
    return { usedTokens, contextWindow };
  } catch {
    return undefined;
  }
}

/**
 * 解析路由的上下文窗口（带 per-route Promise 缓存）。
 *
 * @param {object} deps
 * @param {string} provider
 * @param {string} model
 * @param {Map<string, Promise<number|null>>} cache
 * @returns {Promise<number|null>}
 */
async function resolveContextWindow(deps, provider, model, cache) {
  const key = `${provider}\u0000${model}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let llm;
  try {
    llm = deps.ctx?.get?.('llm');
  } catch {
    llm = undefined;
  }
  const resolveModelInfo = llm?.resolveModelInfo;
  // 服务还没到：不缓存，下一步可能就已经挂载了。
  if (typeof resolveModelInfo !== 'function') return null;

  const pending = (async () => {
    try {
      // 必须用服务实例作 this：resolveModelInfo 会读该实例自己的路由表。
      const info = await resolveModelInfo.call(llm, provider, model);
      const window = info?.context?.contextWindow;
      return isPositiveFinite(window) ? window : null;
    } catch {
      // 路由不存在/模型未知是正常情况：记住 null，别每一步重试。
      return null;
    }
  })();
  cache.set(key, pending);
  return pending;
}

/** 账本里的最高 tier（没有块时 0）。 */
function tierMaxOf(blocks) {
  let max = 0;
  for (const block of blocks) {
    if (isNonNegativeFinite(block?.tier)) max = Math.max(max, block.tier);
  }
  return max;
}

/**
 * 构建 pre-step 处理器（**纯工厂，不注册**）。
 *
 * 为什么把 handler 单独导出：`agent/pre-step` 是全局 waterfall，真实宿主里还有
 * `dsh-agent-instructions` / `dsh-tool-skill` 等监听器，它们假设 payload 来自
 * 真实 agent-loop（合法 messages、signal、请求上下文）。隔离进程的 e2e 想验证
 * 「我们注册的那个 handler 会不会注入提醒」，不能 dispatch 整条 waterfall
 * （会先被别的监听器按真实 payload 假设炸掉），只能拿到同一个 handler 直接调用。
 * 生产路径 `installNudge()` 用的就是这里返回的同一个函数，不存在两套逻辑。
 *
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {(payload: object, next: () => Promise<object>) => Promise<object>}
 */
export function createNudgeHandler(deps) {
  /** agent → 上一次看到的 turn。turn 变化 = 新的 turn，本 turn 的 nudge 计数清零。 */
  const lastTurns = new WeakMap();
  /** route → Promise<window|null>（见 resolveContextWindow）。 */
  const windowCache = new Map();
  /** 同一 agent 的内部错误只 warn 一次（recordError 每次都记，面板仍可见）。 */
  const warned = new WeakSet();

  return async (payload, next) => {
    // 契约：先跑完下游，拿到最终 decision 再决定要不要改 messages。
    const result = await next();
    if (result === null || typeof result !== 'object' || result.kind !== 'enter') return result;

    const agent = payload?.agent;
    if (agent === null || typeof agent !== 'object') return result;
    if (payload?.signal?.aborted === true) return result;

    try {
      // turn 复位放在最前：即使本步没有压力数据，也不能让上个 turn 的计数泄漏。
      if (payload.turn !== undefined && lastTurns.get(agent) !== payload.turn) {
        lastTurns.set(agent, payload.turn);
        resetTurn(agent);
      }

      let pressure = readTestPressure();
      if (pressure === undefined) pressure = readProjectionPressure(deps, agent);
      if (pressure === undefined) pressure = await readMeterPressure(deps, agent, windowCache);
      if (pressure === undefined) {
        recordSkip(agent, 'no-pressure');
        return result;
      }

      // 能力灯：引擎必须真的提供 stageSummary（ACP 的待用摘要通道）。
      // 解析不到就诚实关灯，不尝试调用一个不存在的方法。
      const engine = deps.resolveEngine?.(agent);
      if (typeof engine?.stageSummary !== 'function') {
        markArmed(agent, false);
        recordSkip(agent, 'armed-missing');
        return result;
      }
      markArmed(agent, true);

      const decision = decideNudge({
        usedTokens: pressure.usedTokens,
        contextWindow: pressure.contextWindow,
        nudge: deps.runtime?.nudge,
        state: stateOf(agent),
        step: payload.step,
      });

      if (!decision.nudge) {
        if (typeof decision.reason === 'string' && decision.reason !== '') recordSkip(agent, decision.reason);
        return result;
      }

      const blocks = buildLedger(agent.session);
      const nudgeText = renderNudge({
        usedTokens: pressure.usedTokens,
        contextWindow: pressure.contextWindow,
        blocks,
        tierMax: tierMaxOf(blocks),
      });

      // 先记账再注入：注入的消息由 agent-loop 写入日志（见文件头），state 是面板
      // 侧"发生过提醒"的权威读数。
      recordNudge(agent, {
        usedTokens: pressure.usedTokens,
        contextWindow: pressure.contextWindow,
        step: payload.step,
        reason: decision.reason,
      });

      const nudgeMessage = createUserMessage({
        content: [{ type: 'text', text: nudgeText }],
        // 必须给合法 source：agent-loop 对每条 decision.messages 硬读
        // `message.source.kind`（只有 runtime-context 会被跳过——但跳过就意味着
        // 模型看不到提醒）。所以提醒会作为一条 logged user 消息留在历史里，
        // 受 cooldown/maxPerTurn 限制；这也是它可回放、可审计的原因。
        source: { kind: 'context-acp', form: 'notice', summary: 'ACP 上下文压力提醒' },
      });
      return {
        ...result,
        messages: [...(result.messages ?? []), nudgeMessage],
      };
    } catch (error) {
      // 提醒失败不能影响 turn：记进共享状态（面板可见），原样放行。
      try {
        recordError(agent, error);
      } catch {
        /* state 层也不该再抛 */
      }
      if (!warned.has(agent)) {
        warned.add(agent);
        deps.logger?.warn?.(`[acp] nudge 已跳过（内部错误，同类每 agent 只报一次）：${String(error?.message ?? error)}`);
      }
      return result;
    }
  };
}

/**
 * 安装 pre-step nudge（注册 `createNudgeHandler` 返回的同一个 handler）。
 *
 * 注意：`ctx.on('agent/pre-step', ...)` 对**所有** agent 生效，所以 turn 状态
 * 必须按 agent 分开存（模块级 WeakMap，agent 销毁自动回收）。
 *
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {() => void} disposer
 */
export function installNudge(deps) {
  const handler = createNudgeHandler(deps);
  const off = deps.ctx.on('agent/pre-step', handler);
  return () => {
    try {
      off?.();
    } catch {
      /* 已随上下文销毁 */
    }
  };
}
