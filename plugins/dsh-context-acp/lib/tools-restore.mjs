/**
 * dsh-context-acp — `decompress` + `search_context` 工具（B 负责）。
 *
 * ## 契约（不许改形状）
 *
 * decompress：
 *   入参 { block?: 'b3', compactionId?: string, offset?: number, limit?: number }
 *   出参 { ok: true, blocks: [{ seq, role, text }], next?: number, total }
 *   失败 { ok: false, code: 'missing'|'bad-request', message }
 *
 * search_context：
 *   入参 { query: string, scope?: 'all'|'summaries'|'originals', limit?: number }
 *   出参 { ok: true, hits: [{ block: 'b3'|null, seq, score, excerpt }], total }
 *
 * ## 只读日志
 *
 * 原文用 `session.snapshotEvents()` + `session.eventAt(seq)` + `deriveEventMessage()`
 * 还原；**不得**改 surface，也不得触发任何 LLM 调用。块编号/tier 一律来自
 * ledger（日志重建），本文件不维护任何跨调用缓存。
 *
 * ## 检索打分（零依赖）
 *
 * 中文用 bigram，拉丁词按连续 `[a-z0-9_]` 切分；对每个候选文本统计 token
 * 出现次数，长度 > 1 的 token 权重 2、单字符权重 1；query 原文整串出现再加 3。
 * 不引第三方包（pack 只允许 zod/undici）。
 *
 * @module dsh-context-acp/tools-restore
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { buildLedger, eventRole, eventText } from './ledger.mjs';

/** decompress 的默认页大小（runtime 缺配置时的兜底）。 */
const DEFAULT_PAGE_SIZE = 8;
/** search_context 的默认返回条数。 */
const DEFAULT_SEARCH_LIMIT = 20;
/** 默认 excerpt 总长度（前后各一半）。 */
const DEFAULT_EXCERPT_CHARS = 240;

/** 取一条事件；eventAt 在旧会话/畸形日志上可能抛错，检索不能因此中断。 */
function eventAt(session, seq) {
  try {
    return session?.eventAt?.(seq);
  } catch {
    return undefined;
  }
}

/** 从 runtime 配置里取一个正整数；非法值用兜底。 */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 读取 runtime.retain 的一个数值配置。
 * @param {object | undefined} deps
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function retainNumber(deps, key, fallback) {
  const value = deps?.runtime?.retain?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 统一失败对象（错误码是稳定契约，message 只用于可读诊断）。 */
function failure(code, message) {
  return { ok: false, code, message };
}

/** 把 query 切成检索 token（Set 去重，避免重复词重复加权）。 */
function tokenize(query) {
  const lower = query.toLowerCase();
  const tokens = new Set();

  // 拉丁/数字/下划线：`ORCHID-11` → orchid + 11；`search_context` 保留为一个词。
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) tokens.add(match[0]);

  // CJK：连续汉字串取 bigram。单字串没有 bigram，只能靠整串 +3 命中，
  // 这是契约规定的分词方式（不做词典、不做单字扩张）。
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0];
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }

  return [...tokens];
}

/** 统计 needle 在 haystack 中出现的次数（不重叠；空针返回 0）。 */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    from = index + needle.length;
  }
}

/**
 * 给一个候选文本打分并生成 excerpt。
 *
 * @param {string} text 候选原文
 * @param {string[]} tokens 已小写、已去重的 query token
 * @param {string} needle 已去空白、已小写的 query 原文
 * @param {number} excerptChars excerpt 总长度
 * @returns {{ score: number, excerpt: string } | null} score=0 时返回 null
 */
