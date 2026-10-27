/**
 * dsh-context-acp — 压缩引擎（preset realm 内挂载，替换 `compaction-basic`）。
 *
 * ## 为什么是「子类 + 三个覆写点」而不是重写
 *
 * surface 替换事务、`compaction/start|summary|end` 记账、幂等、持久化锁，全在
 * `BasicCompactionEngine.compactRegion()` 里。重写它等于重写 DSH 最危险的一段代码。
 * 官方 d.ts 也写死了扩展点：**`summarize()` is the sole subclass customization hook**。
 * 所以这里只做三件事：
 *
 *   1. `summarize()`：优先取 compress 工具投递的模型自写摘要（零额外 LLM 调用）；
 *      取不到才回落 `super.summarize()`（自动/手动压缩仍可工作）。
 *   2. `compactIfNeeded()`：常规压力返回 `null` —— **不自动压**，只让 nudge 提醒模型；
 *      `context-overflow` 仍然走父类抢救（溢出是硬失败，必须保留兜底）。
 *      另有一个 `compactByFallback()`：连续多次 nudge 未被响应、且占用超阈值时，
 *      由根插件主动调用一次父类 pressure 压缩（"先提醒，再兜底"）。
 *   3. `compactRegion()` 全盘继承：模型指定区间的压缩由工具调用。
 *
 * ## 待用摘要通道（并发安全）
 *
 * `compress` 工具在 `compactRegion()` 之前把摘要投递到**本引擎实例**的
 * `WeakMap<Agent, PendingSummary>`；`summarize()` 按 agent 取走。
 * - 用实例字段而不是模块级变量：preset realm 的引擎实例与 agent 一一对应，
 *   多会话/并发子代理天然隔离。
 * - 用 WeakMap 而不是 Map：agent 销毁后槽位自动回收，长跑进程不会无界增长。
 *
 * ## backend 切换（回滚）
 *
 * 引擎行配置 `{ backend: 'acp' | 'basic' }`。`basic` 时挂载的是**上游
 * `BasicCompactionEngine` 类本身**（不是本类的分支），回滚后的行为与内置完全一致。
 *
 * @module dsh-context-acp/engine
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

/** 允许的 backend 值（写错就直接抛，不做「猜」。） */
const BACKENDS = new Set(['acp', 'basic']);

/** 未标注来源时的摘要 provider/model 兜底（`compaction/summary` 契约要求非空字符串）。 */
const UNKNOWN_ROUTE = 'acp';

/**
 * 待用摘要槽的实例字段键。
 *
 * 为什么不用 `#staged` 私有字段：Cordis 会把 service 包进 traceable Proxy 再交给
 * 调用方（`ctx.compaction` / `agentPresets.serviceFor()`），Proxy 调用方法时
 * `this` 是包装对象而不是声明类，读取 `#` 私有字段会抛
 * "Cannot read private member ... from an object whose class did not declare it"。
 * 用模块私有 Symbol 既保留「外部拿不到、只能走 stageSummary/takeStagedSummary」
 * 的封装，又能安全穿过 Proxy（Symbol 读取不看 receiver）。
 */
const STAGED = Symbol('dsh-context-acp.staged');

/**
 * 模型驱动的压缩引擎。
 *
 * 只覆写 `summarize` / `compactIfNeeded` 两个钩子；区间校验、事务、记账、
 * 幂等全部继承父类。
 *
 * 为什么这里**不**读写 `ctx.tokenMeter`：surface 替换、摘要收敛判定、
 * `compaction/summary.shadowedTokenCount` 必须由父类事务用唯一 meter 统一记账，
 * 子类再算一次只会产生两套互相矛盾的数（ACP #54/#103）。同理，这里也不
 * catch/吞掉父类异常——失败必须让调用方（工具或自动压缩）看见。
 */
export class AcpEngine extends BasicCompactionEngine {
  /**
   * 本引擎实例的「待用摘要」槽：`Agent -> { summary, provider, model }`。
   * 按 agent 隔离，`summarize()` 取走即删。键是模块私有 Symbol（不是 `#` 字段，
   * 原因见文件上方 `STAGED` 注释）：外部只能通过 `stageSummary/takeStagedSummary`
   * 操作，避免工具直接写坏通道。
   */
  [STAGED] = new WeakMap();

  /** 生效的 backend（`acp` 或 `basic`）。子类分支用，父类看不懂这个字段。 */
  backend;

