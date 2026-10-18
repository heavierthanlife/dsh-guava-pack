/**
 * dsh-context-guard — host half.
 *
 * ## 它解决什么
 *
 * `dsh-compaction-basic` 的自动压缩挂在 **`agent/pre-step`**：一轮任务里的每个
 * step 之前都可能压缩，也就是「任务运行中压缩」。本插件把策略拿回自己手里：
 *
 *   1. 只在 **`turn/end`（且 reason 命中 config.triggerOn，默认 completed）** 之后考虑压缩，
 *      也就是"一次对话自然结束之后"。
 *   2. 用 **`ctx.compaction.compactNow()`**，不用 `compactIfNeeded()`。两者差别是硬的：
 *      `compactIfNeeded` 要求"numeric open-turn owner"（必须在 turn 内），
 *      而 `compactNow` 使用 `turn: null`，**先同步占住 idle admission**，
 *      agent 不空闲就抛 `ManualCompactionError('busy')`。所以"不在任务运行中压缩"
 *      不是靠我们自觉，而是 service 强制的。
 *   3. 阈值由本插件判断（`contextPressure` 投影的 projectedTokens / contextWindow），
 *      不看 backend 的 thresholdRatio。
 *
 * ## 关键部署事实：compaction 住在 agent preset 里，不在根平面
 *
 * 本 profile 的 `dsh-web-app/cordis.patch.yml` 把根平面的 `compaction-basic` 与
 * `command-compact` 都设成 **`disabled: true`**（注释说明这是有意的：compaction 是
 * preset 拥有的能力，而它的投影表是进程级的，不能变成"哪个 preset 恰好挂着"的函数），
 * 改由 `dsh-web-app/presets/cordis.patch.yml` 里的 `compaction` group 按 preset 挂载，
 * 并 `isolate: { compaction: true }`。
 *
 * 后果：**根上下文的 `ctx.compaction` 不存在，`agent.ctx` 也看不到它** ——
 * preset 的 mount 不在 agent 的 fiber 之下，被 `isolate` 的服务只在该 realm 内可见。
 * 正确的读地址是注册表的 **`ctx.agentPresets.serviceFor(agent, 'compaction')`**，
 * 它正是为"已经持有 agent 的调用方"准备的（浏览器 RPC 也走这条路）。
 * 所以本插件对每个 live agent：用 `serviceFor` 解析实例 + 在 `agent.ctx` 上听
 * `session/event`。插件激活时用 `ctx.agents.list()` 接管**已经存在**的 agent，
 * 之后由 `agent/created` 接管新 agent。
 *
 * 解析不到 compaction 时，投影里的 `armed` 会是 false —— 这是显示层的诚实指示灯，
 * 而不是静默失效。
 *
 * ## 状态与显示
 *
 * 注册 `contextGuard` 投影（纯 fold 会话日志），并通过 `wire.view` 送到客户端：
 * 已压缩次数、上次释放的 token、轮/步数、上下文容量、`handoffDue`、`armed`。
 * 客户端另读 token-meter 自己的 `contextPressure` 显示占用百分比 —— 不重复造数。
 *
 * ## 为什么 fold 里没有"上次动作/上次错误"
 *
 * 会话日志是唯一事实来源，而新增自定义事件类型会让 Session 拒绝重开
 * （未知事件必须带 `ignorable: true`，`Session.append()` 无法设置）。
 * 所以显示层只用"可推导"的量：压缩次数一涨，就说明压缩真的发生了。
 *
 * @module dsh-context-guard
 */

import { z } from 'zod';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Cordis 插件名。 */
const name = 'context-guard';

/** 投影注册表是硬依赖；`agents` / `compaction` 走可选注入。 */
const inject = ['sessionProjections'];

