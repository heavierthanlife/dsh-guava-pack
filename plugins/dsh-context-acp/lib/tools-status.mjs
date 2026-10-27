/**
 * dsh-context-acp — `acp_status` 工具（B 负责；替换 P0 的最小实现）。
 *
 * P0 这里只有「引擎身份 + 空账本」，用于证明工具确实进了模型可见注册表；
 * P2 起它必须与 session 日志逐项一致：块目录、tier、被压节点分类、
 * checkpoint seq 映射、最近一次 nudge 状态，以及可选的 context 占用。
 *
 * ## 契约（不许改形状）
 *
 * 入参 { scope?: 'blocks'|'context', view?: 'summary'|'messages'|'ranges', limit?: number }
 * 出参 { ok: true, scope, view, blocks: [...], totals: {tool, text, summaries},
 *        nudge: {state, reason, nextAt}, checkpoints: {b3: seq}, context?, engine? }
 *
 * ## 为什么只读、且异常必须收口
 *
 * 这是诊断工具：模型在压缩前后都会调它。任何内部异常（meter 抛错、requestHeader
 * 缺失、旧日志形状）都不该打断整个 turn，所以统一转成 `{ok:false, code:'internal'}`；
 * 同时它绝不 append 事件、绝不调用 LLM —— 数字全部来自 ledger + 共享 state。
 *
 * @module dsh-context-acp/tools-status
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { buildLedger, totalsOf } from './ledger.mjs';
import { snapshot } from './state.mjs';

/** 默认返回块数 / 上限（防止一次把账本全塞进上下文）。 */
const DEFAULT_BLOCK_LIMIT = 50;
const MAX_BLOCK_LIMIT = 200;
/** summary 视图的 preview 长度（字符数，不是 token）。 */
const PREVIEW_CHARS = 120;

/** 把任意值安全转成字符串；非字符串返回 null，避免把对象塞进出参。 */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 规范化 limit：非数字用默认值，越界夹到 1..200。
 * 与 decompress/search 不同，状态面板的 limit 是「展示裁剪」，不该因为传了 0 就报错。
 */
function normalizeLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BLOCK_LIMIT;
  return Math.min(MAX_BLOCK_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * 注册 `acp_status` 工具。
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {() => void} disposer
 */
export function registerStatusTool(deps) {
  const { ctx } = deps;

  return ctx.tools.register(defineTool({
    name: 'acp_status',
    description:
      '读取上下文压缩账本：已压缩的块（b1/b2…）、各块 tier 与 token 数、当前上下文占用、' +
      '最近一次 nudge 状态。compress 前先看这里选区间；压缩后用它确认账本变化。',
    parameters: {
      scope: { type: 'string', enum: ['blocks', 'context'], description: '视角，默认 blocks。' },
      view: { type: 'string', enum: ['summary', 'messages', 'ranges'], description: '块的详细程度。' },
      limit: { type: 'number', description: '最多返回块数。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent;
      const session = agent?.session;
      if (session === undefined || session === null) {
        return { ok: false, code: 'missing', message: 'no agent' };
      }

      try {
        const scope = args?.scope === 'context' ? 'context' : 'blocks';
        const view = args?.view === 'messages' || args?.view === 'ranges' || args?.view === 'summary'
          ? args.view
          : 'summary';
        const limit = normalizeLimit(args?.limit);

        // 账本只从日志重建；totals 基于全部块，limit 只裁剪返回的 blocks 数组。
        const ledger = buildLedger(session);
        const totals = totalsOf(ledger);

        const blocks = ledger.slice(0, limit).map((block) => {
          const entry = {
            block: block.block,
            compactionId: block.compactionId,
            tier: block.tier,
            tokens: block.shadowedTokens,
            provider: block.provider,
            model: block.model,
            summarySeq: block.summarySeq,
            startSeq: block.startSeq,
            endSeq: block.endSeq,
          };
          if (view === 'summary') entry.preview = block.text.slice(0, PREVIEW_CHARS);
          else if (view === 'ranges') entry.shadowedSeqs = block.shadowedSeqs.slice();
          else entry.text = block.text;
          return entry;
        });

        const checkpoints = {};
        for (const block of ledger) checkpoints[block.block] = block.summarySeq;

        // nudge 是日志里没有的瞬时状态，从共享 state 映射（不自己造原因）。
        const state = snapshot(agent);
        const nudge = {
          state: state.lastNudge === null || state.lastNudge === undefined ? 'idle' : 'nudged',
          reason: state.lastSkipReason ?? state.lastNudge?.reason ?? 'none',
          nextAt: state.lastNudge?.at ?? 0,
        };

        // engine 仅用于可视化诊断：解析失败/没有引擎都不能让状态查询失败。
        let engineConstructor = null;
        try {
          const engine = deps.resolveEngine?.(agent);
          engineConstructor = engine === undefined || engine === null ? null : engine.constructor?.name ?? null;
        } catch {
          engineConstructor = null;
        }

        const result = {
          ok: true,
          scope,
          view,
          blocks,
          totals,
          nudge,
          checkpoints,
          engine: {
            constructor: engineConstructor,
            backend: deps.runtime?.backend ?? null,
          },
        };

        if (scope === 'context') {
          // 尽力而为：宿主 tokenMeter 是唯一记账来源，但这里只是「展示」，
          // 读不到就明确给 null，绝不自己估算一个数字。
          let usedTokens = null;
          try {
            const meter = deps.tokenMeter?.();
            if (typeof meter?.measure === 'function') {
              // measure 在现版本是同步的；await 兼容未来可能的变化，也让 try/catch 覆盖 rejection。
              const measured = await meter.measure(session);
              const total = measured?.totalTokens;
              if (typeof total === 'number' && Number.isFinite(total)) usedTokens = total;
            }
          } catch {
            usedTokens = null;
          }

          const context = { usedTokens };
          try {
            const config = session.requestHeader?.()?.config;
            const provider = stringOrNull(config?.provider);
            const model = stringOrNull(config?.model);
            if (provider !== null) context.provider = provider;
            if (model !== null) context.model = model;
          } catch {
            // header 缺失很正常（还没发过请求）；context 里就不给 provider/model。
          }
          result.context = context;
        }

        return result;
      } catch (error) {
        return { ok: false, code: 'internal', message: String(error?.message ?? error) };
      }
    },
  }));
}
