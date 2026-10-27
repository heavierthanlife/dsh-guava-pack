/**
 * dsh-context-acp — 注入行屏障（纯函数，无 IO）。
 *
 * ## 为什么需要它（真实事故，不是理论风险）
 *
 * 历史上有两类问题：
 *   - ACP #71：压缩掉 AGENTS.md 的**当前副本**后，宿主每轮重新注入策略文件 →
 *     压掉 → 重注入 → 再压掉，形成死循环，上下文永远压不下去。
 *   - ACP #185：skill 目录（`<available_skills>`）被压掉后，模型再也看不到可用
 *     skill，且没有任何事件提示"它曾经存在"。
 *
 * 结论：**策略文件 / skill 目录 / 活动用户消息的当前副本**必须拒绝压缩。
 * 被 surface 取代的旧副本（已经被下一次注入顶掉的历史）不在屏障范围内 ——
 * 它们留在日志里由 decompress 找回。
 *
 * ## 为什么判"最新副本"要扫整条 surface，而不是只看区间
 *
 * "当前副本"是 surface 的全局属性：宿主再次注入后，旧副本自动变成可压历史。
 * 如果只扫描待压区间，就会把"区间里那条恰好是旧副本"误判成当前副本，
 * 或者反过来漏掉区间外还有更新副本的事实。所以先做一次尾部→头部的全局扫描，
 * 记住每一类当前副本的 seq，再与区间求交。
 *
 * ## 为什么判不了就拒绝
 *
 * 屏障是安全阀：漏压一段的代价是上下文多占一点；误压当前副本的代价是死循环
 * 或模型能力丢失。因此任何读取/推导异常都按"受保护"处理（fail closed），
 * 宁可让模型换一个区间。
 *
 * @module dsh-context-acp/barriers
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';

/**
 * 屏障判定的稳定错误码（工具层直接透出给模型）。
 * @readonly
 * @enum {string}
 */
export const PROTECTED_CODES = Object.freeze({
  /** 当前活动用户消息（最后一条真实用户输入）。 */
  ACTIVE_USER: 'protected-active-user',
  /** AGENTS.md / 策略文件的当前副本。 */
  AGENTS_COPY: 'protected-agent-instructions',
  /** `<available_skills>` 最新目录所在消息。 */
  SKILL_CATALOG: 'protected-skill-catalog',
  /** surface 第 0 个节点上的 system prompt（压缩它会直接改变模型身份）。 */
  SYSTEM_PROMPT: 'protected-system-prompt',
  /** 区间/消息无法判定时为安全起见一律拒绝（fail closed）。 */
  UNREADABLE: 'protected-unreadable',
});

/** 宿主 skill 目录注入的文本标记（较新版本用"replaces every earlier list"措辞）。 */
const SKILL_CATALOG_MARKER = '<available_skills>';

/** 保护开关缺省视为开启：只有显式 `false` 才关闭。 */
function enabled(value) {
  return value !== false;
}

/**
 * 把一个消息的 text block 拼成文本。
 *
 * 只在需要文本标记判定时调用（策略/skill 消息通常很短），不对整段历史做
 * 无谓的字符串拼接。
 *
 * @param {{ content?: unknown }} message
 * @returns {string}
 */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 从 surface 尾部向前找每一类"当前副本"的 seq。
 *
 * 尾部扫描可以在三类都找到后立刻停止；真实会话里活动用户消息几乎总在尾部，
 * 策略/skill 目录在头部，所以最坏情况扫完整条 surface，但不会重复推导消息。
 *
 * 为什么跳过 checkpoint：一个压缩摘要可能**引用** `<available_skills>` 文本，
 * 它既不是 skill 目录本身，也不该因为"摘要里提过"就永远不能再压缩（tier 2）。
 *
 * @param {object} session
 * @param {number[]} nodes `session.surface.nodes`
 * @param {object} policy 保护策略
 * @returns {{ userSeq?: number, instructionsSeq?: number, skillSeq?: number }}
 */