  /**
   * 关闭 Cordis 的继承式 Config 校验。
   *
   * 为什么必须显式置 null：`BasicCompactionEngine` 的 `static Config` 是 Schemastery
   * 对象，静态字段会**被继承**；而本行配置多了 `backend` / `basic` 两个键，
   * 用父类 schema 校验会直接拒绝。这里关掉校验后，`backend` 由本类自己判，
   * `basic` 之外的键再交给父类构造器里的 `resolveConfig()`（它自己会做严格的
   * unknown-key 检查），所以并没有绕过任何校验。
   */
  static Config = null;

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ backend?: 'acp'|'basic', basic?: object, [key: string]: unknown }} config
   *   引擎行配置。`backend` 之外、`basic` 之外的键按 compaction-basic 的配置透传
   *   （thresholdRatio/retainRatio/...），这样高级用户仍能调基础策略。
   */
  constructor(ctx, config = {}) {
    const { backend = 'acp', basic, ...passthrough } = config ?? {};
    if (!BACKENDS.has(backend)) {
      throw new Error(`dsh-context-acp: unknown engine backend ${JSON.stringify(backend)}; expected 'acp' or 'basic'`);
    }
    // 父类构造会 resolveConfig 校验并注册事件监听；backend 必须先摘掉，
    // 否则 resolveConfig 的 unknown-key 检查会拒绝它。
    super(ctx, { ...passthrough, ...(basic ?? {}) });
    this.backend = backend;
    this.ctx.logger?.info?.(`[acp] AcpEngine mounted (backend=${backend}, fallbackToLlmSummary=${this.backend === 'acp'})`);
  }

  /**
   * 投递一份模型自写摘要，供**紧接着的** `compactRegion()` 在 `summarize()` 中取走。
   *
   * 契约：
   * - 必须在 `compactRegion()` 之前同步调用；压缩事务失败时工具负责 `clearStagedSummary()`。
   * - `summary` 是模型写的 markdown 文本；`provider`/`model` 写进 `compaction/summary`
   *   事件，用于「这份摘要是谁写的」的可追溯性（ACP 的账本要求）。
   * - **幂等覆盖**：同一 agent 已有未消费的摘要时不抛错，直接覆盖。工具层已经用
   *   `inFlight` 串行化，但清理/投递之间仍可能隔着一次失败的事务；覆盖保证「最后一次
   *   投递生效」，也避免把一次可恢复的时序问题升级成工具异常。
   *
   * @param {object} agent 目标 agent（`WeakMap` 的键，取自工具 `exec.agent`）
   * @param {{ summary: string, provider?: string, model?: string }} pending
   */
  stageSummary(agent, pending) {
    if (agent === null || typeof agent !== 'object') throw new TypeError('dsh-context-acp: stageSummary requires an agent');
    const summary = typeof pending?.summary === 'string' ? pending.summary : '';
    if (summary.trim().length === 0) throw new TypeError('dsh-context-acp: stageSummary requires a non-empty summary');
    // 覆盖旧槽：见上「幂等覆盖」。
    this[STAGED].set(agent, {
      summary,
      provider: typeof pending?.provider === 'string' && pending.provider.length > 0 ? pending.provider : UNKNOWN_ROUTE,
      model: typeof pending?.model === 'string' && pending.model.length > 0 ? pending.model : UNKNOWN_ROUTE,
    });
  }

  /**
   * 取走待用摘要（有副作用：取走即删，保证一次投递只被消费一次）。
   * @param {object} agent
   * @returns {{ summary: string, provider: string, model: string } | undefined}
   */
  takeStagedSummary(agent) {
    const staged = this[STAGED].get(agent);
    this[STAGED].delete(agent);
    return staged;
  }

  /** 丢弃待用摘要（压缩事务在 `summarize()` 之前就失败时调用，避免串到下一次压缩）。 */
  clearStagedSummary(agent) {
    this[STAGED].delete(agent);
  }

  /**
   * `summarize()` —— 官方唯一扩展点。
   *
   * 有模型投递的摘要 → 直接返回它（**零 LLM 调用**，`llmStreamCall` 不设）；
   * 否则回落父类的 LLM 摘要（自动压缩 / overflow 抢救 / 手动 `/compact` 仍可用）。
   *
   * @param {{ messages: readonly object[], tools?: readonly object[] }} input
   * @param {object} agent
   * @param {AbortSignal=} signal
   * @returns {Promise<object>} `SummaryResult`（不带 `llmStreamCall` 的自写摘要）
   */
  async summarize(input, agent, signal) {
    const staged = this.takeStagedSummary(agent);
    if (staged !== undefined) {
      // 自写摘要：一个 text block；不设 llmStreamCall（契约：未标记 = 没走 ctx.llm.stream）。
      return {
        summary: [{ type: 'text', text: staged.summary }],
        provider: staged.provider,
        model: staged.model,
      };
    }
    // 取不到投递：说明这次压缩不是模型显式发起的（overflow 抢救 / /compact / 自动）。
    // 这里**总是**回落父类的 LLM 摘要：没有投递却硬拒绝，等于把内置的 overflow
    // 抢救和 /compact 一并废掉；而「压不成」比「多一次 LLM 调用」更糟。
    // 「零额外调用」的保证只覆盖模型显式发起的 compress 路径（那里一定有投递）。
    return super.summarize(input, agent, signal);
  }

  /**
   * 自动压缩策略覆写：常规压力**只 nudge、不自动压**；上下文溢出保留父类抢救。
   *
   * 为什么 overflow 必须保留：provider 已确认超窗时，这一轮请求已经失败，
   * 不压缩就再也发不出去。这是内置能力的硬兜底，删掉等于降级。
   *
   * @param {object} agent
   * @param {'pressure'|'context-overflow'} trigger
   * @param {AbortSignal} signal
   * @returns {Promise<object|null>} 自动压缩结果或 null
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (this.backend === 'acp' && trigger === 'pressure') {
      // 常规压力：不动手。模型通过 nudge + compress 工具自己决定。
      return null;
    }
    return super.compactIfNeeded(agent, trigger, signal);
  }

  /**
   * 兜底自动压缩：**连续 N 次 nudge 未被响应且占用 ≥ 阈值**时由根插件调用。
   *
   * 与 `compactIfNeeded` 的区别：那个是宿主在每步自动问"你要不要压"（ACP 回答
   * "不要"）；这个是 ACP 自己判断"模型就是不响应"，主动要求父类按 pressure 策略压一次。
   *
   * 仍然走父类路径的好处：
   *   · 区间选择（tool-pair 平衡、retainTail）与记账全部由唯一 token meter 完成；
   *   · 摘要由 `summarize()` 产出 → 没有 staged 摘要时回落 LLM 摘要（这正是兜底该用的）；
   *   · 失败照常抛 `ManualCompactionError`，由调用方记录，不静默。
   *
   * 阈值来自本行配置 `basic.thresholdRatio`（生成器从 acp.json 的
   * `fallback.ratio` 写入），所以"何时算够高"与面板上的兜底阈值是同一个数。
   *
   * @param {object} agent
   * @param {AbortSignal} signal
   * @returns {Promise<object|null>}
   */
  async compactByFallback(agent, signal) {
    if (this.backend !== 'acp') return null;
    return super.compactIfNeeded(agent, 'pressure', signal);
  }
}

