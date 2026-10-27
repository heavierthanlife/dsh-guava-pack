#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/tests/acp-engine.mjs — P1 单元门禁（纯 Node ESM，零依赖）。
 *
 * ## 为什么用真实 Cordis Context + 真实 Session，而不是 mock
 *
 * 这一层最容易出错的地方恰恰是"我以为的 API 形状"：`session.surface.nodes` 是
 * 位置数组、`append` 的第三个参数是 `{ surfaceOp: 'append' }` 字符串、
 * `session.deriveEventMessage()` 才是消息投影入口。用 fake 对象测出来的绿是假绿。
 * 所以引擎用真实 `new Context()` 构造，会话用真实 `Session.create()` + 真实
 * `append()` 种历史；只有 LLM 被刻意排除（假 agent 没有可用路由）——这同时证明
 * 自写摘要路径**零额外模型调用**。
 *
 * ## 覆盖范围
 *
 *   1. AcpEngine：staged 摘要（取走即删、覆盖幂等、按 agent 隔离）、
 *      summarize 的两种分支、compactIfNeeded 的 pressure 短路（不碰 tokenMeter）。
 *   2. barriers：活动用户消息 / AGENTS.md 当前副本 / skill 目录当前副本 /
 *      system 节点；旧副本放行；policy 开关；多点同时命中。
 *   3. planCompress：成功形状、missing（缺失/反序）、protected、no-gain、
 *      meter 形状不符时跳过收益检查、工具配对不平衡、纯函数不改 surface。
 *
 * 用法：`node tools/tests/acp-engine.mjs`（退出码 0 = 全过）。
 *
 * @module tools/tests/acp-engine
 */

import { Context } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

import { AcpEngine } from '../../plugins/dsh-context-acp/lib/engine.mjs';
import { PROTECTED_CODES, checkProtectedRange } from '../../plugins/dsh-context-acp/lib/barriers.mjs';
import { COMPRESS_CODES, planCompress } from '../../plugins/dsh-context-acp/lib/tools-compress.mjs';

// ── 极简断言/收集器（零依赖，失败只影响当前 case） ─────────────────────────────

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

/** 严格相等断言（附期望/实际，方便排错）。 */
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

// ── 会话/断言夹具 ─────────────────────────────────────────────────────────────

/** 建一个干净的、未挂任何 provider 的会话。 */
function newSession() {
  return Session.create('session-test');
}

/** 追加 system prompt（surface 第 0 节点的合法来源）。 */
function appendSystem(session, text) {
  return session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage(text),
  }, { surfaceOp: 'append' }).seq;
}

/** 追加一条 user/message（默认 source.kind = 'user'，即真实用户输入）。 */
function appendUser(session, text, source = { kind: 'user' }) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source,
  }), { surfaceOp: 'append' }).seq;
}

/** 在 surface 里定位一个 seq 的下标。 */
function at(session, seq) {
  const index = session.surface.nodes.indexOf(seq);
  assert(index >= 0, `seq ${seq} 不在 surface 上（夹具构造有问题）`);
  return index;
}

/** 构造 barrier 夹具：system + 两代策略文件 + 两代 skill 目录 + 两条用户消息。 */
function barrierFixture() {
  const session = newSession();
  const seqs = {
    system: appendSystem(session, 'SYSTEM PROMPT'),
    userOld: appendUser(session, '更早的用户消息'),
    instructionsOld: appendUser(session, 'AGENTS.md baseline 1', { kind: 'agent-instructions', baseline: true, changes: [] }),
    instructionsNew: appendUser(session, 'AGENTS.md baseline 2', { kind: 'agent-instructions', baseline: true, changes: [] }),
    skillOld: appendUser(session, '<available_skills>old</available_skills>', { kind: 'skill-catalog', entries: [] }),
    // 新版注入可能换 kind：文本标记是契约的一部分，所以这里故意不用 skill-catalog。
    skillNew: appendUser(session, '<available_skills>new</available_skills>', { kind: 'runtime-context' }),
    userNew: appendUser(session, '当前用户消息'),
  };
  return { session, seqs };
}