function latestCopies(session, nodes, policy) {
  const wantUser = enabled(policy?.protectActiveUserMessage);
  const wantInstructions = enabled(policy?.protectAgentInstructions);
  const wantSkill = enabled(policy?.protectSkillCatalog);
  const found = {};
  if (!wantUser && !wantInstructions && !wantSkill) return found;

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (
      (!wantUser || found.userSeq !== undefined) &&
      (!wantInstructions || found.instructionsSeq !== undefined) &&
      (!wantSkill || found.skillSeq !== undefined)
    ) {
      break;
    }
    const seq = nodes[index];
    const event = session.eventAt(seq);
    // 屏障只关心消息行；tool/result、turn 边界等不承载注入语义。
    if (event?.type !== 'user/message') continue;
    const message = session.deriveEventMessage(event);
    const source = message?.source;
    if (source !== null && typeof source === 'object' && isCompactCheckpointSource(source)) continue;
    const kind = typeof source?.kind === 'string' ? source.kind : undefined;

    if (wantUser && found.userSeq === undefined && (kind === 'user' || kind === undefined)) {
      found.userSeq = seq;
    }
    if (wantInstructions && found.instructionsSeq === undefined && kind === 'agent-instructions') {
      found.instructionsSeq = seq;
    }
    if (wantSkill && found.skillSeq === undefined) {
      // 新版注入可能换 source kind，因此文本标记是契约的一部分而非兜底。
      if (kind === 'skill-catalog' || textOf(message).includes(SKILL_CATALOG_MARKER)) found.skillSeq = seq;
    }
  }
  return found;
}

/** 构造一条"不可判定"的保护命中（fail closed 的唯一出口）。 */
function unreadable(seq, error) {
  const detail = error === undefined ? '' : `：${String(error?.message ?? error)}`;
  return {
    ok: false,
    protected: [{
      seq: Number.isInteger(seq) ? seq : -1,
      code: PROTECTED_CODES.UNREADABLE,
      label: `区间无法判定${detail}`,
    }],
  };
}

/**
 * 判断一个 surface 区间是否触到受保护区。
 *
 * @param {object} params
 * @param {import('@deepseek-ai/dsh-session').Session} params.session 目标会话
 * @param {number} params.startIdx 区间在 `session.surface.nodes` 中的起始下标（含）
 * @param {number} params.endIdx 区间结束下标（含）
 * @param {object} params.policy 生效的保护策略（来自 runtime.retain）
 * @returns {{ ok: boolean, protected: Array<{ seq: number, code: string, label: string }> }}
 *   `ok: true` 表示区间可压缩；否则每个命中的节点各一条，用于错误消息点名。
 */
export function checkProtectedRange({ session, startIdx, endIdx, policy } = {}) {
  try {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes)) return unreadable(startIdx, new Error('会话 surface 不可用'));
    // 越界/反序不是"可压"，而是输入已不可信：交给工具报 missing 更合适，
    // 但屏障自身必须给 fail-closed 的答案（ok=false），不能默认放行。
    if (
      !Number.isInteger(startIdx) ||
      !Number.isInteger(endIdx) ||
      startIdx < 0 ||
      endIdx < startIdx ||
      endIdx >= nodes.length
    ) {
      return unreadable(startIdx, new Error(`区间 [${String(startIdx)}, ${String(endIdx)}] 不在 surface 范围内`));
    }

    const hits = [];

    // system 恒保护：它不在三类注入行里，但压缩它等于改写模型身份。
    if (startIdx === 0) {
      const head = session.eventAt(nodes[0]);
      if (head?.type === 'system/message') {
        hits.push({
          seq: nodes[0],
          code: PROTECTED_CODES.SYSTEM_PROMPT,
          label: '系统提示（system prompt，surface 第 0 个节点）',
        });
      }
    }

    const latest = latestCopies(session, nodes, policy);

    for (let index = startIdx; index <= endIdx; index += 1) {
      const seq = nodes[index];
      const event = session.eventAt(seq);
      // 只处理 user/message：其它行不承载策略/skill/用户输入语义。
      if (event?.type !== 'user/message') continue;
      const message = session.deriveEventMessage(event);
      const source = message?.source;
      if (source !== null && typeof source === 'object' && isCompactCheckpointSource(source)) continue;
      const kind = typeof source?.kind === 'string' ? source.kind : undefined;

      if (enabled(policy?.protectActiveUserMessage) && seq === latest.userSeq) {
        hits.push({
          seq,
          code: PROTECTED_CODES.ACTIVE_USER,
          label: '活动用户消息（当前轮用户输入；历史用户消息可压）',
        });
        continue;
      }
      if (enabled(policy?.protectAgentInstructions) && seq === latest.instructionsSeq) {
        hits.push({
          seq,
          code: PROTECTED_CODES.AGENTS_COPY,
          label: 'AGENTS.md/策略文件当前副本（旧副本可压）',
        });
        continue;
      }
      if (enabled(policy?.protectSkillCatalog) && seq === latest.skillSeq) {
        hits.push({
          seq,
          code: PROTECTED_CODES.SKILL_CATALOG,
          label: 'available_skills 目录当前副本（旧副本可压）',
        });
      }
    }

    return { ok: hits.length === 0, protected: hits };
  } catch (error) {
    return unreadable(startIdx, error);
  }
}
