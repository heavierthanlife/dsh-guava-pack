/**
 * 压缩触发/可见性的**纯逻辑**（无 Cordis、无 IO、无网络）。
 *
 * 独立成文件的原因：这段判断是上次事故的核心，必须能被自检直接钉住。
 *
 * ## 背景（2026-10-27 定位的事故）
 *
 * 原实现把 `compactNow()` 直接放在 `turn/end` 事件里调用。但 `turn/end` 是在
 * turn runner 的 `finally` 里 append 的，而 agent 的 `phase.kind` 要到返回上一层
 * `kick()` 的 `finally` 才切成 `idle`（`dsh-agent-loop`）。于是：
 *
 *   turn/end 监听器执行时 phase 仍是 running
 *     → compactNow → agent.runMaintenance → 抛 "already has active work"
 *     → ManualCompactionError('busy')
 *     → 原代码只 `logger.debug` 打一行
 *     → 每次轮末都失败、完全静默，压力一路涨到 75%+
 *
 * 所以现在的契约是：**先等到 agent 真正 idle，再尝试压缩**；且每次尝试都要留下
 * 可诊断的结论（`lastAttempt`），不许再静默。
 *
 * @module dsh-context-guard/trigger
 */

/** 一次轮末检查的决策结果。 */
export const ACTION = Object.freeze({
  /** 现在就可以调 compactNow。 */
  ATTEMPT: 'attempt',
  /** 条件已满足，但 agent 还忙 —— 挂起，等下一次 `agent/status: idle`。 */
  WAIT: 'wait',
  /** 不该做（原因见 reason）。 */
  SKIP: 'skip',
});

/** 跳过/等待原因。字符串是稳定的，会被写进 `lastAttempt.reason`，便于排障与测试。 */
export const REASON = Object.freeze({
  /** turn/end 的 reason 不在 config.triggerOn 里（例如 interrupted/error）。 */
  TRIGGER_MISMATCH: 'trigger-mismatch',
  /** 同一会话已有一次压缩在飞。 */
  IN_FLIGHT: 'in-flight',
  /** 拿不到压力或上下文窗口 —— 没有容量信息就不动手（旧逻辑在这一步也是静默的）。 */
  NO_PRESSURE: 'no-pressure',
  /** 未达阈值。 */
  BELOW_THRESHOLD: 'below-threshold',
  /** 没解析到 compaction 服务（preset 未挂载 / serviceFor 失败）。 */
  NOT_ARMED: 'not-armed',
  /** 条件都满足，但 agent 不空闲。 */
  WAIT_IDLE: 'wait-idle',
  /** 到阈值了，开始压缩。 */
  OVER_THRESHOLD: 'over-threshold',
});

/** 压缩调用的结局。 */
export const OUTCOME = Object.freeze({
  OK: 'ok',
  /** compactNow 返回 null：没有可压的安全区间（不是错误，但必须看得见）。 */
  NOTHING_TO_COMPACT: 'nothing-to-compact',
  /** 抛错（busy / summary / commit / persistence / changed…）。 */
  ERROR: 'error',
  /** 没走到压缩（被跳过或等待）。 */
  SKIPPED: 'skipped',
});

/**
 * 决策核心。
 *
 * 顺序是有意的：**先用便宜且确定的条件排除**（trigger / in-flight / 压力缺失 /
 * 未达阈值 / 未就绪），最后才看 idle。这样面板与日志能区分
 * "不需要压"（below-threshold）与 "该压但压不了"（wait-idle / not-armed / error）——
 * 上次事故正是把两者混成了同一种静默。
 *
 * @param {object} input
 * @param {boolean} input.triggerMatched - turn/end 的 reason 是否命中 triggerOn
 * @param {boolean} input.inFlight - 同会话是否已有压缩在飞
 * @param {number|undefined} input.used - 压力（projectedTokens 优先）
 * @param {number|undefined} input.window - 上下文窗口
 * @param {number} input.thresholdRatio - 阈值（0.2–0.95）
 * @param {boolean} input.armed - 是否解析到 compaction 服务
 * @param {string} input.status - agent.status（'idle' | 'running'）
 * @returns {{action: string, reason: string, ratio?: number}}
 */
export function decideAttempt({ triggerMatched, inFlight, used, window, thresholdRatio, armed, status }) {
  if (!triggerMatched) return { action: ACTION.SKIP, reason: REASON.TRIGGER_MISMATCH };
  if (inFlight) return { action: ACTION.SKIP, reason: REASON.IN_FLIGHT };
  if (used === undefined || window === undefined || !(window > 0)) {
    return { action: ACTION.SKIP, reason: REASON.NO_PRESSURE };
  }
  const ratio = used / window;
  if (!(ratio >= thresholdRatio)) return { action: ACTION.SKIP, reason: REASON.BELOW_THRESHOLD, ratio };
  if (!armed) return { action: ACTION.SKIP, reason: REASON.NOT_ARMED, ratio };
  if (status !== 'idle') return { action: ACTION.WAIT, reason: REASON.WAIT_IDLE, ratio };
  return { action: ACTION.ATTEMPT, reason: REASON.OVER_THRESHOLD, ratio };
}

/**
 * 把 `compactNow` 的返回值归类。
 *
 * 它返回 `null` 表示"没有安全可压的区间"—— 既不是成功也不是异常，但必须与
 * 错误分开记录，否则面板只能说"上次压缩失败"，而真实原因是"没什么可压的"。
 */
export function classifyResult(result) {
  return result === null || result === undefined ? OUTCOME.NOTHING_TO_COMPACT : OUTCOME.OK;
}

/**
 * 失败去重键。
 *
 * 为什么要去重：轮末检查可能每几十秒一次，同一个 `busy` 错误会刷满日志。
 * 按「会话 + 结论 + code」去重：同一会话同一种失败只 warn 一次，之后降 debug；
 * 换了错误类型会再 warn 一次（那通常是新信息）。
 */
export function failureKey(sessionId, outcome, error) {
  const code = error?.code ?? 'unknown';
  return `${sessionId ?? '?'}::${outcome}::${code}`;
}

/**
 * 生成一条可读的尝试记录（`lastAttempt`）。
 *
 * 时间戳由调用方给，保证纯函数；`message` 截断，避免把整段堆栈塞进面板。
 */
export function makeAttempt({ at, sessionId, turn, outcome, reason, ratio, detail }) {
  return {
    at,
    sessionId: sessionId ?? '',
    turn: Number.isFinite(turn) ? turn : 0,
    outcome,
    reason: reason ?? '',
    ...(Number.isFinite(ratio) ? { percent: Math.round(ratio * 100) } : {}),
    ...(detail === undefined || detail === '' ? {} : { detail: String(detail).slice(0, 300) }),
  };
}