/** 构造 planCompress 夹具：system + 三条用户消息。 */
function planFixture() {
  const session = newSession();
  const seqs = {
    system: appendSystem(session, 'SYSTEM PROMPT'),
    one: appendUser(session, '第一条'),
    two: appendUser(session, '第二条'),
    three: appendUser(session, '第三条（最新）'),
  };
  return { session, seqs };
}

/** 单个 seq 的区间检查。 */
function guardOne(session, seq, policy = {}) {
  const index = at(session, seq);
  return checkProtectedRange({ session, startIdx: index, endIdx: index, policy });
}

/** 区间检查（按 seq 端点换算成下标）。 */
function guardRange(session, startSeq, endSeq, policy = {}) {
  return checkProtectedRange({
    session,
    startIdx: at(session, startSeq),
    endIdx: at(session, endSeq),
    policy,
  });
}

const ALL_OFF = Object.freeze({
  protectActiveUserMessage: false,
  protectAgentInstructions: false,
  protectSkillCatalog: false,
});

// ── 1. AcpEngine：staged 摘要通道 ─────────────────────────────────────────────

test('staged 摘要：取走一次后删除，重复 stage 覆盖不抛错', () => {
  const engine = new AcpEngine(new Context(), {});
  const agent = { tag: 'agent-a' };

  engine.stageSummary(agent, { summary: 'first', provider: 'p1', model: 'm1' });
  // 幂等覆盖：同一 agent 的旧槽应被顶掉，而不是抛 "already staged"。
  engine.stageSummary(agent, { summary: 'second', provider: 'p2', model: 'm2' });

  const taken = engine.takeStagedSummary(agent);
  eq(taken?.summary, 'second', '覆盖后的摘要');
  eq(taken?.provider, 'p2', 'provider');
  eq(taken?.model, 'm2', 'model');
  eq(engine.takeStagedSummary(agent), undefined, '第二次 take 应为 undefined（取走即删）');
  return 'overwrite + take-once';
});

test('staged 摘要：按 agent 隔离，clearStagedSummary 丢弃', () => {
  const engine = new AcpEngine(new Context(), {});
  const a = { tag: 'a' };
  const b = { tag: 'b' };

  engine.stageSummary(a, { summary: 'A' });
  engine.stageSummary(b, { summary: 'B' });
  eq(engine.takeStagedSummary(a)?.summary, 'A', 'agent a 的摘要');
  eq(engine.takeStagedSummary(b)?.summary, 'B', 'agent b 的摘要');

  engine.stageSummary(a, { summary: 'A2' });
  engine.clearStagedSummary(a);
  eq(engine.takeStagedSummary(a), undefined, 'clear 后不可再取');
  return 'per-agent WeakMap';
});

test('staged 摘要：经 Cordis service Proxy 调用仍然工作（不能用 # 私有字段）', () => {
  // 生产路径拿到的是 `ctx.compaction` / `agentPresets.serviceFor()` 返回的
  // traceable Proxy，方法调用时 `this` 不是声明类实例。`#staged` 会在这里抛
  // "Cannot read private member ..."；本用例锁死这条回归。
  const ctx = new Context();
  const engine = new AcpEngine(ctx, {});
  const viaService = ctx.compaction;
  assert(viaService !== engine, 'ctx.compaction 应是 Cordis 包装后的 Proxy');
  eq(viaService?.constructor?.name, 'AcpEngine', 'proxy 的 constructor 名');

  const agent = { tag: 'proxy-agent' };
  viaService.stageSummary(agent, { summary: 'proxy 路径摘要', provider: 'p', model: 'm' });
  eq(viaService.takeStagedSummary(agent)?.summary, 'proxy 路径摘要', '经 Proxy 取回的摘要');
  return 'works through traceable proxy';
});

