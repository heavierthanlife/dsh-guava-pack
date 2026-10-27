/**
 * 「轮末登记 → 空闲执行」调度器（无 Cordis、无 IO，可离线驱动）。
 *
 * ## 为什么单独一层
 *
 * 2026-10-27 的静默失效根因是**时机**：`turn/end` 在 agent 仍处 `running` 时发出，
 * 而 `compactNow()` 要求 idle。修复的关键不变量是：
 *
 *   turn/end 只登记，**绝不**在里面调压缩；
 *   `agent/status: idle` 才是执行点。
 *
 * 这条不变量必须能被测试直接钉住（而不是只靠 grep 源码），所以把调度器抽出来、
 * 让测试用假 agent 驱动它。
 *
 * @module dsh-context-guard/scheduler
 */

/**
 * @param {object} deps
 * @param {(agent: object, compaction: unknown, session: object, event: object) => Promise<void>} deps.afterTurnEnd
 *        真正做事的回调；只在 agent 空闲时被调用。
 * @param {(agent: object) => unknown} deps.resolveCompaction
 *        解析该 agent preset 里的 compaction 服务；可能返回 undefined。
 * @param {(agent: object) => boolean} [deps.isIdle] 默认读 `agent.status === 'idle'`。
 * @param {() => void} [deps.onArmed] 首次解析到 compaction 时回调（面板的能力指示灯）。
 * @param {(error: unknown, job: {session: object, event: object}) => void} [deps.onError]
 *        回调抛错时调用（由调用方决定 warn 还是 debug —— 这里不做 IO）。
 * @returns {object} 调度器
 */
export function createIdleScheduler({
  afterTurnEnd,
  resolveCompaction,
  isIdle = (agent) => agent?.status === 'idle',
  onArmed,
  onError,
}) {
  /** agent → { session, event }：等待空闲的轮末检查。 */
  const pending = new Map();

  /**
   * 尝试执行某个 agent 的挂起检查。
   *
   * 幂等且可重入：没有挂起 / 还在忙 / 已被别的调用取走 → 直接返回。
   *
   * @returns {Promise<boolean>} 是否真的执行了一次检查
   */
  async function run(agent) {
    const job = pending.get(agent);
    if (job === undefined) return false;
    if (!isIdle(agent)) return false;
    pending.delete(agent);

    let compaction;
    try {
      compaction = resolveCompaction(agent);
    } catch {
      compaction = undefined;
    }
    if (compaction !== undefined) onArmed?.();

    try {
      await afterTurnEnd(agent, compaction, job.session, job.event);
      return true;
    } catch (error) {
      onError?.(error, job);
      return false;
    }
  }

  return {
    /** 只读：当前挂起的检查。 */
    pending,
    /** turn/end 时调用：**只登记**，顺手试一次（有的路径此刻已 idle）。 */
    queueTurnEnd(agent, session, event) {
      pending.set(agent, { session, event });
      void run(agent);
    },
    /** agent/status 变化时调用：只有 idle 才是真正的执行时机。 */
    notifyStatus(agent, status) {
      if (status !== 'idle') return;
      void run(agent);
    },
    /** agent 销毁：别让挂起项泄漏。 */
    forget(agent) {
      pending.delete(agent);
    },
    /** 测试/诊断用：等待执行完成。 */
    flush(agent) {
      return run(agent);
    },
    /** 挂起数量（面板显示"等空闲中的检查"）。 */
    size() {
      return pending.size;
    },
  };
}
