#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/tests/acp-ledger.mjs — P2 账本/恢复/检索/状态单元门禁。
 *
 * ## 为什么用假 session 而不是真实 Session
 *
 * 这一层要验证的是「从日志重建」的**规则**：compactionId 配对、checkpoint →
 * tier+1、shadowedSeqs 统计、分页/检索/视图映射。规则只依赖日志事件形状，
 * 用真实 Session 反而要把每条历史压成真正可 append 的消息、还得构造 surface
 * 替换事务，成本高且噪声大。真实引擎/日志契约已由 `acp-engine.mjs`（真实
 * Session）与 `acp-e2e.mjs`（隔离进程）覆盖；这里刻意只喂事件数组。
 *
 * 假 session 形状与契约一致：
 *   { snapshotEvents, eventAt, deriveEventMessage, surface: { nodes }, requestHeader }
 *
 * 用法：`node tools/tests/acp-ledger.mjs`（退出码 0 = 全过）。
 *
 * @module tools/tests/acp-ledger
 */

import { buildLedger, tierOfShadowedSeqs, totalsOf } from '../../plugins/dsh-context-acp/lib/ledger.mjs';
import { registerRestoreTools } from '../../plugins/dsh-context-acp/lib/tools-restore.mjs';
import { registerStatusTool } from '../../plugins/dsh-context-acp/lib/tools-status.mjs';
import { stateOf } from '../../plugins/dsh-context-acp/lib/state.mjs';

// ── 极简断言/收集器（零依赖） ─────────────────────────────────────────────────

const tests = [];
const failures = [];
let passed = 0;

/** 注册一个异步用例。 */
function test(name, fn) {
  tests.push({ name, fn });
}

/** 条件断言。 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 严格相等断言（附期望/实际）。 */
function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 数组逐项严格相等。 */
function eqArray(actual, expected, label) {
  assert(Array.isArray(actual), `${label}：期望数组，实际 ${JSON.stringify(actual)}`);
  eq(actual.length, expected.length, `${label}.length`);
  expected.forEach((value, index) => eq(actual[index], value, `${label}[${index}]`));
}

// ── 事件夹具 ─────────────────────────────────────────────────────────────────

/**
 * 构造一串 seq 连续的事件。每个 surface 事件都同时带 `data`（日志形状）与
 * `__message`（假 session.deriveEventMessage 的返回值），两者保持一致。
 */
function recorder() {
  const events = [];
  const push = (type, data, message) => {
    const seq = events.length;
    events.push({ seq, time: '2026-10-27T00:00:00.000Z', type, data, ...(message ? { __message: message } : {}) });
    return seq;
  };

  return {
    events,
    user(text, source = { kind: 'user' }) {
      const message = { id: `m-${events.length}`, role: 'user', content: [{ type: 'text', text }], source };
      return push('user/message', message, message);
    },
    toolResult(text) {
      const message = {
        id: `t-${events.length}`,
        role: 'tool',
        toolCallId: `call-${events.length}`,
        source: { kind: 'tool', callId: `call-${events.length}` },
        content: [{ type: 'text', text }],
      };
      return push('tool/result', { turn: 1, step: 1, message }, message);
    },
    start(compactionId) {
      return push('compaction/start', { compactionId, turn: 1 });
    },
    summary(compactionId, { text, shadowedSeqs, tokens }) {
      const start = shadowedSeqs.length > 0 ? shadowedSeqs[0] : -1;
      const end = shadowedSeqs.length > 0 ? shadowedSeqs[shadowedSeqs.length - 1] : -1;
      return push('compaction/summary', {
        compactionId,
        summary: [{ type: 'text', text }],
        shadowedRange: { start, end },
        shadowedSeqs: [...shadowedSeqs],
        shadowedTokenCount: tokens,
        provider: 'test-provider',
        model: 'test-model',
      });
    },
    checkpoint(compactionId, text) {
      // checkpoint 替换节点：source.kind 是 tier 推导的唯一标记。
      return this.user(text, { kind: 'compact-checkpoint', compactionId });
    },
    end(compactionId) {
      return push('compaction/end', { compactionId, turn: 1 });
    },
  };
}

