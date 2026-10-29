#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/tests/acp-nudge.mjs — P3 nudge / 提示段 / 命令 / 面板设置门禁。
 *
 * 覆盖：
 *   1. decideNudge 六种 reason（no-pressure / below-threshold / turn-cap /
 *      cooldown / insufficient-growth / pressure）与 nextState；
 *   2. renderNudge 的 `[acp-nudge]`、百分比、块数、稳定性；
 *   3. installNudge：注入一条带合法 source 的 user 消息（agent-loop 会读
 *      source.kind 并写日志）、state 记账、低于阈值不注入、turn 复位、引擎缺失
 *      时 armed=false、tokenMeter 兜底路径；
 *   4. parseAcpCommand；
 *   5. applyTunables 的夹取/忽略/纯函数性；
 *   6. installCommand 的 status/blocks/nudge/help 与解析错误；
 *   7. contextAcp 投影：tier 推导、纯 fold、wire 字段；
 *   8. PROMPT_SECTION 内容；
 *   9. createNudgeHandler 工厂 + 提醒消息能被真实 Session 接受；
 *  10. installPanel 路由：getSettings 信封与 setSettings 夹取/落盘。
 *
 * 用假 deps / 假 session，不启动 DSH、不碰 live profile。零依赖（只用 node 内置
 * 与仓库内模块），退出码 0 = 全过。
 *
 * 用法：`node tools/tests/acp-nudge.mjs`
 *
 * @module tools/tests/acp-nudge
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNudgeHandler, decideNudge, installNudge, renderNudge } from '../../plugins/dsh-context-acp/lib/nudge.mjs';
import { installCommand, parseAcpCommand } from '../../plugins/dsh-context-acp/lib/command.mjs';
import { applyTunables, installPanel } from '../../plugins/dsh-context-acp/lib/settings.mjs';
import { PROMPT_SECTION } from '../../plugins/dsh-context-acp/lib/prompt.mjs';
import { recordNudge, snapshot, stateOf } from '../../plugins/dsh-context-acp/lib/state.mjs';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

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

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const NUDGE = Object.freeze({
  pressureRatio: 0.65,
  growthTokens: 12000,
  cooldownSteps: 6,
  maxPerTurn: 2,
});

function baseState(overrides = {}) {
  return Object.freeze({
    lastNudgeStep: -1,
    lastNudgeTokens: 0,
    turnNudges: 0,
    lastTurn: 1,
    ...overrides,
  });
}

/** 假 pre-step context：只实现本插件用到的 on/get。 */
function makeCtx({ get } = {}) {
  const handlers = {};
  return {
    handlers,
    on(event, fn) {
      handlers[event] = fn;
      return () => {
        delete handlers[event];
      };
    },
    get: get ?? (() => undefined),
  };
}

/** 假 agent：session 只给空日志（nudge 的账本读取只需要它）。 */
function makeAgent(options = {}) {
  return {
    session: { snapshotEvents: () => [] },
    options,
  };
}

/** 安装 nudge 并返回 handler + disposer。 */
function installNudgeFor(overrides = {}, ctxOptions = {}) {
  const ctx = overrides.ctx ?? makeCtx(ctxOptions);
  const deps = {
    ctx,
    runtime: { backend: 'acp', nudge: NUDGE },
    logger: { warn() {}, info() {} },
    resolveEngine: () => ({ stageSummary() {} }),
    tokenMeter: () => undefined,
    ...overrides,
    ctx,
  };
  const dispose = installNudge(deps);
  return { handler: ctx.handlers['agent/pre-step'], dispose, deps, ctx };
}

/** pre-step 的默认 next()：返回一条原始消息的 enter decision。 */
function enterDecision(messages = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }]) {
  return async () => ({ kind: 'enter', messages });
}

/** 调一次 pre-step。 */
function preStep(handler, agent, { turn, step, kind = 'enter' } = {}) {
  const next = kind === 'enter'
    ? enterDecision()
    : async () => ({ kind });
  return handler(
    { agent, messages: [], turn, step, signal: new AbortController().signal },
    next,
  );
}

/** 构造一段两次压缩的日志（b2 压掉 b1 的 checkpoint → tier 2）。 */
function makeLedgerSession() {
  const events = [];
  const push = (type, data) => {
    const seq = events.length;
    events.push({ seq, time: 1_700_000_000_000 + seq * 1000, type, data });
    return seq;
  };

  const one = push('user/message', { content: [{ type: 'text', text: 'alpha' }] });
  const two = push('user/message', { content: [{ type: 'text', text: 'beta' }] });
  push('compaction/start', { compactionId: 'c1' });
  push('compaction/summary', {
    compactionId: 'c1',
    summary: [{ type: 'text', text: '第一层摘要' }],
    shadowedRange: { start: one, end: two },
    shadowedSeqs: [one, two],
    shadowedTokenCount: 111,
    provider: 'test-provider',
    model: 'test-model',
  });
  const checkpoint1 = push('user/message', {
    source: { kind: 'compact-checkpoint', compactionId: 'c1' },
    content: [{ type: 'text', text: 'CHECKPOINT c1' }],
  });
  push('compaction/end', { compactionId: 'c1' });

  const three = push('user/message', { content: [{ type: 'text', text: 'gamma' }] });
  push('compaction/start', { compactionId: 'c2' });
  push('compaction/summary', {
    compactionId: 'c2',
    summary: [{ type: 'text', text: '第二层摘要' }],
    shadowedRange: { start: checkpoint1, end: three },
    shadowedSeqs: [checkpoint1, three],
    shadowedTokenCount: 222,
    provider: 'test-provider',
    model: 'test-model',
  });
  push('user/message', { source: { kind: 'compact-checkpoint', compactionId: 'c2' }, content: [] });
  push('compaction/end', { compactionId: 'c2' });

  return { snapshotEvents: () => events };
}