test('summarize：有 staged 时返回 text 摘要且 llmStreamCall 未设置', async () => {
  const engine = new AcpEngine(new Context(), {});
  const agent = { tag: 'agent-summarize' };
  engine.stageSummary(agent, { summary: '模型自写的摘要', provider: 'route-p', model: 'route-m' });

  const result = await engine.summarize({ messages: [] }, agent, undefined);
  assert(Array.isArray(result.summary), 'summary 必须是 ContentBlock[]');
  eq(result.summary.length, 1, 'summary block 数');
  eq(result.summary[0].type, 'text', 'block 类型');
  eq(result.summary[0].text, '模型自写的摘要', 'block 文本');
  eq(result.provider, 'route-p', 'provider');
  eq(result.model, 'route-m', 'model');
  eq(result.llmStreamCall, undefined, 'llmStreamCall（自写摘要不得标记为 ctx.llm.stream 调用）');
  return 'text block, no llmStreamCall';
});

test('summarize：无 staged 且无可用路由时抛错，且不调用 LLM', async () => {
  const engine = new AcpEngine(new Context(), {});
  // 刻意没有 ctx.llm：任何真实流式调用都会以 TypeError 失败；我们要求的是
  // 在进入 LLM 之前就因"没有 provider/model"而拒绝。
  eq(engine.ctx.llm, undefined, '裸 Context 不应有 llm 服务');

  const agentWithoutRoute = {
    options: {},
    session: { id: 'session-test', requestHeader: () => undefined, toolHistory: () => [] },
  };
  let caught;
  try {
    await engine.summarize({ messages: [] }, agentWithoutRoute, undefined);
  } catch (error) {
    caught = error;
  }
  assert(caught !== undefined, '无 staged / 无 target 时必须抛错，不能静默返回');
  assert(/no provider\/model/i.test(String(caught.message)), `错误应是"没有可用路由"，实际：${caught.message}`);
  return caught.message;
});

test('compactIfNeeded：backend=acp + pressure 直接返回 null，不触碰 tokenMeter', async () => {
  const base = new Context();
  // 任何对 tokenMeter 的读取都会抛错：这是"父类事务才记账"的可执行证明。
  const guardedCtx = new Proxy(base, {
    get(target, property) {
      if (property === 'tokenMeter') throw new Error('tokenMeter touched');
      return Reflect.get(target, property, target);
    },
  });
  const engine = new AcpEngine(guardedCtx, {});
  eq(engine.backend, 'acp', 'backend');

  let touched = false;
  try {
    guardedCtx.tokenMeter;
  } catch {
    touched = true;
  }
  assert(touched, '探针自身应能触发 tokenMeter 访问异常');

  const result = await engine.compactIfNeeded(
    { options: {}, session: {} },
    'pressure',
    new AbortController().signal,
  );
  eq(result, null, 'pressure 自动压缩结果');
  return 'null without meter';
});

// ── 2. barriers：受保护区判定 ─────────────────────────────────────────────────

test('barriers：最后一条真实用户消息被保护', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardOne(session, seqs.userNew);
  eq(guard.ok, false, 'ok');
  eq(guard.protected.length, 1, '命中数');
  eq(guard.protected[0].seq, seqs.userNew, '命中 seq');
  eq(guard.protected[0].code, PROTECTED_CODES.ACTIVE_USER, 'code');
  return guard.protected[0].code;
});

test('barriers：更早的用户消息可以压', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardOne(session, seqs.userOld);
  eq(guard.ok, true, 'ok');
  eq(guard.protected.length, 0, '命中数');
  return 'old user compressible';
});

test('barriers：最新 agent-instructions 被保护', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardOne(session, seqs.instructionsNew);
  eq(guard.ok, false, 'ok');
  eq(guard.protected[0]?.code, PROTECTED_CODES.AGENTS_COPY, 'code');
  eq(guard.protected[0]?.seq, seqs.instructionsNew, 'seq');
  return guard.protected[0].code;
});

test('barriers：更早的 agent-instructions 副本可以压', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardOne(session, seqs.instructionsOld);
  eq(guard.ok, true, 'ok（旧副本不再是当前副本）');
  return 'superseded baseline compressible';
});