/**
 * 假 session。surface 只给节点 seq；文本通过 eventAt/deriveEventMessage 还原。
 */
function fakeSession(record, surfaceNodes = [], requestHeader = undefined) {
  const bySeq = new Map(record.events.map((event) => [event.seq, event]));
  return {
    snapshotEvents: () => record.events.slice(),
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.__message ?? null,
    surface: { nodes: surfaceNodes },
    requestHeader: () => requestHeader,
  };
}

/** 单次压缩夹具：两条用户消息 + 一条工具结果，被 b1 压掉。 */
function singleFixture() {
  const record = recorder();
  const one = record.user('项目代号 ORCHID-11。构建命令 pnpm build，产物落在 dist/ 目录。');
  const two = record.user('数据库迁移用 scripts/migrate-2026.ts，失败码是 E_MIGRATE_LOCKED。');
  const tool = record.toolResult('tool output: ORCHID-11 build cache at .orchid-cache');
  const summaryText = '## 已确认事实\n- 项目代号 ORCHID-11；构建 pnpm build。\n- 数据库迁移失败码 E_MIGRATE_LOCKED。';
  record.start('c1');
  const summarySeq = record.summary('c1', { text: summaryText, shadowedSeqs: [one, two, tool], tokens: 321 });
  const checkpoint = record.checkpoint('c1', 'CHECKPOINT NODE c1');
  record.end('c1');
  const session = fakeSession(record, [checkpoint]);
  return { record, session, seqs: { one, two, tool, summarySeq, checkpoint }, summaryText };
}

/** 两次压缩夹具：b2 压掉 b1 的 checkpoint → tier 2；另含一次失败压缩（只有 start）。 */
function doubleFixture() {
  const record = recorder();
  const one = record.user('第一段：ALPHA 记录，含 ORCHID-11。');
  const two = record.user('第二段：BETA 记录，含 E_MIGRATE_LOCKED。');
  const tool = record.toolResult('tool output: ALPHA/BETA confirmed');
  record.start('c1');
  const summary1 = record.summary('c1', {
    text: '第一层摘要：ALPHA 与 BETA，ORCHID-11。',
    shadowedSeqs: [one, two, tool],
    tokens: 111,
  });
  const checkpoint1 = record.checkpoint('c1', 'CHECKPOINT NODE c1');
  record.end('c1');

  const three = record.user('第三段：GAMMA 记录，当前上下文里的 UNIQUE-SURFACE-TOKEN 只在这里。');
  record.start('c2');
  const summary2 = record.summary('c2', {
    text: '第二层摘要：把上一层 checkpoint 与 GAMMA 合并。',
    shadowedSeqs: [checkpoint1, three],
    tokens: 222,
  });
  const checkpoint2 = record.checkpoint('c2', 'CHECKPOINT NODE c2');
  record.end('c2');

  // 失败压缩：只有 start，没有 summary → buildLedger 必须忽略它。
  record.start('c-failed');

  // 当前 surface：c2 的 checkpoint + 一条压缩结束后追加的用户消息。
  const current = record.user('现役用户消息：当前上下文里的 UNIQUE-SURFACE-TOKEN。');
  const session = fakeSession(record, [checkpoint2, current], { config: { provider: 'test-provider', model: 'test-model' } });
  return {
    record,
    session,
    seqs: { one, two, tool, summary1, checkpoint1, three, summary2, checkpoint2, current },
  };
}

// ── 假 deps / 工具调用 ───────────────────────────────────────────────────────

const RUNTIME = {
  backend: 'acp',
  retain: { decompressPageSize: 8, searchLimit: 20, searchExcerptChars: 240 },
};

