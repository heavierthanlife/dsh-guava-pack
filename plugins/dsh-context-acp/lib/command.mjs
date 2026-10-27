/**
 * dsh-context-acp — `/acp` 命令（C 负责）。
 *
 * ## 子命令
 *
 *   /acp            等价 /acp status
 *   /acp status     账本摘要（块数、最老/最新块、被压 tokens、最高 tier、nudge、引擎）
 *   /acp blocks     全部块列表（一行一块）
 *   /acp nudge      按最近一次压力重新渲染 nudge 文本（调试用）
 *   /acp help       用法
 *
 * ## 为什么是子命令而不是多个顶层命令
 *
 * 命令面板空间有限，且 `/acp` 是一个概念（压缩控制台）。解析仍是纯函数
 * `parseAcpCommand()`（已有，保持原样），本文件只负责把结果映射成人类可读文本。
 *
 * ## 只读、绝不抛
 *
 * 命令是诊断面：`buildLedger` 读日志、`snapshot` 读瞬时状态，都不该让命令
 * 面板崩掉。任何异常统一转成 `{kind:'error', text:'/acp 失败：…'}`，由 UI 渲染。
 *
 * @module dsh-context-acp/command
 */

import { buildLedger, totalsOf } from './ledger.mjs';
import { renderNudge } from './nudge.mjs';
import { snapshot } from './state.mjs';

/** 用法文本（`/acp help`；也是解析层 help 的兜底输出）。 */
const USAGE = [
  '/acp 用法：/acp status|blocks|nudge（省略子命令等价于 status）',
  '- /acp 或 /acp status：账本摘要（块数、tier、被压 tokens、最近 nudge、引擎）',
  '- /acp blocks：逐块列表（编号、tier、tokens、seq 区间、compactionId）',
  '- /acp nudge：按最近一次 nudge 的压力数字渲染提醒文本',
].join('\n');

/**
 * 解析 `/acp` 的原始输入。
 *
 * @param {string} rawInput 命令后原始文本
 * @returns {{ subcommand: 'status'|'blocks'|'nudge'|'help', error?: string }}
 */
export function parseAcpCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (text === '') return { subcommand: 'status' };
  const [head, ...rest] = text.split(/\s+/);
  if (rest.length > 0) return { subcommand: 'help', error: `多余的参数：${rest.join(' ')}` };
  if (head === 'status' || head === 'blocks' || head === 'nudge') return { subcommand: head };
  return { subcommand: 'help', error: `未知子命令：${head}` };
}

/** 有限非负数，否则 0。 */
function positiveOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 千分位（不依赖 locale，输出稳定）。 */
function formatTokens(value) {
  const number = positiveOrZero(value);
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** compactionId 只显示前 8 位（完整值在 acp_status / 日志里）。 */
function shortId(value) {
  return typeof value === 'string' && value !== '' ? value.slice(0, 8) : '—';
}

/** 块的一行摘要（blocks/status 共用）。 */
function blockLine(block) {
  return `${block.block} | tier${block.tier} | ${formatTokens(block.shadowedTokens)} tokens | seqs ${block.startSeq}..${block.endSeq} | ${shortId(block.compactionId)}`;
}

/** 最高 tier（没有块时 0）。 */
function tierMaxOf(blocks) {
  let max = 0;
  for (const block of blocks) {
    if (typeof block?.tier === 'number' && Number.isFinite(block.tier)) max = Math.max(max, block.tier);
  }
  return max;
}

/** 累计被压 tokens。 */
function shadowedTokensOf(blocks) {
  let total = 0;
  for (const block of blocks) total += positiveOrZero(block?.shadowedTokens);
  return total;
}

/** 时间戳 → 稳定的本地可读时间；没有记录时给「未发过」。 */
function formatTime(at) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '未发过';
  try {
    return new Date(at).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '时间未知';
  }
}