test('barriers：最新 skill 目录被保护（文本标记判定，即使 source.kind 变了）', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardOne(session, seqs.skillNew);
  eq(guard.ok, false, 'ok');
  eq(guard.protected[0]?.code, PROTECTED_CODES.SKILL_CATALOG, 'code');
  eq(guard.protected[0]?.seq, seqs.skillNew, 'seq');
  return guard.protected[0].code;
});

test('barriers：更早的 skill 目录副本可以压', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardOne(session, seqs.skillOld);
  eq(guard.ok, true, 'ok（旧目录已被新目录取代）');
  return 'superseded skills compressible';
});

test('barriers：含 surface 第 0 个节点（system）的区间恒被保护', () => {
  const { session, seqs } = barrierFixture();
  // 即使三个可配开关全关，system 也必须保护。
  const guard = checkProtectedRange({
    session,
    startIdx: 0,
    endIdx: 0,
    policy: ALL_OFF,
  });
  eq(guard.ok, false, 'ok');
  eq(guard.protected[0]?.code, PROTECTED_CODES.SYSTEM_PROMPT, 'code');
  eq(guard.protected[0]?.seq, seqs.system, 'seq');
  return guard.protected[0].code;
});

test('barriers：宽区间一次性点名所有受保护节点', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardRange(session, seqs.userOld, seqs.userNew);
  eq(guard.ok, false, 'ok');
  const codes = guard.protected.map((hit) => hit.code);
  eqArray(codes, [
    PROTECTED_CODES.AGENTS_COPY,
    PROTECTED_CODES.SKILL_CATALOG,
    PROTECTED_CODES.ACTIVE_USER,
  ], 'protected codes');
  return codes.join(', ');
});

test('barriers：policy 三个开关全关时历史区间放行', () => {
  const { session, seqs } = barrierFixture();
  const guard = guardRange(session, seqs.userOld, seqs.userNew, ALL_OFF);
  eq(guard.ok, true, 'ok');
  eq(guard.protected.length, 0, '命中数');
  return 'policy off => no hits';
});

// ── 3. planCompress：纯规划 ───────────────────────────────────────────────────

test('planCompress：中间区间成功，且不修改 surface', () => {
  const { session, seqs } = planFixture();
  const before = [...session.surface.nodes];
  const plan = planCompress({ session, startSeq: seqs.one, endSeq: seqs.two, summary: '合并摘要' });
  eq(plan.ok, true, 'ok');
  eq(plan.tier, 1, 'tier');
  eq(plan.startIdx, at(session, seqs.one), 'startIdx');
  eq(plan.endIdx, at(session, seqs.two), 'endIdx');
  eqArray(plan.shadowedSeqs, [seqs.one, seqs.two], 'shadowedSeqs');
  eqArray([...session.surface.nodes], before, 'surface nodes（纯函数不得改 session）');
  return `tokens=${plan.shadowedTokens}`;
});

test('planCompress：startSeq 不存在 → missing', () => {
  const { session, seqs } = planFixture();
  const plan = planCompress({ session, startSeq: 999999, endSeq: seqs.two, summary: 'x' });
  eq(plan.ok, false, 'ok');
  eq(plan.code, 'missing', 'code');
  assert(COMPRESS_CODES.includes(plan.code), 'code 必须在 COMPRESS_CODES 内');
  return plan.message;
});

test('planCompress：endSeq 不存在 → missing', () => {
  const { session, seqs } = planFixture();
  const plan = planCompress({ session, startSeq: seqs.one, endSeq: -1, summary: 'x' });
  eq(plan.ok, false, 'ok');
  eq(plan.code, 'missing', 'code');
  return plan.message;
});

test('planCompress：start/end 反了 → missing（消息说明反了）', () => {
  const { session, seqs } = planFixture();
  const plan = planCompress({ session, startSeq: seqs.two, endSeq: seqs.one, summary: 'x' });
  eq(plan.ok, false, 'ok');
  eq(plan.code, 'missing', 'code');
  assert(/反了/.test(plan.message), `message 应说明区间反了，实际：${plan.message}`);
  return plan.message;
});