/**
 * 行级配置（cordis.patch.yml 的 `config`）。
 *
 * **有意不导出 `Config`**：DSH 的插件 Config 必须是原生 **Schemastery** schema
 * （`dsh-app-boot` 的 `isNativeConfigSchema` 检查 `Symbol.for('schemastery')`），
 * 而本机没有 schemastery 包可解析；导出 zod 对象会让 Config 投影得到
 * `status: "unsupported"` 并报一条 "Config is not a native Schemastery schema"
 * 诊断（插件仍会激活，但会在 Plugin Manager 里留下噪音）。
 * 所以配置在这里用默认值 + `num()` 兜底校验，和本机其它本地插件一致。
 */
function normalizeConfig(rawConfig) {
  return {
    // 和面板同一条夹取路径：patch 里写 0.05 会让几乎每一轮都压缩。
    thresholdRatio: clampThresholdRatio(rawConfig?.thresholdRatio) ?? 0.6,
    handoffAfterCompactions: clampHandoffCount(rawConfig?.handoffAfterCompactions) ?? 2,
    writeHandoff: rawConfig?.writeHandoff !== false,
    triggerOn: Array.isArray(rawConfig?.triggerOn) && rawConfig.triggerOn.length > 0 ? rawConfig.triggerOn : ['completed'],
    handoffPrefix: typeof rawConfig?.handoffPrefix === 'string' && rawConfig.handoffPrefix !== '' ? rawConfig.handoffPrefix : 'HANDOFF-context-guard',
    maxRecentUserMessages: clampRecentMessages(rawConfig?.maxRecentUserMessages) ?? 8,
  };
}

/** fold 出来的每会话状态（同时是 checkpoint 的形状，保持纯 JSON）。 */
const guardStateSchema = z.object({
  compactions: z.number().int().nonnegative(),
  failedCompactions: z.number().int().nonnegative(),
  lastFreedTokens: z.number().nonnegative(),
  lastCompactionAt: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  lastTurnEndedAt: z.number().nonnegative(),
  lastEndReason: z.string(),
  contextWindow: z.number().nonnegative(),
  provider: z.string(),
  model: z.string(),
});

/**
 * 送到客户端的视图。
 *
 * `view` 是本插件自己的函数，所以可以直接捕获 config 与插件的能力标志 ——
 * 阈值与 `armed` 不必再复制一份到客户端，避免两处漂移。
 * （`armed` 是"这个进程里 compaction 服务解析到了吗"的能力标志，不是会话数据；
 *  它会在下一次事件发布时随视图一起刷新。）
 */
function makeViewSchema() {
  return guardStateSchema.extend({
    thresholdPercent: z.number().positive(),
    handoffAfter: z.number().int().positive(),
    handoffDue: z.boolean(),
    armed: z.boolean(),
  });
}

/** 有限非负数，否则 undefined。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 把异常压成一行可诊断文本。
 *
 * 存在的理由：压缩与写盘的失败以前是 `void error` 直接吞掉的，于是"面板说写好了、
 * 磁盘上没有"完全无从排查。至少要留下 code / message。
 */
function describeError(error) {
  if (error === null || error === undefined) return 'unknown';
  const code = error?.code ? `${error.code}: ` : '';
  const message = error?.message ? String(error.message) : String(error);
  const cause = error?.cause?.code ? ` (cause=${error.cause.code})` : '';
  return `${code}${message}${cause}`;
}

/** 面板 → host 的设置通道路径（自己注册的 webServer 前缀路由）。 */
const ROUTE_PATH = '/context-guard';

/** 阈值：20%–95%，5% 一档（和面板上的上下键一样）。 */
function clampThresholdRatio(value) {
  const n = num(value);
  if (n === undefined) return undefined;
  return Math.min(0.95, Math.max(0.2, Math.round(n * 20) / 20));
}