/** 捕获 installCommand 注册的 definition。 */
function captureCommand(runtime = { backend: 'acp' }, handoff = undefined) {
  let definition;
  const cctx = {
    commands: {
      register(candidate) {
        definition = candidate;
        return () => {};
      },
    },
  };
  const ctx = {
    inject(_services, callback) {
      callback(cctx);
      return { dispose() {} };
    },
  };
  const dispose = installCommand({ ctx, runtime, logger: { warn() {} }, handoff });
  return { definition, dispose };
}

/** 捕获 installPanel 注册的投影定义（路由用最小壳接住）。 */
function captureProjection() {
  let projection;
  const projectionCtx = {
    sessionProjections: {
      register(definition) {
        projection = definition;
        return () => {};
      },
    },
  };
  const routeCtx = {
    effect(factory) {
      factory();
    },
    webServer: {
      register() {
        return () => {};
      },
    },
    connection: {
      requestRejection() {
        return undefined;
      },
    },
  };
  const ctx = {
    inject(services, callback) {
      callback(services.includes('sessionProjections') ? projectionCtx : routeCtx);
      return { dispose() {} };
    },
  };
  installPanel({
    ctx,
    runtime: {
      backend: 'acp',
      nudge: { pressureRatio: 0.65, growthTokens: 12000 },
      retain: { decompressPageSize: 8, searchLimit: 20 },
    },
    logger: { warn() {} },
  });
  return projection;
}

/** 捕获 installPanel 注册的 webServer 路由（投影用最小壳接住）。 */
function capturePanelRoute() {
  let route;
  const projectionCtx = {
    sessionProjections: {
      register() {
        return () => {};
      },
    },
  };
  const routeCtx = {
    effect(factory) {
      factory();
    },
    webServer: {
      register(options) {
        route = options;
        return () => {};
      },
    },
    connection: {
      requestRejection() {
        return undefined;
      },
    },
  };
  const deps = {
    ctx: {
      inject(services, callback) {
        callback(services.includes('sessionProjections') ? projectionCtx : routeCtx);
        return { dispose() {} };
      },
    },
    runtime: {
      backend: 'acp',
      nudge: { pressureRatio: 0.65, growthTokens: 12000, cooldownSteps: 6 },
      retain: { decompressPageSize: 8, searchLimit: 20 },
    },
    logger: { warn() {} },
  };
  installPanel(deps);
  return { route, deps };
}