/** `status` 子命令的文本。 */
function renderStatus(agent, backend) {
  const session = agent?.session;
  const blocks = buildLedger(session);
  const totals = totalsOf(blocks);
  const newest = blocks[blocks.length - 1];
  const oldest = blocks[0];
  const state = snapshot(agent);

  const lastNudge = state.lastNudge;
  const nudgeLine = lastNudge === null || typeof lastNudge !== 'object'
    ? '未发过（等 pre-step 压力检查）'
    : `${formatTime(lastNudge.at)} · ${lastNudge.reason ?? 'pressure'} · ${formatTokens(lastNudge.usedTokens)}/${formatTokens(lastNudge.contextWindow)} tokens`;
  const skipLine = typeof state.lastSkipReason === 'string' && state.lastSkipReason !== '' ? state.lastSkipReason : '无';

  return [
    'ACP 压缩账本',
    `- 块数：${blocks.length}${blocks.length > 0 ? `（${oldest.block}..${newest.block}）` : '（还没有压缩过任何区间）'}`,
    `- 最老块：${oldest === undefined ? '无' : blockLine(oldest)}`,
    `- 最新块：${newest === undefined ? '无' : blockLine(newest)}`,
    `- 累计被压 tokens：${formatTokens(shadowedTokensOf(blocks))}（工具结果 ${totals.tool} 条 / 消息 ${totals.text} 条）`,
    `- 最高 tier：${tierMaxOf(blocks)}`,
    `- 最近 nudge：${nudgeLine}`,
    `- 最近跳过原因：${skipLine}`,
    `- 引擎：backend=${String(backend ?? 'acp')}`,
  ].join('\n');
}

/** `blocks` 子命令的文本。 */
function renderBlocks(agent) {
  const blocks = buildLedger(agent?.session);
  if (blocks.length === 0) {
    return '账本为空：还没有压缩过任何区间。\n等一次 compress，或先用 acp_status 看当前上下文。';
  }
  return blocks.map(blockLine).join('\n');
}

/** `nudge` 子命令的文本。 */
function renderNudgeCommand(agent) {
  const state = snapshot(agent);
  const lastNudge = state.lastNudge;
  if (lastNudge === null || typeof lastNudge !== 'object') {
    return '当前没有 nudge 记录（等 pre-step 压力检查）。';
  }
  const blocks = buildLedger(agent?.session);
  return renderNudge({
    usedTokens: lastNudge.usedTokens,
    contextWindow: lastNudge.contextWindow,
    blocks,
    tierMax: tierMaxOf(blocks),
  });
}

/**
 * 安装 `/acp` 命令。
 *
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {() => void} disposer
 */
export function installCommand(deps) {
  const { ctx } = deps;
  let dispose;
  // commands 服务是宿主平面的；headless 组合也有。缺失时静默跳过。
  const off = ctx.inject(['commands'], (cctx) => {
    try {
      dispose = cctx.commands.register({
        name: 'acp',
        description: '上下文压缩控制台（status / blocks / nudge）',
        handler: async (invocation) => {
          try {
            const rawInput = invocation?.rawInput;
            // `help` 是控制台的用法别名。parseAcpCommand 只认 status/blocks/nudge，
            // 会把 help 当未知词；这里在解析前接住它，解析函数本身保持原样。
            const head = typeof rawInput === 'string' ? rawInput.trim().split(/\s+/)[0] : '';
            if (head === 'help' || head === '?') return { kind: 'success', text: USAGE };

            const parsed = parseAcpCommand(rawInput);
            if (parsed.error !== undefined) return { kind: 'error', text: parsed.error };

            const agent = invocation?.agent;
            if (agent === null || typeof agent !== 'object' || agent.session === undefined) {
              return { kind: 'error', text: '/acp 失败：当前会话不可用（没有 agent/session）' };
            }

            if (parsed.subcommand === 'blocks') return { kind: 'success', text: renderBlocks(agent) };
            if (parsed.subcommand === 'nudge') return { kind: 'success', text: renderNudgeCommand(agent) };
            if (parsed.subcommand === 'help') return { kind: 'success', text: USAGE };
            return { kind: 'success', text: renderStatus(agent, deps.runtime?.backend) };
          } catch (error) {
            return { kind: 'error', text: `/acp 失败：${String(error?.message ?? error)}` };
          }
        },
      });
    } catch (error) {
      deps.logger?.warn?.(`[acp] /acp 命令注册失败：${String(error?.message ?? error)}`);
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
