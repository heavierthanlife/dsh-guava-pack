/**
 * dsh-context-acp — 进程内共享状态（Lead 独占文件，B/C 只读调用，不修改）。
 *
 * ## 为什么需要它
 *
 * 三个模块要看到同一份「每 agent 的运行态」，但它们有不同的 owner：
 *   - `nudge.mjs`（C）在 pre-step 里写：最近一次 nudge 的时间/token/原因；
 *   - `tools-status.mjs`（B）在 acp_status 里读：面板与模型都要看到最近 nudge；
 *   - `settings.mjs`（C）在 getSettings 里读：面板 pill 的 `lastNudge`/`armed`。
 * 如果没有这层，B 就要 import C 的文件（所有权交叉，任一阶段都会互相踩）。
 *
 * ## 生命周期
 *
 * 全部 `WeakMap<Agent, state>`：agent 销毁后自动回收，长跑进程不无界增长。
 * 不做持久化：**账本与压缩事实一律从 session 日志重建**（ledger），
 * 这里只放「日志里没有、也不该进日志」的瞬时状态。
 *
 * @module dsh-context-acp/state
 */

/** 每 agent 的瞬时状态形状（默认值）。 */
function emptyState() {
  return {
    /** 最近一次 nudge：`{ at, usedTokens, contextWindow, reason }`，没发过就是 null。 */
    lastNudge: null,
    /** 本 turn 已 nudge 次数（turn/start 时清零）。 */
    turnNudges: 0,
    /** 上次 nudge 时的 step 号（冷却判定）。 */
    lastNudgeStep: -1,
    /** 上次 nudge 时的估算 token（增长判定）。 */
    lastNudgeTokens: 0,
    /** 最近一次 nudge 被跳过的原因（诊断用）。 */
    lastSkipReason: null,
    /** 引擎/工具层最近一次错误（面板「失败可见」）。 */
    lastError: null,
    /** 最近一次兜底尝试：`{ at, attempted, reason, percent, detail }`（面板可见）。 */
    lastFallback: null,
    /** 上次尝试兜底的 step 号（节流，避免每个 step 都试）。 */
    lastFallbackStep: -1,
    /** 本 agent 的压缩引擎解析到了吗（armed 能力灯）。 */
    armed: false,
  };
}

/** agent -> state */
const states = new WeakMap();

/**
 * 进程内最近一次 nudge（跨 agent 的单一读数）。
 *
 * 状态：**仅为向后兼容保留**。面板与横幅现在都带 sessionId 走
 * {@link nudgeForSession}。「跨会话共享一条读数」正是横幅到处乱弹的根因，
 * 新代码不要再读它；只有不带 sessionId 的旧客户端才会拿到这里的值。
 * WeakMap 不能遍历，所以另存一份标量读数 —— 不是账本，账本永远从 session 日志重建。
 */
let latestNudge = null;

/** 进程内最近一次兜底尝试（同 latestNudge 的理由：面板路由没有 sessionId）。 */
let latestFallback = null;

/**
 * **每会话**最近一次 nudge：`sessionId -> { at, usedTokens, contextWindow, reason }`。
 *
 * 为什么需要它（2026-11-06 实测 bug）：横幅以前只读进程级 `latestNudge`，于是
 * 任何会话只要进程里发生过一次 nudge（15 分钟内）就全都在输入框上方报警 ——
 * 用户看到「离 55% 还很远的对话」也在显示 nudge。横幅必须按会话区分。
 *
 * 会话 id 取自 `agent.session.id`（nudge 侧的 agent 一定有 session；测试里的
 * 假 agent 用 `agent.id`）。用普通 Map 而不是 WeakMap：http 路由只有 sessionId
 * 字符串，没有 agent/state 引用。上限 256 条，按插入序淘汰最久未 nudge 的会话
 * （更新时先 delete 再 set，保证"最近写过"排在最后）；长跑进程不无界增长。
 */
const nudgesBySession = new Map();
const MAX_SESSION_NUDGES = 256;

/** 从 agent 取会话 id（取不到就 null：不猜、不伪造）。 */
function sessionIdOf(agent) {
  try {
    const raw = agent?.session?.id ?? agent?.id;
    return typeof raw === 'string' && raw !== '' ? raw : null;
  } catch {
    return null;
  }
}