/** handoff 触发次数：1–5 的整数。 */
function clampHandoffCount(value) {
  const n = num(value);
  if (n === undefined) return undefined;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** handoff 里保留的最近用户消息条数：1–50 的整数（默认 8，仅作上限兜底）。 */
function clampRecentMessages(value) {
  const n = num(value);
  if (n === undefined) return undefined;
  return Math.min(50, Math.max(1, Math.round(n)));
}

/** 读一个小请求体（有上限，坏客户端不能拖住内存）。 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 按 connection 的 server-response 信封回复。 */
function sendRpc(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
}

/** 从 ContentBlock[] / string / {text} 里尽力取出纯文本。 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return textOf(value.content);
  }
  return '';
}

/** 消息事件里的正文（user/message 的 data 就是 UserMessage 本身）。 */
function messageText(event) {
  return textOf(event?.data?.content ?? event?.data?.message?.content ?? event?.data);
}

/** 从 Tool call 的参数里取目标文件路径。 */
function callFilePath(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments === '') return '';
  try {
    const args = JSON.parse(rawArguments);
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
      if (typeof args?.[key] === 'string') return args[key];
    }
  } catch {
    /* 参数不是合法 JSON 时忽略 */
  }
  return '';
}

/** 时间戳后缀（本地时间，文件名安全）。 */
function stamp(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 组装 handoff 正文。
 *
 * 素材全部来自会话日志：压缩摘要（最高价值 —— 那是被折叠掉的历史的官方浓缩）、
 * 最近的用户消息、动过的文件、统计数字。
 */
function buildHandoff(session, state, cfg) {
  const events = [...session.snapshotEvents()];
  const summaries = [];
  const recentUsers = [];
  const files = new Set();
  let route = '';

  for (const event of events) {
    switch (event.type) {
      case 'compaction/summary': {
        const text = textOf(event.data?.summary) || textOf(event.data?.text);
        if (text) summaries.push(text);
        break;
      }
      case 'user/message': {
        const text = messageText(event).trim();
        if (text) recentUsers.push(text);
        break;
      }
      case 'tool/call': {
        if (event.data?.name === 'write' || event.data?.name === 'edit') {
          const path = callFilePath(event.data?.arguments);
          if (path) files.add(path);
        }
        break;
      }
      case 'request/context': {
        route = [event.data?.provider, event.data?.model].filter(Boolean).join('/');
        break;
      }
      default:
        break;
    }
  }

  const tail = recentUsers.slice(-cfg.maxRecentUserMessages);
  const lines = [
    '# HANDOFF — 由 dsh-context-guard 自动生成',
    '',
    `- 会话: \`${session.id}\``,
    `- 生成时间: ${new Date().toLocaleString()}`,
    `- 工作目录: ${session.header?.cwd ?? '(未记录)'}`,
    `- 模型路由: ${route || [state.provider, state.model].filter(Boolean).join('/') || '(未记录)'}`,
    `- 规模: ${state.turns} 轮 / ${state.steps} 步`,
    `- 已压缩: ${state.compactions} 次（阈值 ${Math.round(cfg.thresholdRatio * 100)}%）`,
    `- 上次压缩释放: ${state.lastFreedTokens} tokens`,
    `- 上下文窗口: ${state.contextWindow || '(未记录)'}`,
    '',
    '## 目标与当前进展',
    '',
    '> 这一节是模板位：把当前任务的真实目标、已完成项与未完成项补在这里。',
    '> 下面的「压缩摘要」是历史被折叠时的官方浓缩，通常已包含大部分脉络。',
    '',
  ];

  if (files.size > 0) {
    lines.push('## 本会话动过的文件', '', ...[...files].map((f) => `- \`${f}\``), '');
  }

  if (summaries.length > 0) {
    lines.push('## 压缩摘要（按时间顺序）', '');
    summaries.forEach((text, index) => {
      lines.push(`### 第 ${index + 1} 次压缩`, '', text, '');
    });
  }

  if (tail.length > 0) {
    lines.push(`## 最近 ${tail.length} 条用户消息`, '');
    for (const text of tail) {
      const clipped = text.length > 2000 ? `${text.slice(0, 2000)}\n…（已截断）` : text;
      lines.push('```text', clipped, '```', '');
    }
  }

  lines.push(
    '## 下一步',
    '',
    '1. 在新会话里先读这份 handoff，再读上面列出的文件。',
    '2. 不要重复已完成的工作；从「未完成项」继续。',
    '',
    `> 触发原因：本会话第 ${state.compactions} 次压缩达到 handoffAfterCompactions=${cfg.handoffAfterCompactions}。`,
    '',
  );

  return lines.join('\n');
}

/**
 * 挂载 host 半边：一个投影 + 一个 turn 结束后的压缩/交接流程。
 * @param ctx - 带有 sessionProjections 的上下文。
 * @param rawConfig - 行配置；缺项由 {@link normalizeConfig} 填默认值。
 */
function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);

  /**
   * 运行期可调的两个参数（面板上改 → 写回这里 → 落盘）。
   * 初值来自 patch 的 `config`；启动时若存在设置文件则文件优先。
   */
  const settings = {
    thresholdRatio: cfg.thresholdRatio,
    handoffAfterCompactions: cfg.handoffAfterCompactions,
  };

  /** 正在压缩的会话，避免同一轮结束重复触发。 */
  const inFlight = new Set();
  /** agent → 该 agent 作用域上的 disposer，插件卸载时统一清理。 */
  const perAgent = new Map();
  /** 至少有一个 agent 的 realm 里解析到 compaction 吗（显示层的诚实指示灯）。 */
  let armed = false;
  /**
   * 最近一次 handoff 尝试的真实结果：
   * `{ written, file?, reason, sessionId, at }`。
   * 面板经 `/context-guard/getSettings` 读它，从而能显示"写了没有 / 写到哪 / 为什么失败"。
   */
  let lastHandoff = null;

  // ── 1. 投影：压缩次数 / 释放量 / 轮步数 / 容量 ────────────────────────
  ctx.sessionProjections.register({
    key: 'contextGuard',
    stateVersion: 1,
    stateSchema: guardStateSchema,
    init: () => ({
      compactions: 0,
      failedCompactions: 0,
      lastFreedTokens: 0,
      lastCompactionAt: 0,
      turns: 0,
      steps: 0,
      lastTurnEndedAt: 0,
      lastEndReason: '',
      contextWindow: 0,
      provider: '',
      model: '',
    }),
    apply: (state, event) => {
      switch (event.type) {
        case 'turn/end':
          return {
            ...state,
            turns: state.turns + 1,
            lastTurnEndedAt: event.time,
            lastEndReason: event.data?.reason?.kind ?? '',
          };
        case 'step/end':
          return { ...state, steps: state.steps + 1 };
        case 'compaction/summary': {
          const freed = num(event.data?.shadowedTokenCount) ?? 0;
          return {
            ...state,
            compactions: state.compactions + 1,
            lastFreedTokens: freed,
            lastCompactionAt: event.time,
          };
        }
        case 'compaction/end':
          // 失败的压缩会留下 compaction/end 且带 error；成功的不算失败。
          return event.data?.error === undefined
            ? state
            : { ...state, failedCompactions: state.failedCompactions + 1 };
        case 'request/context':
          return {
            ...state,
            contextWindow: num(event.data?.contextWindow) ?? state.contextWindow,
            provider: typeof event.data?.provider === 'string' ? event.data.provider : state.provider,
            model: typeof event.data?.model === 'string' ? event.data.model : state.model,
          };
        default:
          return state;
      }
    },
    wire: {
      viewSchema: makeViewSchema(),
      view: (state) => ({
        ...state,
        thresholdPercent: Math.round(settings.thresholdRatio * 100),
        handoffAfter: settings.handoffAfterCompactions,
        handoffDue: state.compactions >= settings.handoffAfterCompactions,
        armed,
      }),
    },
  });

  // ── 2. 压缩 / handoff：只在对话自然结束之后 ───────────────────────────

  /**
   * 读 token-meter 的 `contextPressure`。
   *
   * 优先用 `snapshot()`：它返回的是**视图**，而 `pressureTokens` / `projectedTokens` /
   * `contextWindow` 是 view 契约里的字段（`stateOf()` 给的是 fold 的 state，
   * 字段集可能更大或不同）。`stateOf()` 只作兜底。
   */
  function readPressure(session) {
    try {
      const view = ctx.sessionProjections.snapshot(session, ['contextPressure'])?.values?.contextPressure;
      if (view !== undefined) return view;
    } catch {
      /* 落到 stateOf */
    }
    try {
      return ctx.sessionProjections.stateOf(session, 'contextPressure');
    } catch {
      return undefined;
    }
  }

  /**
   * 一个 turn 结束之后：先按阈值压缩（可选），再按「已压缩次数」写 handoff。
   *
   * **两条路是独立的。** 旧实现把 `maybeHandoff()` 放在压缩成功之后，压缩一旦抛错
   * （busy / cancelled / changed / summary / commit / persistence 都算）就被
   * `void error` 吞掉，handoff 永远不写；而面板的 `handoffDue` 只看压缩次数，
   * 于是显示「已写出」但磁盘上没有文件。现在压缩失败只影响压缩，不影响 handoff。
   *
   * 有意**不**在这里 `await agent.whenIdle()`：`agent/created` 的契约明确禁止
   * 监听器 await 它，而 `compactNow()` 自己带 idle admission —— agent 不空闲会抛
   * `ManualCompactionError('busy')`。让 service 当权威，比我们自己判"忙不忙"可靠。
   */
  async function afterTurnEnd(agent, compaction, session, event) {
    const reasonKind = event.data?.reason?.kind;
    if (!cfg.triggerOn.includes(reasonKind)) return;
    if (inFlight.has(session.id)) return;

    // ── 1. 压缩（可选；失败不影响 handoff）────────────────────────────────
    const pressure = readPressure(session);
    const own = ctx.sessionProjections.stateOf(session, 'contextGuard');
    const window = num(pressure?.contextWindow) ?? num(own?.contextWindow);
    const used = num(pressure?.projectedTokens) ?? num(pressure?.pressureTokens);
    const overThreshold =
      window !== undefined && window > 0 && used !== undefined && used / window >= settings.thresholdRatio;

    if (overThreshold && compaction !== undefined) {
      inFlight.add(session.id);
      try {
        await compaction.compactNow(agent, new AbortController().signal);
      } catch (error) {
        // 预期失败，只记一条（以前是 `void error`，导致"没写出来"无从排查）。
        ctx.logger?.debug?.(`context-guard: compaction skipped (${describeError(error)})`);
      } finally {
        inFlight.delete(session.id);
      }
    }

    // ── 2. handoff（独立判定：只看「已压缩次数」）──────────────────────────
    // 结果留着给面板看：{written, file?, reason}。以前算完就丢，于是面板只能
    // 显示"已达阈值"，说不清到底写没写、写到哪、为什么失败。
    const handoff = await maybeHandoff(session);
    lastHandoff = { ...handoff, sessionId: session.id, at: Date.now() };
  }

  /** 本进程内已写出的 handoff：sessionId → 绝对路径（用于判重并回报真实状态）。 */
  const handoffWritten = new Map();

  /**
   * 会话在文件名里的短标识。
   *
   * **不能直接 `session.id.slice(0, 8)`**：真实 id 形如
   * `session-a6796537-a77a-4e58-b081-…`，前 8 位恒为 `"session-"` —— 所有会话会
   * 得到同一个前缀，同目录下的判重就会跨会话互相误判（后开的会话以为"已经写过"，
   * 直接跳过）。这里剥掉 `session-` 前缀并且只保留字母数字。
   */
  function handoffSessionKey(session) {
    const raw = String(session.id ?? '');
    const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
    const compact = bare.replace(/[^a-zA-Z0-9]/g, '');
    return (compact !== '' ? compact : raw.replace(/[^a-zA-Z0-9]/g, '')).slice(0, 8) || 'unknown';
  }

  function handoffPrefix(session) {
    return `${cfg.handoffPrefix}-${handoffSessionKey(session)}-`;
  }

  /**
   * handoff 的落盘目录。
   *
   * 首选会话自己的工作目录（用户能直接找到）；`header.cwd` 缺失时退到 DSH_HOME ——
   * 宁可换个位置，也不要因为拿不到 cwd 就静默不写（旧实现就是这样丢的）。
   */
  function resolveHandoffDir(session) {
    const cwd = session.header?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
    if (process.env.DSH_HOME) return process.env.DSH_HOME;
    if (process.env.HOME) return join(process.env.HOME, 'dsh');
    return undefined;
  }

  /**
   * 目录里已存在的 handoff 文件名（上一次进程写的），没有则 undefined。
   * 用文件系统当权威：进程重启后依然记得这个会话已经写过。
   */
  async function findExistingHandoff(cwd, session) {
    try {
      const prefix = handoffPrefix(session);
      const entries = await readdir(cwd);
      return entries.filter((entry) => entry.startsWith(prefix)).sort().pop();
    } catch {
      // 目录读不到（权限/已删除）时按"没写过"处理。
      return undefined;
    }
  }

  /**
   * 达到配置的压缩次数后写一次 handoff —— 每个会话最多一份。
   *
   * 返回值是**真实结果**而不是"该不该写"：
   *   `{ written: true, file, reason: 'written' | 'existing' | 'cached' }`
   *   `{ written: false, reason: 'below-threshold' | 'disabled' | 'no-cwd' | 'write-failed' | 'error', … }`
   * 面板据此能说清楚"写了没有、写在哪"，而不是只看阈值就宣称「已写出」。
   *
   * 整个函数包一层 try/catch：`buildHandoff()` 会去读 `session.snapshotEvents()`，
   * 任何内部异常都不该变成一个未捕获的 rejection（那样 handoff 又静默丢了）。
   */
  async function maybeHandoff(session) {
    try {
      return await maybeHandoffUnsafe(session);
    } catch (error) {
      const reason = describeError(error);
      ctx.logger?.warn?.(`context-guard: handoff failed (${reason})`);
      return { written: false, reason: 'error', error: reason };
    }
  }

  async function maybeHandoffUnsafe(session) {
    const state = ctx.sessionProjections.stateOf(session, 'contextGuard');
    if (state === undefined) return { written: false, reason: 'no-state' };
    if (state.compactions < settings.handoffAfterCompactions) {
      return { written: false, reason: 'below-threshold', compactions: state.compactions };
    }
    if (!cfg.writeHandoff) return { written: false, reason: 'disabled' };

    const cached = handoffWritten.get(session.id);
    if (cached !== undefined) return { written: true, file: cached, reason: 'cached' };

    const cwd = resolveHandoffDir(session);
    if (cwd === undefined) {
      ctx.logger?.warn?.('context-guard: no session cwd and no DSH_HOME — handoff skipped');
      return { written: false, reason: 'no-cwd' };
    }

    // 上一次进程已经写过：认回来，别写第二份。
    const existing = await findExistingHandoff(cwd, session);
    if (existing !== undefined) {
      const file = join(cwd, existing);
      handoffWritten.set(session.id, file);
      ctx.logger?.info?.(`context-guard: handoff already exists at ${file}`);
      return { written: true, file, reason: 'existing' };
    }

    const file = join(cwd, `${handoffPrefix(session)}c${state.compactions}-${stamp(Date.now())}.md`);
    const body = buildHandoff(session, state, {
      ...cfg,
      thresholdRatio: settings.thresholdRatio,
      handoffAfterCompactions: settings.handoffAfterCompactions,
    });
    try {
      await writeFile(file, body, 'utf8');
    } catch (error) {
      // 以前这里是裸 `await writeFile`，异常被上层的 catch 吞掉 —— 静默丢文件。
      const reason = describeError(error);
      ctx.logger?.warn?.(`context-guard: handoff write FAILED: ${file} — ${reason}`);
      return { written: false, reason: 'write-failed', file, error: reason };
    }
    handoffWritten.set(session.id, file);
    ctx.logger?.info?.(`context-guard: handoff written to ${file}`);
    return { written: true, file, reason: 'written' };
  }

  /**
   * 取这个 agent 的 preset 所挂载的 compaction 实例。
   *
   * **不能用 `agent.ctx.inject(['compaction'], …)`**：preset 的 mount 不在 agent 的
   * fiber 之下（`dsh-agent-preset-registry` 原文："The agent's own key is parented to
   * its preset's standing key, so the mount is not under the agent's fiber"），
   * 被 `isolate` 的服务只在该 realm 内可见，所以从 agent 上下文注入**永远解析不到**。
   *
   * 正确的读地址是注册表的 `serviceFor(agent, name)` —— 它正是为"已经持有 agent 的
   * 调用方"准备的（浏览器 RPC 也走这条路）。
   */
  function resolveCompaction(agent) {
    try {
      return ctx.get('agentPresets')?.serviceFor(agent, 'compaction');
    } catch {
      return undefined;
    }
  }

  /**
   * 把一个 agent 接上：在 agent 作用域上听 `session/event`（scope-filtered，
   * 只收到该 agent 的会话），每次 turn/end 再按需解析 compaction 实例 ——
   * 这样不依赖"挂载已完成"的时序。
   */
  function attach(agent) {
    if (perAgent.has(agent)) return;
    const dispose = agent.ctx.effect(function* () {
      yield agent.ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end') return;
        const compaction = resolveCompaction(agent);
        if (compaction !== undefined) armed = true;
        // 解析不到 compaction 也要继续：压缩是可选步骤，handoff 不依赖它。
        // 必须 .catch：事件监听器的返回值没人 await，漏出去的 rejection 在 Node 里
        // 会变成 unhandledRejection（默认直接终止进程）。
        void afterTurnEnd(agent, compaction, session, event).catch((error) => {
          ctx.logger?.warn?.(`context-guard: turn-end handler failed (${describeError(error)})`);
        });
      });
    }, 'context-guard/agent');
    perAgent.set(agent, dispose);
    // 立刻探一次，让面板上的"已就绪"不必等到下一轮结束才亮。
    if (resolveCompaction(agent) !== undefined) armed = true;
  }

  ctx.effect(function* () {
    // 卸载本插件时必须清掉挂在别的上下文（agent.ctx）上的注册。
    yield () => {
      for (const dispose of perAgent.values()) dispose();
      perAgent.clear();
    };
    // 已经活着的 agent（安装插件时正在跑的会话也算）。
    ctx.inject(['agents'], (acts) => {
      for (const agent of acts.agents.list()) attach(agent);
    });
    // 之后新出现的 agent。
    yield ctx.on('agent/created', ({ agent }) => attach(agent));
    // agent 销毁：连它作用域上的 disposer 一起从表里删掉。少了这一步，
    // 每个创建过的 agent 对象和它的闭包都会被永久保留（长跑进程无界增长）。
    // agent 的 fiber 销毁时这个 effect 已经跑过一遍；cordis 的 disposer 幂等，
    // 所以这里再调一次是安全的。
    yield ctx.on('agent/disposed', ({ agent }) => {
      const dispose = perAgent.get(agent);
      if (dispose === undefined) return;
      perAgent.delete(agent);
      try {
        dispose();
      } catch {
        /* 已经随 agent 的 fiber 一起销毁：忽略 */
      }
    });
  }, 'context-guard lifecycle');

  // ── 3. 面板上的两个可调参数：客户端 → host ────────────────────────────
  //
  // 走 provider-router 验证过的通路：自己注册 webServer 前缀路由，并用
  // `ctx.connection.requestRejection()` 套上 connection 自己的 Host/Origin 围栏与
  // 浏览器鉴权（`ctx.provide` 不会桥接到浏览器，而 `connection.rpc.handle` 从外部
  // 插件不可用 —— 那个 registry 的 getter 捕获的是 connection 自己的 ctx）。
  //
  // 值改了要**真的生效**，否则面板只是装饰；所以写回 settings、落盘，
  // 并让投影的 view 直接读 settings，面板立刻反映权威值。
  ctx.inject(['webServer', 'connection'], (cctx) => {
    const settingsFile = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', 'dsh'), 'context-guard.json');

    // 启动时读回上次在面板上调的值（文件优先于 patch 的 config）。
    void (async () => {
      try {
        const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
        const ratio = clampThresholdRatio(saved?.thresholdRatio);
        const after = clampHandoffCount(saved?.handoffAfterCompactions);
        if (ratio !== undefined) settings.thresholdRatio = ratio;
        if (after !== undefined) settings.handoffAfterCompactions = after;
      } catch {
        /* 没文件或坏文件：用 patch 的 config */
      }
    })();

    // 挂在 effect 上：`webServer.register()` 返回 disposer，不登记的话插件重挂
    // （Plugin Manager 禁用再启用、配置变更 re-apply）会留下旧路由 —— 再注册直接抛
    // `duplicate prefix route`，而真正生效的是旧 handler 的闭包（旧的 settings/cctx），
    // 表现为"面板保存了但行为没变"。
    cctx.effect(() => cctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        let rpcId = 'invalid-request';
        try {
          const rejection = cctx.connection.requestRejection({ headers: req.headers });
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'text/plain' });
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain' });
            res.end('method not allowed');
            return;
          }
          const pathname = new URL(req.url || '/', 'http://localhost').pathname;
          const endpoint = pathname.startsWith(`${ROUTE_PATH}/`) ? pathname.slice(ROUTE_PATH.length + 1) : '';
          const body = await readJsonBody(req);
          if (body && typeof body.rpcId === 'string') rpcId = body.rpcId;
          if (!endpoint || !body || body.type !== 'client-request' || body.method !== endpoint) {
            sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request envelope' } });
            return;
          }
          if (endpoint === 'getSettings') {
            sendRpc(res, rpcId, { ok: true, value: publicSettings() });
            return;
          }
          if (endpoint === 'setSettings') {
            const payload = body.payload ?? {};
            const ratio = clampThresholdRatio(payload.thresholdRatio);
            const after = clampHandoffCount(payload.handoffAfterCompactions);
            if (ratio !== undefined) settings.thresholdRatio = ratio;
            if (after !== undefined) settings.handoffAfterCompactions = after;
            try {
              await writeFile(settingsFile, `${JSON.stringify({ ...settings }, null, 2)}\n`, 'utf8');
            } catch (error) {
              // 落盘失败不影响本次生效；把原因带回面板。
              sendRpc(res, rpcId, { ok: true, value: { ...publicSettings(), saved: false, saveError: String(error?.message ?? error) } });
              return;
            }
            sendRpc(res, rpcId, { ok: true, value: { ...publicSettings(), saved: true } });
            return;
          }
          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/unknown-endpoint', message: endpoint } });
        } catch (error) {
          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/internal', message: String(error?.message ?? error) } });
        }
      },
    }), 'context-guard: route');

    /** 面板读的权威值（含 armed 与最近一次 handoff 的真实结果）。 */
    function publicSettings() {
      return {
        thresholdPercent: Math.round(settings.thresholdRatio * 100),
        handoffAfter: settings.handoffAfterCompactions,
        armed,
        handoff: lastHandoff,
      };
    }
  });
}

export { apply, inject, name };