/** 注册工具并返回 name → definition。 */
function installTools(register, overrides = {}) {
  const defs = [];
  register({
    ctx: { tools: { register(definition) { defs.push(definition); return () => {}; } } },
    runtime: RUNTIME,
    rowConfig: {},
    logger: { warn() {}, info() {} },
    resolveEngine: () => ({ constructor: { name: 'AcpEngine' } }),
    tokenMeter: () => ({ measure: () => ({ totalTokens: 4321 }) }),
    ...overrides,
  });
  return { defs, tool: (name) => defs.find((definition) => definition.name === name) };
}

/** 调工具（defineTool 包了一层参数校验，但仍可直接 execute）。 */
async function run(definition, args, agent) {
  return definition.execute(args, { agent, signal: new AbortController().signal });
}

// ── 账本 ─────────────────────────────────────────────────────────────────────

test('buildLedger：单次压缩 → b1 / tier1 / tokens / text', () => {
  const { session, seqs, summaryText } = singleFixture();
  const blocks = buildLedger(session);
  eq(blocks.length, 1, 'blocks.length');
  const block = blocks[0];
  eq(block.block, 'b1', 'block');
  eq(block.compactionId, 'c1', 'compactionId');
  eq(block.tier, 1, 'tier');
  eq(block.shadowedTokens, 321, 'shadowedTokens');
  eqArray(block.shadowedSeqs, [seqs.one, seqs.two, seqs.tool], 'shadowedSeqs');
  eq(block.startSeq, seqs.one, 'startSeq');
  eq(block.endSeq, seqs.tool, 'endSeq');
  eq(block.summarySeq, seqs.summarySeq, 'summarySeq');
  eq(block.provider, 'test-provider', 'provider');
  eq(block.model, 'test-model', 'model');
  eq(block.text, summaryText, 'text');
});

test('buildLedger：第二次压缩 checkpoint → b2.tier===2；失败压缩不算块', () => {
  const { session } = doubleFixture();
  const blocks = buildLedger(session);
  eq(blocks.length, 2, '只应有两块（c-failed 没有 summary）');
  eq(blocks[0].block, 'b1', 'blocks[0].block');
  eq(blocks[0].tier, 1, 'blocks[0].tier');
  eq(blocks[1].block, 'b2', 'blocks[1].block');
  eq(blocks[1].tier, 2, 'blocks[1].tier');
  assert(!blocks.some((block) => block.compactionId === 'c-failed'), '失败压缩不应出现');
});

test('tierOfShadowedSeqs：含 checkpoint → 2；不含 → 1', () => {
  const { session, seqs } = doubleFixture();
  eq(tierOfShadowedSeqs(session, [seqs.checkpoint1, seqs.three]), 2, '含 checkpoint1');
  eq(tierOfShadowedSeqs(session, [seqs.one]), 1, '普通原文');
  eq(tierOfShadowedSeqs(session, []), 1, '空集合');
});

test('totalsOf：tool/result 与消息节点分类正确', () => {
  const { session } = doubleFixture();
  const totals = totalsOf(buildLedger(session));
  eq(totals.tool, 1, 'tool');
  eq(totals.text, 4, 'text');
  eq(totals.summaries, 2, 'summaries');
});

// ── decompress ───────────────────────────────────────────────────────────────

test('decompress：不传参数列出全部块', async () => {
  const { session } = doubleFixture();
  const { tool } = installTools(registerRestoreTools);
  const result = await run(tool('decompress'), {}, { session });
  eq(result.ok, true, 'ok');
  eq(result.total, 2, 'total');
  eq(result.blocks.length, 2, 'blocks.length');
  const first = result.blocks[0];
  eq(first.block, 'b1', 'blocks[0].block');
  eq(first.compactionId, 'c1', 'blocks[0].compactionId');
  eq(first.tier, 1, 'blocks[0].tier');
  eq(first.tokens, 111, 'blocks[0].tokens');
  eq(typeof first.startSeq, 'number', 'startSeq 类型');
  eq(typeof first.summarySeq, 'number', 'summarySeq 类型');
});