/** 取（必要时创建）一个 agent 的状态对象。调用方拿到的是**活引用**，可直接改字段。 */
export function stateOf(agent) {
  if (agent === null || typeof agent !== 'object') return emptyState();
  let state = states.get(agent);
  if (state === undefined) {
    state = emptyState();
    states.set(agent, state);
  }
  return state;
}

/** 只读快照（给 acp_status / 面板用；避免调用方持有活引用）。 */
export function snapshot(agent) {
  return { ...stateOf(agent) };
}

/** 读进程内最近一次 nudge（旧客户端/无 sessionId 的调用方；没有则 null，绝不伪造时间）。 */
export function latestNudgeOf() {
  return latestNudge === null ? null : { ...latestNudge };
}

/**
 * 读**某个会话**最近一次 nudge（横幅与面板的权威读数；该会话没被 nudge 过就 null）。
 *
 * @param {string} sessionId 会话 id（空/非字符串一律 null）
 * @returns {{at:number,usedTokens:number,contextWindow:number,reason:string} | null}
 */
export function nudgeForSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const found = nudgesBySession.get(sessionId);
  return found === undefined ? null : { ...found };
}

/** 记录一次 nudge（C 调用）：同时写 per-agent state、进程级读数、per-session 读数。 */
export function recordNudge(agent, { usedTokens, contextWindow, step, reason }) {
  const state = stateOf(agent);
  state.lastNudge = { at: Date.now(), usedTokens, contextWindow, reason: reason ?? 'pressure' };
  latestNudge = { ...state.lastNudge };
  const sessionId = sessionIdOf(agent);
  if (sessionId !== null) {
    // 先删再插：Map 保持插入序，淘汰时最久没 nudge 的会话先出。
    nudgesBySession.delete(sessionId);
    nudgesBySession.set(sessionId, { ...state.lastNudge });
    while (nudgesBySession.size > MAX_SESSION_NUDGES) {
      const oldest = nudgesBySession.keys().next();
      if (oldest.done !== false) break;
      nudgesBySession.delete(oldest.value);
    }
  }
  state.lastNudgeStep = typeof step === 'number' ? step : state.lastNudgeStep;
  state.lastNudgeTokens = typeof usedTokens === 'number' ? usedTokens : state.lastNudgeTokens;
  state.turnNudges += 1;
  state.lastSkipReason = null;
}

/** 记录一次「本可 nudge 但被跳过」（C 调用，暴露给面板）。 */
export function recordSkip(agent, reason) {
  stateOf(agent).lastSkipReason = reason;
}

/** turn 边界：清零本 turn 的 nudge 计数（C 在 turn/start 或 turn/end 调用）。 */
export function resetTurn(agent) {
  const state = stateOf(agent);
  state.turnNudges = 0;
}

/** 记录一次兜底尝试（nudge 模块调用；面板据此说清"兜底为什么动手/没动手"）。 */
export function recordFallback(agent, record) {
  const state = stateOf(agent);
  state.lastFallback = record ?? null;
  if (typeof record?.step === 'number') state.lastFallbackStep = record.step;
  latestFallback = record === null || record === undefined ? null : { ...record };
}

/** 读进程内最近一次兜底（面板路由用；没有则 null，绝不伪造）。 */
export function latestFallbackOf() {
  return latestFallback === null ? null : { ...latestFallback };
}

/** 最近一次兜底尝试（只读快照）。 */
export function lastFallbackOf(agent) {
  const value = stateOf(agent).lastFallback;
  return value === null || value === undefined ? null : { ...value };
}

/** 记录错误（任何模块都可以调；面板据此显示「失败必须可见」）。 */
export function recordError(agent, error) {
  const state = stateOf(agent);
  state.lastError = {
    at: Date.now(),
    code: typeof error?.code === 'string' ? error.code : null,
    message: String(error?.message ?? error),
  };
}

/** 标记该 agent 的引擎是否解析到（能力灯，不猜）。 */
export function markArmed(agent, armed) {
  stateOf(agent).armed = armed === true;
}
