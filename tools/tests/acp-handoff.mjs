#!/usr/bin/env node
/**
 * 交接文档（handoff）自检 —— 从 `dsh-context-guard` 迁移到 `dsh-context-acp` 后新增。
 *
 * ## 为什么不直接删掉这个能力
 *
 * context-guard 的自动压缩被 ACP 的"模型决定 + 兜底"取代了，但"压缩 N 次后写一份
 * 人类可读的交接文档"是独立价值：新会话靠它接续工作。删掉等于丢功能，所以迁移。
 *
 * ## 钉什么
 *
 *   1. **统计从日志重建**：轮/步/压缩次数/释放 token/路由，全部 `snapshotEvents()` 现数
 *      —— 保证同一份日志永远生成同一份文档（投影是进程内状态，重启后不可复现）；
 *   2. **该写才写、写完保持最新**：未达次数不写、禁用不写、同一会话始终只有一份文件；
 *      压缩次数高于上次写时**原地刷新**（覆盖同一文件，不新增），重启后也能认回并续写；
 *   3. **失败不静默**：写入失败返回 `{written:false, reason:'write-failed', error}`；
 *   4. **接线真的会触发**：`turn/end` 与 `compaction/end` 都检查（手动 compact 不在
 *      turn 里，只等 turn/end 会拖到下一轮），其它事件不触发，一个 agent 只挂一份监听；
 *   5. **`--force` 无视阈值**：换会话/收尾时能立刻要一份（`/acp handoff --force`）。
 *
 * 全部离线：用假 session（snapshotEvents + header.cwd）+ 临时目录 + 迷你 cordis ctx。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HANDOFF,
  HANDOFF_TRIGGER_EVENTS,
  buildHandoff,
  collectStats,
  createHandoff,
  handoffSessionKey,
  installHandoffHook,
  isHandoffTriggerEvent,
  stamp,
} from '../../plugins/dsh-context-acp/lib/handoff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 造一段有代表性的会话事件流。 */
function makeEvents({ compactions = 2 } = {}) {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '帮我把 agentrouter 收敛到 Responses 路由' }] },
    },
    {
      type: 'tool/call',
      data: { name: 'edit', arguments: JSON.stringify({ file_path: 'profiles/web/cordis.patch.yml' }) },
    },
    { type: 'request/context', data: { provider: 'antigravity', model: 'gemini-3.8-flash-high', contextWindow: 1000000 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  for (let i = 1; i <= compactions; i++) {
    events.push({
      type: 'compaction/summary',
      data: { shadowedTokenCount: 1000 * i, summary: [{ type: 'text', text: `第 ${i} 次压缩的摘要` }] },
    });
  }
  events.push(
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'step/end', data: { turn: 2, step: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } },
  );
  return events;
}

// ── 1. 统计从日志重建 ──────────────────────────────────────────────────
console.log('\n统计（collectStats）');
const stats = collectStats(makeEvents());
check('数到 2 个 turn/end', stats.turns === 2, stats.turns);
check('数到 2 个 step/end', stats.steps === 2, stats.steps);
check('数到 2 次压缩', stats.compactions === 2, stats.compactions);
check('取最后一次压缩释放的 token', stats.lastFreedTokens === 2000, stats.lastFreedTokens);
check('路由来自 request/context', stats.route === 'antigravity/gemini-3.8-flash-high', stats.route);
check('窗口来自 request/context', stats.contextWindow === 1000000);
check('收集到压缩摘要', stats.summaries.length === 2 && stats.summaries[1].includes('第 2 次'), stats.summaries);
check('收集到动过的文件', stats.files.includes('profiles/web/cordis.patch.yml'), stats.files);
check('收集到用户消息', stats.recentUsers.length === 2, stats.recentUsers);
check('空事件流不抛', collectStats([]).compactions === 0);
check('null 事件不抛', collectStats([null, { type: 'turn/end' }]).turns === 1);