test('decompress：分页 offset/limit/next/total 与 role 推断', async () => {
  const { session, seqs } = doubleFixture();
  const { tool } = installTools(registerRestoreTools);

  const page1 = await run(tool('decompress'), { block: 'b1', limit: 2 }, { session });
  eq(page1.ok, true, 'page1.ok');
  eq(page1.total, 3, 'page1.total');
  eq(page1.blocks.length, 2, 'page1.blocks.length');
  eq(page1.next, 2, 'page1.next');
  eqArray(page1.blocks.map((entry) => entry.seq), [seqs.one, seqs.two], 'page1.seqs');
  eqArray(page1.blocks.map((entry) => entry.role), ['user', 'user'], 'page1.roles');

  const page2 = await run(tool('decompress'), { block: 'b1', offset: 2, limit: 2 }, { session });
  eq(page2.blocks.length, 1, 'page2.blocks.length');
  eq(page2.blocks[0].role, 'tool', 'page2.role');
  eq(Object.hasOwn(page2, 'next'), false, '最后一页不应有 next');

  // offset 超过 total：合法请求，空页 + total 仍是权威数量。
  const empty = await run(tool('decompress'), { block: 'b1', offset: 9 }, { session });
  eq(empty.ok, true, 'empty.ok');
  eq(empty.blocks.length, 0, 'empty.blocks');
  eq(empty.total, 3, 'empty.total');
  eq(Object.hasOwn(empty, 'next'), false, 'empty 无 next');

  // limit 超上限夹到 50，足以一次取完。
  const clamped = await run(tool('decompress'), { block: 'b1', limit: 999 }, { session });
  eq(clamped.blocks.length, 3, 'clamped.blocks');
});

test('decompress：未知块 missing、非法分页 bad-request、无 agent missing', async () => {
  const { session } = doubleFixture();
  const { tool } = installTools(registerRestoreTools);
  const decompress = tool('decompress');

  const missing = await run(decompress, { block: 'b9' }, { session });
  eq(missing.ok, false, 'missing.ok');
  eq(missing.code, 'missing', 'missing.code');

  const byId = await run(decompress, { compactionId: 'nope' }, { session });
  eq(byId.code, 'missing', 'compactionId missing.code');

  const badOffset = await run(decompress, { block: 'b1', offset: -1 }, { session });
  eq(badOffset.ok, false, 'badOffset.ok');
  eq(badOffset.code, 'bad-request', 'badOffset.code');

  const badLimit = await run(decompress, { block: 'b1', limit: 0 }, { session });
  eq(badLimit.code, 'bad-request', 'badLimit.code');

  const noAgent = await run(decompress, {}, undefined);
  eq(noAgent.ok, false, 'noAgent.ok');
  eq(noAgent.code, 'missing', 'noAgent.code');
  eq(noAgent.message, 'no agent', 'noAgent.message');
});

// ── search_context ───────────────────────────────────────────────────────────

test('search_context：中文 bigram 命中', async () => {
  const { session, seqs } = singleFixture();
  const { tool } = installTools(registerRestoreTools);
  const result = await run(tool('search_context'), { query: '数据库迁移', scope: 'originals' }, { session });
  eq(result.ok, true, 'ok');
  assert(result.hits.length >= 1, '应至少命中一条');
  const hit = result.hits.find((entry) => entry.seq === seqs.two);
  assert(hit !== undefined, '应命中第二条原文');
  assert(hit.score > 0, `score 应 > 0（实际 ${hit.score}）`);
  assert(hit.excerpt.includes('数据库迁移'), `excerpt 应包含关键词：${hit.excerpt}`);
});

test('search_context：英文 ORCHID-11 命中', async () => {
  const { session, seqs } = singleFixture();
  const { tool } = installTools(registerRestoreTools);
  const result = await run(tool('search_context'), { query: 'ORCHID-11', scope: 'originals' }, { session });
  eq(result.ok, true, 'ok');
  const hit = result.hits.find((entry) => entry.seq === seqs.one);
  assert(hit !== undefined, '应命中 ORCHID-11 原文');
  assert(hit.score >= 3, `整串命中至少 +3（实际 ${hit.score}）`);
});