function scoreText(text, tokens, needle, excerptChars) {
  const lower = text.toLowerCase();
  let score = 0;
  let bestToken = '';
  let bestContribution = 0;

  for (const token of tokens) {
    const count = countOccurrences(lower, token);
    if (count === 0) continue;
    const contribution = count * (token.length > 1 ? 2 : 1);
    score += contribution;
    // 最高分 token 用来定位 excerpt；同分保留先出现的 token（token 顺序来自 query）。
    if (contribution > bestContribution) {
      bestContribution = contribution;
      bestToken = token;
    }
  }

  if (needle.length > 0 && lower.includes(needle)) score += 3;
  if (score === 0) return null;

  // excerpt 锚点：最高分 token 首次出现处；整串命中但没有 token 时退回整串。
  let anchor = bestToken.length > 0 ? lower.indexOf(bestToken) : -1;
  if (anchor < 0) anchor = lower.indexOf(needle);
  if (anchor < 0) anchor = 0;

  const half = Math.floor(excerptChars / 2);
  const start = Math.max(0, anchor - half);
  const end = Math.min(text.length, anchor + Math.max(bestToken.length, 1) + half);
  // 契约要求「两端加 …」：excerpt 是片段视图，即使整段被窗口完整覆盖也保留标记，
  // 让模型明确这是检索摘要而不是原文全文。
  const excerpt = `…${text.slice(start, end)}…`;

  return { score, excerpt };
}

/**
 * 注册 `decompress` 与 `search_context` 两个工具。
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {() => void} disposer
 */