/**
 * Cordis 插件入口（引擎行的 `name` 指向本模块默认导出）。
 *
 * 为什么用函数插件包一层而不是直接 `export default AcpEngine`：
 * - `basic` 回滚时挂载的是**上游类本身**，本文件的任何分支都不在压缩路径上；
 * - 引擎行配置形状固定为 `{ backend, basic? }`，生成器只需知道一个行名。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ backend?: 'acp'|'basic', basic?: object }} [config]
 */
export function apply(ctx, config = {}) {
  const backend = config?.backend === 'basic' ? 'basic' : 'acp';
  if (backend === 'basic') {
    // 回滚：挂**上游类本身**，且只喂它认识的键。`backend`/`basic` 两个键是
    // 本插件的行形状，直接透传会被 compaction-basic 的 unknown-key 校验拒绝。
    const { backend: _backend, basic, ...passthrough } = config ?? {};
    void _backend;
    ctx.plugin(BasicCompactionEngine, { ...passthrough, ...(basic ?? {}) });
  } else {
    // 子插件：`ctx.plugin` 的 fiber 落在 preset 的 mount fiber 之下，
    // 所以 `ctx.compaction` 仍然只在该 realm 内可见（serviceFor 能取到）。
    ctx.plugin(AcpEngine, config);
  }
  ctx.logger?.info?.(`[acp] compaction backend = ${backend}`);
}