// ── 2. 文档内容 ────────────────────────────────────────────────────────
console.log('\n文档（buildHandoff）');
const session = { id: 'session-abc12345-0000', header: { cwd: '/tmp/x' } };
const body = buildHandoff(session, stats, { ...DEFAULT_HANDOFF, thresholdRatio: 0.75 });
check('标题写明由 ACP 生成', /dsh-context-acp/.test(body));
check('带会话 id', body.includes(session.id));
check('带规模（2 轮 / 2 步）', body.includes('2 轮 / 2 步'), body.slice(0, 300));
check('带压缩次数与阈值', body.includes('已压缩: 2 次') && body.includes('75%'));
check('带路由', body.includes('antigravity/gemini-3.8-flash-high'));
check('列出动过的文件', body.includes('profiles/web/cordis.patch.yml'));
check('包含压缩摘要小节', body.includes('## 压缩摘要') && body.includes('第 2 次压缩的摘要'));
check('包含最近用户消息小节', body.includes('## 最近 2 条用户消息'));
check('包含下一步指引', body.includes('## 下一步'));

// ── 3. 文件名与时间戳 ──────────────────────────────────────────────────
console.log('\n文件名片段');
check('会话短标识取 8 位且剥掉 session- 前缀',
  handoffSessionKey(session) === 'abc12345', handoffSessionKey(session));
check('非法 id 也能生成安全 key', /^[a-zA-Z0-9]+$/.test(handoffSessionKey({ id: '!!!' })));
check('时间戳是文件名安全形状', /^\d{8}-\d{6}$/.test(stamp(Date.now())), stamp(Date.now()));