test('search_context：scope summaries/originals/all 范围差异', async () => {
  const { session, seqs } = doubleFixture();
  const { tool } = installTools(registerRestoreTools);

  const summaries = await run(tool('search_context'), { query: '层摘要', scope: 'summaries' }, { session });
  const summaryHit = summaries.hits.find((hit) => hit.block === 'b1' && hit.seq === seqs.summary1);
  assert(summaryHit !== undefined, 'summaries 应命中 b1 摘要');
  assert(summaries.hits.every((hit) => hit.block !== null), '摘要命中必须带 block');

  const originals = await run(tool('search_context'), { query: '层摘要', scope: 'originals' }, { session });
  eq(originals.hits.length, 0, 'originals 不应命中摘要文本');

  const surfaceOnly = await run(tool('search_context'), { query: 'UNIQUE-SURFACE-TOKEN', scope: 'all' }, { session });
  const currentHit = surfaceOnly.hits.find((hit) => hit.block === null);
  assert(currentHit !== undefined, 'all 应命中当前 surface 节点且 block=null');
  eq(currentHit.seq, seqs.current, 'surface hit 的 seq');

  const notInSummary = await run(tool('search_context'), { query: 'UNIQUE-SURFACE-TOKEN', scope: 'summaries' }, { session });
  eq(notInSummary.hits.length, 0, 'summaries 不应看到现役 surface 文本');
});

test('search_context：limit 截断且 total 保留', async () => {
  const { session } = singleFixture();
  const { tool } = installTools(registerRestoreTools);
  const result = await run(tool('search_context'), { query: 'ORCHID', scope: 'all', limit: 1 }, { session });
  eq(result.ok, true, 'ok');
  eq(result.hits.length, 1, 'hits 被 limit 截断');
  assert(result.total >= 2, `total 应反映全部命中（实际 ${result.total}）`);
  eq(result.hits[0].score >= result.hits[0].score, true, 'score 存在');
});

test('search_context：空 query → bad-request', async () => {
  const { session } = singleFixture();
  const { tool } = installTools(registerRestoreTools);
  const result = await run(tool('search_context'), { query: '   ' }, { session });
  eq(result.ok, false, 'ok');
  eq(result.code, 'bad-request', 'code');
});

// ── acp_status ───────────────────────────────────────────────────────────────

test('acp_status：summary 视图 + totals + checkpoints + nudge 映射', async () => {
  const { session, seqs } = doubleFixture();
  const { tool } = installTools(registerStatusTool);
  const agent = { session };
  const result = await run(tool('acp_status'), {}, agent);

  eq(result.ok, true, 'ok');
  eq(result.scope, 'blocks', 'scope');
  eq(result.view, 'summary', '默认 view');
  eq(result.blocks.length, 2, 'blocks.length');
  eq(result.blocks[0].block, 'b1', 'blocks[0].block');
  eq(result.blocks[0].tier, 1, 'blocks[0].tier');
  eq(result.blocks[0].tokens, 111, 'blocks[0].tokens');
  assert(typeof result.blocks[0].preview === 'string' && result.blocks[0].preview.length <= 120, 'preview 长度');
  eq(Object.hasOwn(result.blocks[0], 'text'), false, 'summary 视图不带全文');
  eq(Object.hasOwn(result.blocks[0], 'shadowedSeqs'), false, 'summary 视图不带 ranges');

  eq(result.totals.tool, 1, 'totals.tool');
  eq(result.totals.text, 4, 'totals.text');
  eq(result.totals.summaries, 2, 'totals.summaries');
  eq(result.checkpoints.b1, seqs.summary1, 'checkpoints.b1');
  eq(result.checkpoints.b2, seqs.summary2, 'checkpoints.b2');
  eq(result.nudge.state, 'idle', 'nudge.state');
  eq(result.nudge.reason, 'none', 'nudge.reason');
  eq(result.nudge.nextAt, 0, 'nudge.nextAt');
  eq(result.engine.constructor, 'AcpEngine', 'engine.constructor');
  eq(result.engine.backend, 'acp', 'engine.backend');
});

