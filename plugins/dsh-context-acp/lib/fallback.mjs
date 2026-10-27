/**
 * dsh-context-acp — 兜底自动压缩的**纯逻辑**。
 *
 * ## 为什么需要它（合并 context-guard 时带来的需求）
 *
 * ACP 的哲学是「常规压力只 nudge，模型决定何时压」。但如果模型就是不响应 nudge
 * （能力弱的模型、被长任务拖住、或用户用了不适合压缩的模型），上下文会一路涨到
 * provider 报错。合并前的 `dsh-context-guard` 在 65% 上无条件自己压 —— 既抢了模型
 * 的决定权，又用引擎 LLM 摘要替代了模型自写摘要。
 *
 * 合并后的策略折中：**先提醒两次，还不理我，才自己动手**。
 * 触发条件（用户 2026-10-27 指定）：
 *   1. 连续 ≥2 次 nudge **未被响应**（期间没有新的压缩事件）；
 *   2. 上下文占用 ≥ 75%。
 * 两个条件同时满足才回落父类的 pressure 压缩（引擎 LLM 摘要）。
 *
 * ## 为什么"数日志"而不是存内存计数
 *
 * nudge 消息本身写在会话日志里（`source.kind === 'context-acp'`，见 nudge.mjs 的
 * 注释：宿主对 pre-step 返回的 message 会 append，只有 runtime-context 会被跳过）。
 * 从日志数：
 *   · 重启/恢复会话后计数不丢；
 *   · 模型一旦真的压过（`compaction/summary`），计数自动归零 —— 不需要额外清理；
 *   · 纯函数，自检可以喂假事件流。
 *
 * @module dsh-context-acp/fallback
 */

/** 默认兜底策略（acp.json 的 `fallback` 段覆盖）。 */
export const DEFAULT_FALLBACK = Object.freeze({
  enabled: true,
  /** 上下文占用达到该比例才考虑（与 nudge.pressureRatio 独立）。 */
  ratio: 0.75,
  /** 连续多少次 nudge 未被响应才动手。 */
  afterUnansweredNudges: 2,
});

/** nudge 消息的 source.kind（与 nudge.mjs 同源；这里只做常量引用，避免循环 import）。 */
export const NUDGE_SOURCE_KIND = 'context-acp';

/**
 * 统计「自上次压缩以来，有多少条 nudge 未被响应」。
 *
 * 规则：遇到 `compaction/summary` 归零；遇到 `source.kind === 'context-acp'`
 * 的 `user/message` 加一。只数 nudge，不数普通用户消息。
 *
 * @param {readonly object[]} events 会话事件（`session.snapshotEvents()`）
 * @returns {number}
 */
export function countUnansweredNudges(events) {
  let count = 0;
  for (const event of events ?? []) {
    if (event?.type === 'compaction/summary') {
      count = 0;
      continue;
    }
    if (event?.type !== 'user/message') continue;
    if (event?.data?.source?.kind === NUDGE_SOURCE_KIND) count++;
  }
  return count;
}

/**
 * 兜底决策（纯函数）。
 *
 * 顺序刻意保守：**先排除不可能**（禁用 / 没有容量信息 / 未达 75%），最后才看 nudge。
 * 这样面板与日志能区分「还不够格」与「够了但模型没理我」。
 *
 * @param {object} input
 * @param {string} [input.reason] 触发来源，仅用于诊断（'pre-step'）
 * @param {number|undefined} input.used 已用 tokens
 * @param {number|undefined} input.window 上下文窗口
 * @param {number} input.unansweredNudges 连续未响应的 nudge 数
 * @param {typeof DEFAULT_FALLBACK} [input.cfg]
 * @returns {{compact: boolean, reason: string, ratio?: number, pending?: number}}
 */
export function decideFallback({ used, window, unansweredNudges, cfg = DEFAULT_FALLBACK }) {
  if (cfg.enabled === false) return { compact: false, reason: 'disabled' };
  if (used === undefined || window === undefined || !(window > 0)) {
    return { compact: false, reason: 'no-pressure' };
  }
  const ratio = used / window;
  if (!(ratio >= cfg.ratio)) return { compact: false, reason: 'below-ratio', ratio };
  const need = Math.max(1, Math.round(cfg.afterUnansweredNudges ?? 2));
  if (unansweredNudges < need) {
    return { compact: false, reason: 'waiting-for-model', ratio, pending: need - unansweredNudges };
  }
  return { compact: true, reason: 'nudge-unanswered', ratio };
}

/**
 * 生成一条可读的兜底记录（面板显示"上次兜底为什么动手/为什么没动手"）。
 *
 * @param {object} input
 * @param {number} input.at
 * @param {string} [input.sessionId]
 * @param {string} input.reason
 * @param {boolean} input.compact 是否真的尝试了压缩
 * @param {number} [input.ratio]
 * @param {string} [input.detail]
 * @returns {object}
 */
export function makeFallbackRecord({ at, sessionId, reason, compact, ratio, detail }) {
  return {
    at,
    sessionId: sessionId ?? '',
    reason,
    attempted: compact === true,
    ...(Number.isFinite(ratio) ? { percent: Math.round(ratio * 100) } : {}),
    ...(detail === undefined || detail === '' ? {} : { detail: String(detail).slice(0, 200) }),
  };
}
