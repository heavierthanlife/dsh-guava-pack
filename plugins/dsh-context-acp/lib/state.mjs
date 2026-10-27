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
    /** 本 agent 的压缩引擎解析到了吗（armed 能力灯）。 */
    armed: false,
  };
}

/** agent -> state */
const states = new WeakMap();

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

/** 记录一次 nudge（C 调用）。 */
export function recordNudge(agent, { usedTokens, contextWindow, step, reason }) {
  const state = stateOf(agent);
  state.lastNudge = { at: Date.now(), usedTokens, contextWindow, reason: reason ?? 'pressure' };
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