// ── 4. 写入器（该写才写 / 一份文件 / 次数增加即刷新）────────────────────
console.log('\n写入器（createHandoff）');
const dir = mkdtempSync(join(tmpdir(), 'acp-handoff-'));
/** 目录里指定前缀的文件（按名排序）。 */
const filesWith = (prefix) => readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
try {
  const fakeSession = {
    id: 'session-77777777-1111',
    header: { cwd: dir },
    snapshotEvents: () => makeEvents({ compactions: 1 }),
  };
  const rejected = [];
  const one = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2 }, logger: { warn: (m) => rejected.push(m) } });
  const below = await one.maybeHandoff(fakeSession);
  check('压缩 1 次 < 阈值 2 → 不写', below.written === false && below.reason === 'below-threshold', below);
  check('不写时目录里没有文件', readdirSync(dir).length === 0);

  const writer = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2 } });
  const c2session = { ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 2 }) };
  const written = await writer.maybeHandoff(c2session);
  check('压缩 2 次 → 写出', written.written === true && written.reason === 'written', written);
  const afterFirst = readdirSync(dir);
  check('一个会话一份、文件名带前缀与会话 key', afterFirst.length === 1 && afterFirst[0].startsWith('HANDOFF-context-acp-77777777-'), afterFirst);
  check('文件名**不再带 cN**（次数是正文事实，不是文件名）', !/-c\d+-/.test(afterFirst[0]), afterFirst[0]);
  const firstPath = join(dir, afterFirst[0]);
  check('落盘内容与 builder 一致（含摘要）', readFileSync(firstPath, 'utf8').includes('第 2 次压缩的摘要'));

  const again = await writer.maybeHandoff(c2session);
  check('同一会话、同次数再触发 → 认缓存，不写第二份',
    again.written === true && again.reason === 'cached' && readdirSync(dir).length === 1, again);

  const c3 = await writer.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 3 }) });
  check('压缩次数 3 > 2 → 原地刷新（不新增文件）',
    c3.written === true && c3.reason === 'refreshed' && c3.file === firstPath && readdirSync(dir).length === 1, c3);
  check('刷新后文件名不变（覆盖同一份）', readdirSync(dir)[0] === afterFirst[0], readdirSync(dir));
  const textC3 = readFileSync(firstPath, 'utf8');
  check('刷新后正文是最新 c3（含第 3 次摘要与已压缩: 3 次）',
    textC3.includes('第 3 次压缩的摘要') && textC3.includes('已压缩: 3 次'), textC3.slice(0, 400));

  const c6 = await writer.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 6 }) });
  check('跳过 c4 直接到 c6 也刷新到最新（长会话不冻结在旧快照）',
    c6.reason === 'refreshed' && readFileSync(firstPath, 'utf8').includes('已压缩: 6 次') && readdirSync(dir).length === 1, c6);

  const restarted = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2 } });
  const sameExisting = await restarted.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 6 }) });
  check('新进程（无缓存）→ 认回磁盘上的 c6 文件且不重写',
    sameExisting.written === true && sameExisting.reason === 'existing' && sameExisting.compactions === 6 && readdirSync(dir).length === 1, sameExisting);
  const c7 = await restarted.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 7 }) });
  check('新进程 + 次数增加 → 原地刷新磁盘上的旧文件（同名覆盖）',
    c7.reason === 'refreshed' && c7.file === firstPath && readdirSync(dir).length === 1 && readFileSync(firstPath, 'utf8').includes('已压缩: 7 次'), c7);

  // 事后把阈值调高：已有文件不受阈值影响，次数增加仍要刷新（否则旧文件冻结）。
  const raisedDirSession = { id: 'session-cccccccc-0000', header: { cwd: dir }, snapshotEvents: () => makeEvents({ compactions: 2 }) };
  const raisedWriter = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2, prefix: 'HANDOFF-raised' } });
  await raisedWriter.maybeHandoff(raisedDirSession);
  const raisedFile = join(dir, filesWith('HANDOFF-raised-')[0]);
  const raisedAgain = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 5, prefix: 'HANDOFF-raised' } });
  const raisedResult = await raisedAgain.maybeHandoff({ ...raisedDirSession, snapshotEvents: () => makeEvents({ compactions: 3 }) });
  check('事后调高 afterCompactions：已有文件仍按次数刷新，不被阈值挡住',
    raisedResult.reason === 'refreshed' && readFileSync(raisedFile, 'utf8').includes('已压缩: 3 次'), raisedResult);

  // force 早写（c1 < 阈值 2）之后，普通触发不应再报 below-threshold：文件已在，就该报 cached/existing。
  const earlyDirSession = { id: 'session-dddddddd-0000', header: { cwd: dir }, snapshotEvents: () => makeEvents({ compactions: 1 }) };
  const earlyWriter = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2, prefix: 'HANDOFF-early' } });
  const earlyForced = await earlyWriter.maybeHandoff(earlyDirSession, { force: true });
  const earlyAgain = await earlyWriter.maybeHandoff(earlyDirSession);
  check('force 早写后普通触发报已存在（而不是 below-threshold）',
    earlyForced.reason === 'written' && earlyAgain.reason === 'cached' && earlyAgain.compactions === 1, earlyAgain);

  // 关掉刷新：回到「写完冻结」的旧语义（显式逃生门）。
  const frozenDirSession = { id: 'session-88888888-0000', header: { cwd: dir }, snapshotEvents: () => makeEvents({ compactions: 2 }) };
  const frozen = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2, prefix: 'HANDOFF-frozen', refreshOnHigherCompaction: false } });
  await frozen.maybeHandoff(frozenDirSession);
  const frozenFile = join(dir, filesWith('HANDOFF-frozen-')[0]);
  const frozenBefore = readFileSync(frozenFile, 'utf8');
  const frozenAgain = await frozen.maybeHandoff({ ...frozenDirSession, snapshotEvents: () => makeEvents({ compactions: 5 }) });
  check('refreshOnHigherCompaction=false → 不刷新（逃生门有效）',
    frozenAgain.reason === 'cached' && readFileSync(frozenFile, 'utf8') === frozenBefore, frozenAgain);

  // 旧命名（…-c<N>-…）兼容：认领并原地刷新，不改名、不新增。
  const legacyName = 'HANDOFF-context-acp-99999999-c1-20260101-000000.md';
  writeFileSync(join(dir, legacyName), '# old\n\n- 已压缩: 1 次\n', 'utf8');
  const legacySession = { id: 'session-99999999-2222', header: { cwd: dir }, snapshotEvents: () => makeEvents({ compactions: 4 }) };
  const legacyWriter = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2 } });
  const legacyResult = await legacyWriter.maybeHandoff(legacySession);
  check('旧命名 cN 文件被认领并原地刷新（文件名保持不变）',
    legacyResult.reason === 'refreshed' && legacyResult.file === join(dir, legacyName), legacyResult);
  check('旧文件仍只有一份、正文更新到 c4',
    filesWith('HANDOFF-context-acp-99999999-').length === 1 && readFileSync(join(dir, legacyName), 'utf8').includes('已压缩: 4 次'));

  // 并发触发（compaction/end 紧接 turn/end）必须串行化：只能产生一份文件。
  const conc = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 1, prefix: 'HANDOFF-conc' } });
  const concSession = { id: 'session-aaaaaaaa-0000', header: { cwd: dir }, snapshotEvents: () => makeEvents({ compactions: 2 }) };
  await Promise.all([conc.maybeHandoff(concSession), conc.maybeHandoff(concSession), conc.maybeHandoff(concSession)]);
  check('并发触发只产生一份文件（per-session 串行化）', filesWith('HANDOFF-conc-').length === 1, filesWith('HANDOFF-conc-'));

  const disabled = createHandoff({ cfg: { ...DEFAULT_HANDOFF, enabled: false, afterCompactions: 1 } });
  const off = await disabled.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 2 }) });
  check('禁用 → 不写', off.written === false && off.reason === 'disabled');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 5. 触发事件 ────────────────────────────────────────────────────────