export function registerRestoreTools(deps) {
  const { ctx } = deps;

  const disposeDecompress = ctx.tools.register(defineTool({
    name: 'decompress',
    description:
      '分页取回被 compress 压掉的原始对话内容。不传参数时列出全部块；传 block 或 compactionId ' +
      '取回该块覆盖的原文；offset/limit 分页。只读，不改变上下文。',
    parameters: {
      block: { type: 'string', description: "块编号，如 'b3'。" },
      compactionId: { type: 'string', description: '压缩事务 id（与 block 二选一）。' },
      offset: { type: 'number', description: '分页起点（从 0 开始）。' },
      limit: { type: 'number', description: '本页返回条数（默认取配置 decompressPageSize）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const session = exec?.agent?.session;
      if (session === undefined || session === null) return failure('missing', 'no agent');

      const hasBlock = args?.block !== undefined && args?.block !== null;
      const hasCompactionId = args?.compactionId !== undefined && args?.compactionId !== null;
      if (hasBlock && typeof args.block !== 'string') return failure('bad-request', 'block 必须是字符串');
      if (hasCompactionId && typeof args.compactionId !== 'string') {
        return failure('bad-request', 'compactionId 必须是字符串');
      }

      const offset = args?.offset === undefined ? 0 : args.offset;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        return failure('bad-request', 'offset 必须是 >= 0 的整数');
      }

      const configuredPage = configuredDecompressPageSize(deps);
      const rawLimit = args?.limit === undefined ? configuredPage : args.limit;
      if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
        return failure('bad-request', 'limit 必须是 >= 1 的整数');
      }
      // 上限 50：防止一次把整块原文塞回上下文，抵消压缩的意义。
      const limit = Math.min(50, rawLimit);

      const blocks = buildLedger(session);

      // 不传选择器：只列块目录，不返回原文（原文可能很大）。
      if (!hasBlock && !hasCompactionId) {
        return {
          ok: true,
          blocks: blocks.map((block) => ({
            block: block.block,
            compactionId: block.compactionId,
            tier: block.tier,
            tokens: block.shadowedTokens,
            startSeq: block.startSeq,
            endSeq: block.endSeq,
            summarySeq: block.summarySeq,
          })),
          total: blocks.length,
        };
      }

      let target;
      if (hasBlock) target = blocks.find((block) => block.block === args.block);
      // block 找不到但同时给了 compactionId 时再按 id 找：模型可能抄错编号但记得事务 id。
      if (target === undefined && hasCompactionId) {
        target = blocks.find((block) => block.compactionId === String(args.compactionId));
      }
      if (target === undefined) {
        return failure('missing', `找不到块 ${hasBlock ? String(args.block) : String(args.compactionId)}；先用 acp_status 查看块目录`);
      }

      const seqs = target.shadowedSeqs;
      const total = seqs.length;
      const pageSeqs = seqs.slice(offset, offset + limit);
      const page = pageSeqs.map((seq) => {
        const event = eventAt(session, seq);
        return {
          seq,
          role: eventRole(session, event),
          text: eventText(session, event),
        };
      });

      const result = { ok: true, blocks: page, total };
      const nextOffset = offset + limit;
      if (nextOffset < total) result.next = nextOffset;
      return result;
    },
  }));

  const disposeSearch = ctx.tools.register(defineTool({
    name: 'search_context',
    description:
      '在会话历史里做零依赖混合检索（中文 bigram + 英文词匹配 + 子串加权）。' +
      'scope 可选 all/summaries/originals；摘要与被压原文都可搜。只读。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（可多词）。' },
      scope: { type: 'string', enum: ['all', 'summaries', 'originals'], description: '检索范围，默认 all。' },
      limit: { type: 'number', description: '最多返回条数。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const session = exec?.agent?.session;
      if (session === undefined || session === null) return failure('missing', 'no agent');

      if (typeof args?.query !== 'string') return failure('bad-request', 'query 必须是字符串');
      const needle = args.query.trim().toLowerCase();
      if (needle.length === 0) return failure('bad-request', 'query 不能为空');

      const scope = args?.scope === undefined ? 'all' : args.scope;
      if (scope !== 'all' && scope !== 'summaries' && scope !== 'originals') {
        return failure('bad-request', `未知 scope ${String(scope)}；可选 all/summaries/originals`);
      }

      const configuredLimit = positiveInt(retainNumber(deps, 'searchLimit', DEFAULT_SEARCH_LIMIT), DEFAULT_SEARCH_LIMIT);
      const rawLimit = args?.limit === undefined ? configuredLimit : args.limit;
      // 契约只要求「夹 1..50」：limit 是展示裁剪，不因模型传了 0/超大值而报错。
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(50, Math.max(1, Math.trunc(rawLimit)))
        : Math.min(50, configuredLimit);
      const excerptChars = Math.max(20, Math.trunc(retainNumber(deps, 'searchExcerptChars', DEFAULT_EXCERPT_CHARS)));

      const tokens = tokenize(needle);
      /** @type {{ block: string | null, seq: number, text: string }[]} */
      const candidates = [];
      const blocks = buildLedger(session);

      if (scope === 'summaries' || scope === 'all') {
        for (const block of blocks) {
          if (block.text.length > 0) candidates.push({ block: block.block, seq: block.summarySeq, text: block.text });
        }
      }

      if (scope === 'originals' || scope === 'all') {
        for (const block of blocks) {
          for (const seq of block.shadowedSeqs) {
            const text = eventText(session, eventAt(session, seq));
            if (text.length > 0) candidates.push({ block: block.block, seq, text });
          }
        }
      }

      if (scope === 'all') {
        const nodes = (() => {
          try {
            return session?.surface?.nodes ?? [];
          } catch {
            return [];
          }
        })();
        for (const seq of nodes) {
          const text = eventText(session, eventAt(session, seq));
          // 当前 surface 上的节点不属于任何块 —— block 必须是 null（模型据此区分「现役上下文」）。
          if (text.length > 0) candidates.push({ block: null, seq, text });
        }
      }

      const scored = [];
      for (const candidate of candidates) {
        const result = scoreText(candidate.text, tokens, needle, excerptChars);
        if (result === null) continue;
        scored.push({ block: candidate.block, seq: candidate.seq, score: result.score, excerpt: result.excerpt });
      }

      // 分数降序、同分 seq 升序：模型读到的是稳定的相关性排序，不随对象插入顺序抖动。
      scored.sort((left, right) => right.score - left.score || left.seq - right.seq);
      const total = scored.length;
      return { ok: true, hits: scored.slice(0, limit), total };
    },
  }));

  return () => {
    disposeSearch();
    disposeDecompress();
  };
}

/** 取配置里的 decompress 页大小（独立成函数便于在 execute 里早于 limit 校验使用）。 */
function configuredDecompressPageSize(deps) {
  return positiveInt(retainNumber(deps, 'decompressPageSize', DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE);
}