test('acp_status：ranges / messages 视图', async () => {
  const { session, seqs } = doubleFixture();
  const { tool } = installTools(registerStatusTool);
  const agent = { session };

  const ranges = await run(tool('acp_status'), { view: 'ranges' }, agent);
  eq(ranges.view, 'ranges', 'view');
  eqArray(ranges.blocks[0].shadowedSeqs, [seqs.one, seqs.two, seqs.tool], 'ranges.seqs');
  eq(Object.hasOwn(ranges.blocks[0], 'preview'), false, 'ranges 不带 preview');

  const messages = await run(tool('acp_status'), { view: 'messages' }, agent);
  eq(messages.view, 'messages', 'view');
  assert(messages.blocks[1].text.includes('第二层摘要'), 'messages 应有全文');
  eq(Object.hasOwn(messages.blocks[1], 'preview'), false, 'messages 视图不带 preview');
});

test('acp_status：limit 只截 blocks，totals/checkpoints 仍基于全部块', async () => {
  const { session } = doubleFixture();
  const { tool } = installTools(registerStatusTool);
  const result = await run(tool('acp_status'), { limit: 1 }, { session });
  eq(result.blocks.length, 1, 'blocks 被截断');
  eq(result.totals.summaries, 2, 'totals 不截断');
  eq(Object.keys(result.checkpoints).length, 2, 'checkpoints 不截断');
});

test('acp_status：context 视图尽力取 tokenMeter 与请求路由', async () => {
  const { session } = doubleFixture();
  const { tool } = installTools(registerStatusTool);
  const result = await run(tool('acp_status'), { scope: 'context' }, { session });
  eq(result.ok, true, 'ok');
  eq(result.scope, 'context', 'scope');
  eq(result.context.usedTokens, 4321, 'usedTokens');
  eq(result.context.provider, 'test-provider', 'provider');
  eq(result.context.model, 'test-model', 'model');
  assert(Array.isArray(result.blocks), 'context 视图仍返回 blocks');
});

test('acp_status：nudge 从共享 state 映射（含 lastSkipReason 优先）', async () => {
  const { session } = doubleFixture();
  const { tool } = installTools(registerStatusTool);
  const agent = { session };

  stateOf(agent).lastNudge = { at: 123456, usedTokens: 90000, contextWindow: 100000, reason: 'pressure' };
  const nudged = await run(tool('acp_status'), {}, agent);
  eq(nudged.nudge.state, 'nudged', 'state');
  eq(nudged.nudge.reason, 'pressure', 'reason');
  eq(nudged.nudge.nextAt, 123456, 'nextAt');

  stateOf(agent).lastSkipReason = 'cooldown';
  const skipped = await run(tool('acp_status'), {}, agent);
  eq(skipped.nudge.reason, 'cooldown', 'lastSkipReason 优先');
  eq(skipped.nudge.state, 'nudged', 'state 仍为 nudged');
});

test('acp_status：内部异常收口为 internal，不向工具框架抛错', async () => {
  const { session } = doubleFixture();
  const { tool } = installTools(registerStatusTool, {
    resolveEngine: () => { throw new Error('engine exploded'); },
    tokenMeter: () => { throw new Error('meter exploded'); },
  });
  const result = await run(tool('acp_status'), { scope: 'context' }, { session });
  eq(result.ok, true, 'engine/meter 故障不影响状态');
  eq(result.context.usedTokens, null, '拿不到 meter 时 usedTokens=null');
  eq(result.engine.constructor, null, '拿不到 engine 时 constructor=null');
});

// ── runner ───────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`❌ ${name}\n   ${String(error?.message ?? error).replace(/\n/g, '\n   ')}`);
  }
}

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} ${passed}/${tests.length}`);
process.exit(failures.length === 0 ? 0 : 1);