console.log('\n触发事件（isHandoffTriggerEvent）');
check('turn/end 触发', isHandoffTriggerEvent({ type: 'turn/end' }) === true);
check('compaction/end 触发（手动 compact 完成后立刻写）', isHandoffTriggerEvent({ type: 'compaction/end' }) === true);
check('step/end 不触发（不做步级写盘）', isHandoffTriggerEvent({ type: 'step/end' }) === false);
check('compaction/start 不触发（压缩还没完成）', isHandoffTriggerEvent({ type: 'compaction/start' }) === false);
check('空/非对象不触发', isHandoffTriggerEvent(null) === false && isHandoffTriggerEvent({}) === false);
check('触发集合就是那两类', HANDOFF_TRIGGER_EVENTS.length === 2 && HANDOFF_TRIGGER_EVENTS.join(',') === 'turn/end,compaction/end');

// ── 6. 接线：真监听器会不会被点燃 ──────────────────────────────────────
/**
 * 迷你 cordis ctx：只实现本插件用到的三个口。
 *   ctx.effect(fn)  —— 跑生成器，收集 yield 出来的 disposer，返回组合 disposer
 *   ctx.on(name,fn) —— 注册/注销监听，返回 disposer
 *   ctx.get('agents') —— 挂载时已在跑的 agent
 */
function miniCtx({ agents = [] } = {}) {
  const listeners = new Map();
  const disposers = [];
  const api = {
    effect(fn) {
      const local = [];
      const collect = (value) => {
        if (typeof value === 'function') local.push(value);
        else if (value !== null && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
          for (const item of value) collect(item);
        }
      };
      collect(fn());
      const dispose = () => {
        for (const off of local.reverse()) {
          try {
            off();
          } catch {
            /* 已销毁 */
          }
        }
      };
      disposers.push(dispose);
      return dispose;
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
    },
    get() {
      return {
        list: () => agents,
        get: (id) => agents.find((agent) => agent.id === id),
      };
    },
  };
  return api;
}