/** 向捕获到的路由发一个 client-request，返回解析后的 server-response 信封。 */
async function callRoute(route, method, payload, rpcId = 'r1') {
  let responseBody = '';
  const req = {
    method: 'POST',
    url: `/context-acp/${method}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ type: 'client-request', method, payload, rpcId }));
    },
  };
  const res = {
    writeHead() {},
    end(data) {
      responseBody = typeof data === 'string' ? data : String(data ?? '');
    },
  };
  await route.handler(req, res);
  return JSON.parse(responseBody);
}

// ── 1. decideNudge ───────────────────────────────────────────────────────────

test('decideNudge：no-pressure（非有限/非正数）', () => {
  for (const pressure of [
    { usedTokens: Number.NaN, contextWindow: 100_000 },
    { usedTokens: 80_000, contextWindow: 0 },
    { usedTokens: -1, contextWindow: 100_000 },
    { usedTokens: undefined, contextWindow: 100_000 },
  ]) {
    const result = decideNudge({ ...pressure, nudge: NUDGE, state: baseState(), step: 3 });
    eq(result.nudge, false, 'nudge');
    eq(result.reason, 'no-pressure', 'reason');
    eq(result.nextState.turnNudges, 0, 'nextState.turnNudges');
    eq(result.nextState.lastNudgeStep, -1, 'nextState.lastNudgeStep');
  }
});

test('decideNudge：below-threshold', () => {
  const state = baseState({ lastNudgeStep: 2, lastNudgeTokens: 5000, turnNudges: 1 });
  const result = decideNudge({ usedTokens: 50_000, contextWindow: 100_000, nudge: NUDGE, state, step: 9 });
  eq(result.nudge, false, 'nudge');
  eq(result.reason, 'below-threshold', 'reason');
  eq(result.nextState.turnNudges, 1, 'nextState.turnNudges 不变');
  eq(result.nextState.lastNudgeStep, 2, 'nextState.lastNudgeStep 不变');
});

test('decideNudge：turn-cap', () => {
  const state = baseState({ turnNudges: 2 });
  const result = decideNudge({ usedTokens: 80_000, contextWindow: 100_000, nudge: NUDGE, state, step: 9 });
  eq(result.reason, 'turn-cap', 'reason');
  eq(result.nextState.turnNudges, 2, 'nextState.turnNudges');
});

test('decideNudge：cooldown', () => {
  const state = baseState({ lastNudgeStep: 2, lastNudgeTokens: 70_000, turnNudges: 1 });
  const result = decideNudge({ usedTokens: 90_000, contextWindow: 100_000, nudge: NUDGE, state, step: 5 });
  eq(result.reason, 'cooldown', 'reason');
  eq(result.nudge, false, 'nudge');
});

test('decideNudge：insufficient-growth', () => {
  const state = baseState({ lastNudgeStep: 0, lastNudgeTokens: 76_000, turnNudges: 1 });
  const result = decideNudge({ usedTokens: 80_000, contextWindow: 100_000, nudge: NUDGE, state, step: 10 });
  eq(result.reason, 'insufficient-growth', 'reason');
  eq(result.nudge, false, 'nudge');
});

test('decideNudge：pressure，nextState 记 step/tokens 且 turnNudges+1', () => {
  const state = baseState({ lastTurn: 7 });
  const result = decideNudge({ usedTokens: 80_000, contextWindow: 100_000, nudge: NUDGE, state, step: 11 });
  eq(result.nudge, true, 'nudge');
  eq(result.reason, 'pressure', 'reason');
  eq(result.nextState.lastNudgeStep, 11, 'nextState.lastNudgeStep');
  eq(result.nextState.lastNudgeTokens, 80_000, 'nextState.lastNudgeTokens');
  eq(result.nextState.turnNudges, 1, 'nextState.turnNudges');
  eq(result.nextState.lastTurn, 7, 'nextState.lastTurn 保留');
  // 输入 state 不被修改（Object.freeze 会在这里抛错）。
  eq(state.turnNudges, 0, '原 state 不变');
});

// ── 2. renderNudge ───────────────────────────────────────────────────────────

test('renderNudge：含 [acp-nudge]/百分比/块数/tier，且稳定可缓存', () => {
  const text = renderNudge({ usedTokens: 82_000, contextWindow: 100_000, blocks: 3, tierMax: 2 });
  assert(text.includes('[acp-nudge]'), '必须含字面量 [acp-nudge]');
  assert(text.includes('82%'), `应含百分比 82%：${text.slice(0, 80)}`);
  assert(text.includes('已压 3 块'), '应含块数');
  assert(text.includes('最高 tier 2'), '应含最高 tier');
  assert(text.includes('acp_status') && text.includes('compress'), '应给出 acp_status/compress 操作');
  assert(text.includes('decompress') && text.includes('search_context'), '应说明原文可取回');
  assert(text.includes('不要压缩策略文件'), '应说明策略文件不可压');
  eq(renderNudge({ usedTokens: 82_000, contextWindow: 100_000, blocks: 3, tierMax: 2 }), text, '两次调用必须完全一致');
});

test('renderNudge：blocks 接受账本数组，tier 取最大值', () => {
  const text = renderNudge({
    usedTokens: 50_000,
    contextWindow: 100_000,
    blocks: [{ tier: 1 }, { tier: 3 }],
  });
  assert(text.includes('已压 2 块'), '块数来自数组长度');
  assert(text.includes('最高 tier 3'), 'tier 来自数组最大值');
});

// ── 3. installNudge ──────────────────────────────────────────────────────────

test('installNudge：压力命中 → 注入带合法 source 的 user 消息并记账', async () => {
  const { handler, dispose } = installNudgeFor();
  const agent = makeAgent();
  process.env.DSH_ACP_TEST_PRESSURE = '80:100';
  try {
    const result = await preStep(handler, agent, { turn: 1, step: 2 });
    eq(result.kind, 'enter', 'kind');
    eq(result.messages.length, 2, 'messages.length');
    eq(result.messages[0].id, 'u1', '原始消息仍在');
    const injected = result.messages[1];
    eq(injected.role, 'user', '注入消息角色');
    assert(injected.content[0].text.includes('[acp-nudge]'), '注入文本应含 [acp-nudge]');
    // pre-step 的消息会被 dsh-agent-loop 原样 append 并读 source.kind，
    // 所以 source 必须是合法对象（P3 任务书的"不给 source"会让 turn 崩）。
    eq(injected.source.kind, 'context-acp', 'source.kind');
    eq(injected.source.form, 'notice', 'source.form');

    const state = snapshot(agent);
    eq(state.lastNudge.usedTokens, 80, 'lastNudge.usedTokens');
    eq(state.lastNudge.contextWindow, 100, 'lastNudge.contextWindow');
    eq(state.lastNudge.reason, 'pressure', 'lastNudge.reason');
    eq(state.lastNudgeStep, 2, 'lastNudgeStep');
    eq(state.turnNudges, 1, 'turnNudges');
  } finally {
    delete process.env.DSH_ACP_TEST_PRESSURE;
    dispose();
  }
});

test('installNudge：低于阈值不注入；turn 变化复位 turnNudges', async () => {
  const { handler, dispose } = installNudgeFor();
  const agent = makeAgent();
  process.env.DSH_ACP_TEST_PRESSURE = '80:100';
  try {
    await preStep(handler, agent, { turn: 1, step: 2 });
    eq(snapshot(agent).turnNudges, 1, '第一次 nudge 后计数 1');

    process.env.DSH_ACP_TEST_PRESSURE = '10:100';
    const low = await preStep(handler, agent, { turn: 1, step: 3 });
    eq(low.messages.length, 1, '低于阈值不注入');
    eq(snapshot(agent).lastSkipReason, 'below-threshold', 'lastSkipReason');
    eq(snapshot(agent).turnNudges, 1, '跳过不增加计数');

    // turn 2：即使压力仍然很低，resetTurn 也必须在判定前发生。
    const nextTurn = await preStep(handler, agent, { turn: 2, step: 1 });
    eq(nextTurn.messages.length, 1, '仍然不注入');
    eq(snapshot(agent).turnNudges, 0, '新 turn 已复位');
  } finally {
    delete process.env.DSH_ACP_TEST_PRESSURE;
    dispose();
  }
});

test('installNudge：result.kind!=="enter" 时不注入', async () => {
  const { handler, dispose } = installNudgeFor();
  const agent = makeAgent();
  process.env.DSH_ACP_TEST_PRESSURE = '80:100';
  try {
    const result = await preStep(handler, agent, { turn: 1, step: 2, kind: 'reject' });
    eq(result.kind, 'reject', 'kind 原样返回');
    eq(Object.hasOwn(result, 'messages'), false, 'reject 不带 messages');
    eq(snapshot(agent).lastNudge, null, '不应记账');
  } finally {
    delete process.env.DSH_ACP_TEST_PRESSURE;
    dispose();
  }
});

test('installNudge：引擎没有 stageSummary → armed=false + armed-missing', async () => {
  const { handler, dispose } = installNudgeFor({ resolveEngine: () => ({}) });
  const agent = makeAgent();
  process.env.DSH_ACP_TEST_PRESSURE = '80:100';
  try {
    const result = await preStep(handler, agent, { turn: 1, step: 2 });
    eq(result.messages.length, 1, '不注入');
    eq(snapshot(agent).armed, false, 'armed');
    eq(snapshot(agent).lastSkipReason, 'armed-missing', 'lastSkipReason');
  } finally {
    delete process.env.DSH_ACP_TEST_PRESSURE;
    dispose();
  }
});

test('installNudge：无测试钩子时走 tokenMeter + resolveModelInfo 兜底', async () => {
  delete process.env.DSH_ACP_TEST_PRESSURE;
  const { handler, dispose } = installNudgeFor(
    {
      tokenMeter: () => ({ measure: () => ({ totalTokens: 5000 }) }),
    },
    {
      get: (name) => (name === 'llm'
        ? { resolveModelInfo: async () => ({ context: { contextWindow: 10000 } }) }
        : undefined),
    },
  );
  const agent = makeAgent({ provider: 'test-provider', model: 'test-model' });
  try {
    const result = await preStep(handler, agent, { turn: 1, step: 1 });
    eq(result.messages.length, 1, '50% 低于阈值，不注入');
    eq(snapshot(agent).lastSkipReason, 'below-threshold', 'lastSkipReason');
  } finally {
    dispose();
  }
});

test('installNudge：内部异常不抛，记 lastError 并原样返回 result', async () => {
  const { handler, dispose } = installNudgeFor({
    resolveEngine: () => {
      throw new Error('engine exploded');
    },
  });
  const agent = makeAgent();
  process.env.DSH_ACP_TEST_PRESSURE = '80:100';
  try {
    const result = await preStep(handler, agent, { turn: 1, step: 2 });
    eq(result.kind, 'enter', 'turn 不被 nudge 弄挂');
    eq(result.messages.length, 1, '异常时不注入');
    const state = snapshot(agent);
    assert(state.lastError !== null, 'lastError 必须记录');
    assert(String(state.lastError.message).includes('engine exploded'), 'lastError.message');
  } finally {
    delete process.env.DSH_ACP_TEST_PRESSURE;
    dispose();
  }
});

// ── 4. parseAcpCommand ───────────────────────────────────────────────────────

test('parseAcpCommand：空输入/status/blocks/nudge', () => {
  eq(parseAcpCommand('').subcommand, 'status', '空输入');
  eq(parseAcpCommand('   ').subcommand, 'status', '纯空白');
  eq(parseAcpCommand('status').subcommand, 'status', 'status');
  eq(parseAcpCommand('blocks').subcommand, 'blocks', 'blocks');
  eq(parseAcpCommand('nudge').subcommand, 'nudge', 'nudge');
  eq(parseAcpCommand(' nudge ').subcommand, 'nudge', '前后空白');
});

test('parseAcpCommand：handoff 与 --force', () => {
  const plain = parseAcpCommand('handoff');
  eq(plain.subcommand, 'handoff', 'handoff');
  eq(plain.force, false, '默认不 force');
  eq(parseAcpCommand('handoff --force').force, true, '--force');
  eq(parseAcpCommand('handoff -f').force, true, '-f 别名');
  eq(parseAcpCommand(' handoff   --force ').subcommand, 'handoff', '前后空白');

  const bogusFlag = parseAcpCommand('handoff --now');
  eq(bogusFlag.subcommand, 'help', '不认识的 flag 回 help');
  assert(bogusFlag.error.includes('--force'), `error 应说明只接受 --force：${bogusFlag.error}`);
});

test('parseAcpCommand：未知子命令/多余参数 → error', () => {
  const unknown = parseAcpCommand('bogus');
  eq(unknown.subcommand, 'help', '未知子命令回 help');
  assert(unknown.error.includes('未知子命令'), `error：${unknown.error}`);
  assert(unknown.error.includes('bogus'), 'error 应点名');

  const extra = parseAcpCommand('status now');
  eq(extra.subcommand, 'help', '多余参数回 help');
  assert(extra.error.includes('多余的参数'), `error：${extra.error}`);
  assert(extra.error.includes('now'), 'error 应点名参数');
});

// ── 5. applyTunables ─────────────────────────────────────────────────────────

test('applyTunables：白名单夹取 + 返回新对象 + 不修改入参', () => {
  const base = {
    backend: 'acp',
    nudge: { pressureRatio: 0.65, growthTokens: 12000, cooldownSteps: 6, maxPerTurn: 2 },
    retain: { decompressPageSize: 8, searchLimit: 20, searchExcerptChars: 240 },
  };
  const { runtime, changed } = applyTunables(base, {
    nudge: { pressureRatio: 0.99, growthTokens: 1 },
    retain: { decompressPageSize: 0, searchLimit: 999 },
  });

  eq(runtime.nudge.pressureRatio, 0.95, 'pressureRatio 夹到 0.95');
  eq(runtime.nudge.growthTokens, 1000, 'growthTokens 夹到 1000');
  eq(runtime.retain.decompressPageSize, 8, '非法 pageSize=0 忽略');
  eq(runtime.retain.searchLimit, 50, 'searchLimit 夹到 50');
  eq(runtime.nudge.cooldownSteps, 6, '非白名单字段保留');
  eq(runtime.retain.searchExcerptChars, 240, 'retain 其它字段保留');
  eq(changed.pressureRatio, 0.95, 'changed.pressureRatio');
  eq(changed.growthTokens, 1000, 'changed.growthTokens');
  eq(changed.searchLimit, 50, 'changed.searchLimit');
  eq(Object.hasOwn(changed, 'decompressPageSize'), false, '被忽略的字段不进 changed');
  assert(runtime !== base, '返回新对象');
  assert(runtime.nudge !== base.nudge, 'nudge 也是新对象');
  eq(base.nudge.pressureRatio, 0.65, '入参未被修改');
  eq(base.retain.searchLimit, 20, '入参 retain 未被修改');
});

test('applyTunables：负值/非数字忽略，0.05 档四舍五入，扁平形状也接受', () => {
  const base = {
    nudge: { pressureRatio: 0.65, growthTokens: 12000 },
    retain: { decompressPageSize: 8, searchLimit: 20 },
  };
  const negative = applyTunables(base, {
    pressureRatio: -0.5,
    growthTokens: -1,
    decompressPageSize: -3,
    searchLimit: 0,
  });
  eq(negative.runtime.nudge.pressureRatio, 0.65, '负阈值忽略');
  eq(negative.runtime.nudge.growthTokens, 12000, '负增长忽略');
  eq(negative.runtime.retain.decompressPageSize, 8, '负分页忽略');
  eq(negative.runtime.retain.searchLimit, 20, '0 检索上限忽略');
  eq(Object.keys(negative.changed).length, 0, '没有字段被改变');

  const stringy = applyTunables(base, { pressureRatio: '0.9' });
  eq(stringy.runtime.nudge.pressureRatio, 0.65, '字符串忽略');

  const rounded = applyTunables(base, { pressureRatio: 0.73 });
  eq(rounded.runtime.nudge.pressureRatio, 0.75, '0.73 → 0.75');

  const roundedDown = applyTunables(base, { pressureRatio: 0.22 });
  eq(roundedDown.runtime.nudge.pressureRatio, 0.2, '0.22 → 0.2');

  const integers = applyTunables(base, { decompressPageSize: 51, searchLimit: 1.6 });
  eq(integers.runtime.retain.decompressPageSize, 50, '51 → 50');
  eq(integers.runtime.retain.searchLimit, 2, '1.6 → 2');
});

// ── 6. installCommand ───────────────────────────────────────────────────────

test('installCommand：status 摘要含块数/最老/最新/tier/backend', async () => {
  const { definition } = captureCommand();
  assert(definition !== undefined, '命令应注册');
  eq(definition.name, 'acp', '命令名');
  const agent = { session: makeLedgerSession() };
  const result = await definition.handler({ rawInput: 'status', agent });
  eq(result.kind, 'success', 'kind');
  assert(result.text.includes('块数：2'), `应含块数：${result.text}`);
  assert(result.text.includes('最老块：b1'), '应含最老块');
  assert(result.text.includes('最新块：b2'), '应含最新块');
  assert(result.text.includes('累计被压 tokens：333'), `应含累计 tokens：${result.text}`);
  assert(result.text.includes('最高 tier：2'), '应含最高 tier');
  assert(result.text.includes('backend=acp'), '应含引擎 backend');
});

test('installCommand：blocks 逐块一行', async () => {
  const { definition } = captureCommand();
  const agent = { session: makeLedgerSession() };
  const result = await definition.handler({ rawInput: 'blocks', agent });
  eq(result.kind, 'success', 'kind');
  assert(result.text.includes('b1 | tier1 | 111 tokens | seqs 0..1 | c1'), `b1 行：${result.text}`);
  assert(result.text.includes('b2 | tier2 | 222 tokens | seqs 4..6 | c2'), `b2 行：${result.text}`);
});

test('installCommand：help 返回用法（含 status|blocks|nudge|handoff）', async () => {
  const { definition } = captureCommand();
  const result = await definition.handler({ rawInput: 'help', agent: { session: makeLedgerSession() } });
  eq(result.kind, 'success', 'kind');
  assert(result.text.includes('/acp status|blocks|nudge|handoff'), `用法文本：${result.text}`);
  assert(result.text.includes('--force'), '应说明 --force');
});

test('installCommand：handoff 立即检查（未达阈值也如实报告还差几次）', async () => {
  const calls = [];
  const handoff = {
    async maybeHandoff(session, options) {
      calls.push({ id: session?.id, options });
      return { written: false, reason: 'below-threshold', compactions: 1, required: 2, sessionId: session?.id, at: 1 };
    },
  };
  const { definition } = captureCommand({ backend: 'acp' }, handoff);
  const agent = { session: makeLedgerSession() };
  const result = await definition.handler({ rawInput: 'handoff', agent });
  eq(calls.length, 1, '应调用一次写入器');
  eq(calls[0]?.options?.force, false, '不带 --force 时不强制');
  eq(result.kind, 'success', '未达阈值不是错误');
  assert(result.text.includes('未达阈值'), `应说明未达阈值：${result.text}`);
  assert(result.text.includes('1 次') && result.text.includes('2 次'), `应报出 1/2：${result.text}`);
  assert(result.text.includes('/acp handoff --force'), '应提示 --force');
});

test('installCommand：handoff --force 与写出后的文件路径', async () => {
  const calls = [];
  const handoff = {
    async maybeHandoff(_session, options) {
      calls.push(options);
      return { written: true, reason: 'written', file: '/tmp/x/HANDOFF-context-acp-abc12345-c1-20261029-120000.md' };
    },
  };
  const { definition } = captureCommand({ backend: 'acp' }, handoff);
  const result = await definition.handler({ rawInput: 'handoff --force', agent: { session: makeLedgerSession() } });
  eq(calls.length, 1, '应调用一次写入器');
  eq(calls[0]?.force, true, '--force 传给写入器');
  eq(result.kind, 'success', 'kind');
  assert(result.text.includes('已写出交接文档'), `文案：${result.text}`);
  assert(result.text.includes('HANDOFF-context-acp-abc12345-c1-'), '应给出文件路径');
});

test('installCommand：handoff 失败可见（禁用/写入失败 → kind=error）', async () => {
  const disabled = { async maybeHandoff() { return { written: false, reason: 'disabled' }; } };
  const off = await captureCommand({ backend: 'acp' }, disabled).definition.handler({ rawInput: 'handoff', agent: { session: makeLedgerSession() } });
  eq(off.kind, 'error', '禁用是错误态');
  assert(off.text.includes('已禁用'), `文案：${off.text}`);

  const failing = { async maybeHandoff() { return { written: false, reason: 'write-failed', error: 'EACCES', file: '/tmp/x.md' }; } };
  const failed = await captureCommand({ backend: 'acp' }, failing).definition.handler({ rawInput: 'handoff', agent: { session: makeLedgerSession() } });
  eq(failed.kind, 'error', '写入失败是错误态');
  assert(failed.text.includes('EACCES'), '错误原因要露出来');

  const missing = await captureCommand({ backend: 'acp' }, undefined).definition.handler({ rawInput: 'handoff', agent: { session: makeLedgerSession() } });
  eq(missing.kind, 'error', '没有写入器是错误态');
  assert(missing.text.includes('未装配'), `文案：${missing.text}`);
});

test('installCommand：nudge 无记录 / 有最近记录', async () => {
  const { definition } = captureCommand();
  const noRecord = await definition.handler({ rawInput: 'nudge', agent: { session: makeLedgerSession() } });
  eq(noRecord.kind, 'success', 'kind');
  assert(noRecord.text.includes('当前没有 nudge 记录'), `无记录文本：${noRecord.text}`);

  const agent = { session: makeLedgerSession() };
  stateOf(agent).lastNudge = { at: 1_700_000_000_000, usedTokens: 82_000, contextWindow: 100_000, reason: 'pressure' };
  const rendered = await definition.handler({ rawInput: 'nudge', agent });
  eq(rendered.kind, 'success', 'kind');
  assert(rendered.text.includes('[acp-nudge]'), '应渲染 nudge 文本');
  assert(rendered.text.includes('82%'), '应使用最近一次 nudge 的压力数字');
});

test('installCommand：解析错误与内部异常都返回 kind=error，不抛', async () => {
  const { definition } = captureCommand();
  const unknown = await definition.handler({ rawInput: 'bogus', agent: { session: makeLedgerSession() } });
  eq(unknown.kind, 'error', '未知子命令');
  assert(unknown.text.includes('未知子命令'), '错误文本点名');

  const extra = await definition.handler({ rawInput: 'status now', agent: { session: makeLedgerSession() } });
  eq(extra.kind, 'error', '多余参数');
  assert(extra.text.includes('多余的参数'), '错误文本点名');

  const noAgent = await definition.handler({ rawInput: 'status', agent: null });
  eq(noAgent.kind, 'error', '没有 agent');
  assert(noAgent.text.includes('/acp 失败'), `错误前缀：${noAgent.text}`);
});

// ── 7. contextAcp 投影 ──────────────────────────────────────────────────────

test('installPanel 投影：tier 推导 / 纯 fold / wire 只暴露七个字段', () => {
  const projection = captureProjection();
  assert(projection !== undefined, '投影应注册');
  eq(projection.key, 'contextAcp', '投影 key');
  eq(projection.stateVersion, 1, 'stateVersion');

  const initial = projection.init({}, 0);
  eq(initial.blocks, 0, 'init.blocks');

  // 无关事件：必须返回同一引用（注册表靠 Object.is 抑制重算）。
  const same = projection.apply(initial, { seq: 5, time: 1000, type: 'turn/start', data: { turn: 1 } });
  assert(Object.is(same, initial), '无关事件返回同一 state 引用');

  const first = projection.apply(initial, {
    seq: 11,
    time: 2000,
    type: 'compaction/summary',
    data: {
      compactionId: 'c1',
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 100,
      provider: 'p',
      model: 'm',
    },
  });
  eq(first.blocks, 1, 'blocks');
  eq(first.tierMax, 1, 'tierMax');
  eq(first.shadowedTokens, 100, 'shadowedTokens');
  eq(first.lastAt, 2000, 'lastAt 用 event.time');
  eq(first.lastProvider, 'p', 'lastProvider');
  eq(first.lastCompactionId, 'c1', 'lastCompactionId');

  // c1 的 summarySeq=11，checkpoint 在 12；c2 压掉 12 → tier 2。
  const second = projection.apply(first, {
    seq: 20,
    time: 3000,
    type: 'compaction/summary',
    data: {
      compactionId: 'c2',
      shadowedSeqs: [12, 15],
      shadowedTokenCount: 50,
      provider: 'p',
      model: 'm',
    },
  });
  eq(second.blocks, 2, 'blocks');
  eq(second.tierMax, 2, 'tier 2');
  eq(second.shadowedTokens, 150, '累计被压 tokens');

  const view = projection.wire.view(second);
  eq(view.blocks, 2, 'view.blocks');
  eq(view.tierMax, 2, 'view.tierMax');
  eq(view.shadowedTokens, 150, 'view.shadowedTokens');
  eq(Object.hasOwn(view, 'blockSeqs'), false, 'wire 不暴露内部 blockSeqs');
  eqArray(Object.keys(view).sort(), [
    'blocks',
    'lastAt',
    'lastCompactionId',
    'lastModel',
    'lastProvider',
    'shadowedTokens',
    'tierMax',
  ], 'wire 字段');
});

// ── 8. PROMPT_SECTION ───────────────────────────────────────────────────────

test('PROMPT_SECTION：四个工具名 + 不可压策略文件 + 无时间戳', () => {
  for (const token of ['compress', 'acp_status', 'decompress', 'search_context']) {
    assert(PROMPT_SECTION.includes(token), `提示段应提到 ${token}`);
  }
  assert(PROMPT_SECTION.includes('不要压缩策略文件'), '提示段应说明策略文件不可压');
  assert(PROMPT_SECTION.includes('skill'), '提示段应提到 skill 目录');
  assert(!/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(PROMPT_SECTION), '提示段不能含时间戳（会破坏 KV cache）');
  assert(!PROMPT_SECTION.includes('Date.now'), '提示段不能有动态值');
});

// ── 9. createNudgeHandler（e2e 用的工厂）+ 提醒消息可落日志 ───────────────────

test('createNudgeHandler：返回可注入的 handler（与 installNudge 同一实现）', async () => {
  process.env.DSH_ACP_TEST_PRESSURE = '90:100';
  try {
    const fakeAgent = { session: { snapshotEvents: () => [], surface: { nodes: [] } } };
    const handler = createNudgeHandler({
      ctx: { get: () => undefined },
      runtime: { nudge: { pressureRatio: 0.65, growthTokens: 12000, cooldownSteps: 6, maxPerTurn: 2 } },
      logger: { warn: () => {} },
      resolveEngine: () => ({ stageSummary: () => {} }),
      tokenMeter: () => undefined,
    });
    const decision = await handler(
      { agent: fakeAgent, messages: [], turn: 1, step: 3, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    eq(decision.messages.length, 1, '注入条数');
    assert(String(decision.messages[0].content[0].text).includes('[acp-nudge]'), '提示文本应含 [acp-nudge]');
    eq(decision.messages[0].source?.kind, 'context-acp', '提醒消息 source.kind');
  } finally {
    delete process.env.DSH_ACP_TEST_PRESSURE;
  }
});

test('nudge 提醒消息能 append 进真实 Session（source 形状合法、会留日志）', () => {
  // 这是 P3 的重要偏离：agent-loop 对每条 pre-step 消息硬读 source.kind 并
  // 除 runtime-context 外一律 append 进日志。这里直接用 Session.append 验证
  // source 形状被真实日志层接受，避免"只在真实 turn 里才炸"的假通过。
  const session = Session.create('session-nudge-append-test');
  const message = createUserMessage({
    content: [{ type: 'text', text: '[acp-nudge] 压力 90%，请压缩。' }],
    source: { kind: 'context-acp', form: 'notice', summary: 'ACP 上下文压力提醒' },
  });
  const event = session.append('user/message', message, { surfaceOp: 'append' });
  eq(session.surface.nodes.length, 1, 'surface 节点数');
  eq(session.surface.nodes[0], event.seq, 'surface seq');
  eq(session.eventAt(event.seq).data.source.kind, 'context-acp', '日志里的 source.kind');
});

// ── 10. installPanel 路由（getSettings / setSettings 落盘） ──────────────────

test('installPanel 路由：getSettings 信封 + setSettings 夹取并落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acp-settings-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const { route, deps } = capturePanelRoute();
    assert(route !== undefined, '路由应注册');
    eq(route.kind, 'prefix', '路由类型');
    eq(route.path, '/context-acp', '路由前缀');

    const got = await callRoute(route, 'getSettings', {});
    eq(got.type, 'server-response', '信封 type');
    eq(got.rpcId, 'r1', 'rpcId 回显');
    eq(got.result.ok, true, 'result.ok');
    // v2：新增 lastFallback / handoff / handoffAfter / fallbackAfterNudges（合并 context-guard）
    eq(got.result.value.version, 2, 'version');
    eq(got.result.value.backend, 'acp', 'backend');
    eq(got.result.value.armed, true, 'armed');
    eq(got.result.value.tunables.pressureRatio, 0.65, 'tunables.pressureRatio');
    eq(got.result.value.tunables.growthTokens, 12000, 'tunables.growthTokens');
    eq(got.result.value.tunables.decompressPageSize, 8, 'tunables.decompressPageSize');
    eq(got.result.value.tunables.searchLimit, 20, 'tunables.searchLimit');
    // 面板没有 sessionId：给「本进程最近一次 nudge」或 null，绝不伪造时间。
    // 前面的 nudge 用例可能已经记录过，所以这里只断言形状。
    assert(got.result.value.lastNudge === null || typeof got.result.value.lastNudge?.at === 'number', 'lastNudge 形状');
    recordNudge({ id: 'panel-test-agent' }, { usedTokens: 80, contextWindow: 100, step: 3, reason: 'pressure' });
    const gotAfterNudge = await callRoute(route, 'getSettings', {}, 'r1b');
    assert(gotAfterNudge.result.value.lastNudge !== null, '记录 nudge 后面板可见');
    eq(gotAfterNudge.result.value.lastNudge.usedTokens, 80, 'lastNudge.usedTokens');

    const saved = await callRoute(route, 'setSettings', {
      pressureRatio: 0.99,
      growthTokens: 1,
      decompressPageSize: 3,
      searchLimit: 99,
    }, 'r2');
    eq(saved.result.ok, true, 'setSettings result.ok');
    eq(saved.result.value.saved, true, 'saved');
    eq(saved.result.value.tunables.pressureRatio, 0.95, '返回夹取后的阈值');
    eq(deps.runtime.nudge.pressureRatio, 0.95, '写回共享 runtime');
    eq(deps.runtime.nudge.growthTokens, 1000, 'growthTokens 夹取');
    eq(deps.runtime.retain.decompressPageSize, 3, 'decompressPageSize');
    eq(deps.runtime.retain.searchLimit, 50, 'searchLimit 夹取');

    const file = JSON.parse(readFileSync(join(dir, 'context-acp.json'), 'utf8'));
    eq(file.nudge.pressureRatio, 0.95, '落盘 pressureRatio');
    eq(file.nudge.growthTokens, 1000, '落盘 growthTokens');
    eq(file.retain.decompressPageSize, 3, '落盘 decompressPageSize');
    eq(file.retain.searchLimit, 50, '落盘 searchLimit');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runner ──────────────────────────────────────────────────────────────────

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