test('planCompress：含最新用户消息 → protected', () => {
  const { session, seqs } = planFixture();
  const plan = planCompress({ session, startSeq: seqs.two, endSeq: seqs.three, summary: 'x' });
  eq(plan.ok, false, 'ok');
  eq(plan.code, 'protected', 'code');
  assert(plan.message.includes('protected-active-user'), `message 应点名 code，实际：${plan.message}`);
  assert(plan.message.includes(String(seqs.three)), `message 应点名 seq，实际：${plan.message}`);
  return plan.message;
});

test('planCompress：摘要不比原文小 → no-gain', () => {
  const { session, seqs } = planFixture();
  const hugeMeter = {
    estimateMessage: () => 9999,
    measure: (target) => ({ nodes: target.surface.nodes.map((seq) => ({ seq, tokens: 1, heuristicTokens: 1 })) }),
  };
  const plan = planCompress({
    session,
    startSeq: seqs.one,
    endSeq: seqs.two,
    summary: 'x'.repeat(8000),
    meter: hugeMeter,
  });
  eq(plan.ok, false, 'ok');
  eq(plan.code, 'no-gain', 'code');
  return plan.message;
});

test('planCompress：meter 形状不符时跳过收益检查（交父类判定）', () => {
  const { session, seqs } = planFixture();
  const malformedMeter = {
    estimateMessage: () => 9999,
    measure: () => ({ nodes: [] }),
  };
  const plan = planCompress({
    session,
    startSeq: seqs.one,
    endSeq: seqs.two,
    summary: 'x'.repeat(8000),
    meter: malformedMeter,
  });
  eq(plan.ok, true, 'ok（形状不符不能得出 no-gain 结论）');
  return 'skipped gain check';
});

test('planCompress：meter 可用时给出 shadowedTokens / summaryTokens', () => {
  const { session, seqs } = planFixture();
  const meter = {
    estimateMessage: () => 2,
    measure: (target) => ({ nodes: target.surface.nodes.map((seq) => ({ seq, tokens: 5, heuristicTokens: 5 })) }),
  };
  const plan = planCompress({
    session,
    startSeq: seqs.one,
    endSeq: seqs.two,
    summary: 'ok',
    meter,
  });
  eq(plan.ok, true, 'ok');
  eq(plan.shadowedTokens, 10, 'shadowedTokens（两个节点 × 5）');
  eq(plan.summaryTokens, 2, 'summaryTokens');
  return `shadowed=${plan.shadowedTokens}, summary=${plan.summaryTokens}`;
});

test('planCompress：会劈开 tool-call/result 配对 → unbalanced', () => {
  const session = newSession();
  const user = appendUser(session, '开始前');
  // 一个未收到 tool/result 的 assistant tool-call：右边界在它之后不平衡。
  const assistant = session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }],
      source: { provider: 'p', model: 'm' },
    }),
  }, { surfaceOp: 'append' }).seq;

  const plan = planCompress({ session, startSeq: user, endSeq: assistant, summary: 'x' });
  eq(plan.ok, false, 'ok');
  eq(plan.code, 'unbalanced', 'code');
  return plan.message;
});

test('planCompress：空摘要 → missing（不得靠 stageSummary 抛异常兜底）', () => {
  const { session, seqs } = planFixture();
  const plan = planCompress({ session, startSeq: seqs.one, endSeq: seqs.two, summary: '   ' });
  eq(plan.ok, false, 'ok');
  eq(plan.code, 'missing', 'code');
  return plan.message;
});

// ── 运行 ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`✅ ${name}${typeof detail === 'string' && detail.length > 0 ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(name);
    console.log(`❌ ${name} — ${error?.message ?? error}`);
  }
}

console.log(`\nPASS ${passed}/${tests.length}`);
if (failures.length > 0) {
  console.log(`失败用例：${failures.join('、')}`);
  process.exit(1);
}