console.log('\n接线（installHandoffHook）');
{
  const calls = [];
  const handoff = { maybeHandoff: async (session) => { calls.push(session.id); return { written: true }; } };
  // 挂载时已经活着的 agent 也要挂上（重挂/续跑的场景）。
  const agent = { id: 'session-live-0001', session: { id: 'session-live-0001' }, ctx: miniCtx() };
  const rootCtx = miniCtx({ agents: [agent] });
  const disposeHook = installHandoffHook({ ctx: rootCtx, handoff });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  agent.ctx.emit('session/event', agent.session, { type: 'turn/end' });
  await tick();
  check('挂载时已存在的 agent 在 turn/end 上触发', calls.length === 1 && calls[0] === 'session-live-0001', calls);

  agent.ctx.emit('session/event', agent.session, { type: 'step/end' });
  await tick();
  check('step/end 不触发', calls.length === 1, calls);

  agent.ctx.emit('session/event', agent.session, { type: 'compaction/end' });
  await tick();
  check('compaction/end 触发（手动 compact 后立即成文）', calls.length === 2, calls);

  // 后创建的 agent 通过 agent/created 挂上。
  const later = { id: 'session-later-0002', session: { id: 'session-later-0002' }, ctx: miniCtx() };
  rootCtx.emit('agent/created', { agent: later });
  later.ctx.emit('session/event', later.session, { type: 'turn/end' });
  await tick();
  check('agent/created 之后的新 agent 也触发', calls.length === 3 && calls[2] === 'session-later-0002', calls);

  // 重复 announce 不应重复挂监听（否则一次事件写两次）。
  rootCtx.emit('agent/created', { agent: later });
  later.ctx.emit('session/event', later.session, { type: 'turn/end' });
  await tick();
  check('同一 agent 重复 attach → 只挂一份监听', calls.length === 4, calls);

  rootCtx.emit('agent/disposed', { agent: later });
  later.ctx.emit('session/event', later.session, { type: 'turn/end' });
  await tick();
  check('agent/disposed 后不再触发', calls.length === 4, calls);

  disposeHook();
  agent.ctx.emit('session/event', agent.session, { type: 'turn/end' });
  await tick();
  check('插件卸载后不再触发', calls.length === 4, calls);
}

console.log('\n接线（--force 与真实场景）');
{
  const dir = mkdtempSync(join(tmpdir(), 'acp-handoff-force-'));
  try {
    const session = {
      id: 'session-55555555-9999',
      header: { cwd: dir },
      snapshotEvents: () => makeEvents({ compactions: 1 }),
    };
    const writer = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2 } });
    const refused = await writer.maybeHandoff(session);
    check('不等 force：1 次 < 2 次 → 不写，并报出需要的次数',
      refused.written === false && refused.reason === 'below-threshold' && refused.required === 2, refused);
    const forced = await writer.maybeHandoff(session, { force: true });
    check('--force：无视阈值写出', forced.written === true && forced.reason === 'written', forced);
    check('force 写出的文件名稳定、正文带真实压缩次数（c1）',
      readdirSync(dir).length === 1 && !/-c\d+-/.test(readdirSync(dir)[0]) && readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').includes('已压缩: 1 次'), readdirSync(dir));
    const forcedAgain = await writer.maybeHandoff(session, { force: true });
    check('--force 重复调用：原地刷新同一份，不写第二份',
      forcedAgain.written === true && forcedAgain.reason === 'refreshed' && readdirSync(dir).length === 1, forcedAgain);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 7. 静态接线检查 ────────────────────────────────────────────────────
console.log('\n接线检查（源码）');
const indexSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'lib', 'index.js'), 'utf8');
const handoffSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'lib', 'handoff.mjs'), 'utf8');
const clientSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'client.js'), 'utf8');
const runtime = JSON.parse(readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'config', 'runtime.json'), 'utf8'));
check('根插件在装配时创建 handoff 写入器', /deps\.handoff = createHandoff\(/.test(indexSrc));
check('根插件装配的是 handoff.mjs 里的 hook', /yield installHandoffHook\(deps\)/.test(indexSrc));
check('hook 挂在 agent 作用域（根看不到 scoped session/event）',
  /agent\.ctx\.on\('session\/event'/.test(handoffSrc));
check('hook 用共享的触发判定，不硬编码单个事件类型',
  /isHandoffTriggerEvent\(event\)/.test(handoffSrc) && !/event\?\.type !== 'turn\/end'/.test(handoffSrc));
check('runtime.json 的 handoff 配置存在且默认 2 次',
  runtime?.handoff?.enabled === true && runtime?.handoff?.afterCompactions === 2);
check('runtime.json 开启「次数增加即刷新」', runtime?.handoff?.refreshOnHigherCompaction === true);
check('写入器实现刷新分支（同文件覆盖，reason=refreshed）',
  /reason = existing !== undefined \? 'refreshed' : 'written'/.test(handoffSrc) && /writeFile\(file, body/.test(handoffSrc));
check('面板显示交接文档状态', /panel\.handoff/.test(clientSrc) && /handoffNotWritten/.test(clientSrc));
check('面板可调"压满几次"', /handoffAfter/.test(clientSrc) && /HANDOFF_MIN/.test(clientSrc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
