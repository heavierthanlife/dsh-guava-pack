/**
 * dsh-context-acp — 系统提示段（C 负责填满）。
 *
 * ## 为什么需要提示段（而不是只靠工具描述）
 *
 * 模型默认会把「context 快满了」交给宿主的自动压缩。ACP 模式要求模型自己判断
 * 何时压、压哪段、摘要必须自己写。这个哲学与操作规则必须进系统提示，否则：
 *   - 模型会等 nudge，nudge 不来就继续堆上下文；
 *   - 模型会把压缩当丢历史 —— 于是不敢压，或者压完不复述关键事实。
 *
 * ## 注入点
 *
 * `ctx.systemPrompt.section({ name, order, text })`（参照 dsh-skill 等内置插件）。
 * 文本必须**稳定**（不随时间/压力变化），否则每次请求都破坏 KV cache 前缀。
 * 动态信息（当前压力、块数）由 nudge 与 acp_status 提供，不进提示段。
 *
 * @module dsh-context-acp/prompt
 */

/** 提示段的 value 形状（与内置 system-prompt section 一致）。 */
export const PROMPT_SECTION = [
  '## 上下文压缩（Context ACP）',
  '',
  '这个会话启用了模型驱动的压缩。宿主**不会**在常规压力下自动压缩；何时压、压哪一段、摘要写什么，由你决定。',
  '',
  '- 压力升高且出现 nudge 时：先用 `acp_status` 看账本，再选一段**已经过时、只靠摘要也能继续工作**的历史，用 `compress` 提交你**亲手写**的 checkpoint 摘要。',
  '- 摘要要对继续工作无损：保留精确文件路径、命令、错误串、标识符、数值、函数签名、用户明确要求。不要写"我们讨论过 X"这种不可执行的话。',
  '- 被压掉的原文可以用 `decompress` 分页取回；`search_context` 可以检索摘要与原文。压错了不是永久丢失。',
  '- 不要压缩策略文件（AGENTS.md 等）的当前副本、`<available_skills>` 目录、当前用户消息所在的区间 —— 工具会拒绝并点名。',
  '- 一次只压一个连续区间；区间两端的工具调用必须成对（不平衡会被拒绝）。',
  '',
  '压缩是为了继续工作，不是为了少看历史：该保留的事实一条都不能丢。',
].join('\n');

/**
 * 安装系统提示段。
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {() => void} disposer
 */
export function installPromptSection(deps) {
  const { ctx } = deps;
  let dispose;
  // systemPrompt 在 headless/preset-free 组合也可能存在；缺失时静默跳过（非致命）。
  const off = ctx.inject(['systemPrompt'], (cctx) => {
    try {
      dispose = cctx.systemPrompt.section({
        name: 'context-acp',
        order: 10,
        text: PROMPT_SECTION,
      });
    } catch (error) {
      deps.logger?.warn?.(`[acp] 系统提示段挂载失败（不影响工具）：${String(error?.message ?? error)}`);
    }
  });
  return () => {
    try {
      dispose?.();
    } catch {
      /* 已随上下文销毁 */
    }
    try {
      off?.dispose?.();
    } catch {
      /* 已随上下文销毁 */
    }
  };
}
