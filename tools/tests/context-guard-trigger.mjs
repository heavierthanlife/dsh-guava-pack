#!/usr/bin/env node
/**
 * context-guard「轮末压缩」触发逻辑与可见性的自检。
 *
 * ## 为什么必须钉住这段
 *
 * 2026-10-27 定位到一次**长期静默失效**：
 *   · `turn/end` 在 turn runner 的 `finally` 里 append，此刻 agent 的 phase 仍是
 *     `running`；
 *   · `compactNow()` 内部走 `agent.runMaintenance()`，准入要求 `phase.kind==='idle'`；
 *   · 于是每次轮末都抛 `busy`，而旧代码只 `logger.debug` 一行 —— 谁都不知道；
 *   · 表现：上下文从 65% 一路涨到 79%，一次都没压缩成功。
 *
 * 所以本文件同时钉两件事：
 *   1. **什么时候才允许调 compactNow**（必须等 idle）；
 *   2. **每次尝试都留下可见记录**（lastAttempt），不许再静默。
 *
 * 全部离线：不需要 Cordis、不需要会话、不起浏览器。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION,
  REASON,
  OUTCOME,
  classifyResult,
  decideAttempt,
  failureKey,
  makeAttempt,
} from '../../plugins/dsh-context-guard/lib/trigger.mjs';
import { createIdleScheduler } from '../../plugins/dsh-context-guard/lib/scheduler.mjs';

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

const base = {
  triggerMatched: true,
  inFlight: false,
  used: 700_000,
  window: 1_000_000,
  thresholdRatio: 0.65,
  armed: true,
  status: 'idle',
};

// ── 1. 决策：什么时候允许压缩 ────────────────────────────────────────────
console.log('\n决策（decideAttempt）');
check('条件齐全 + 空闲 → attempt',
  decideAttempt(base).action === ACTION.ATTEMPT, decideAttempt(base));
check('attempt 的原因标记为 over-threshold',
  decideAttempt(base).reason === REASON.OVER_THRESHOLD);

const busy = decideAttempt({ ...base, status: 'running' });
check('**agent 还在跑 → wait（本次事故的核心）**', busy.action === ACTION.WAIT, busy);
check('wait 的原因是 wait-idle', busy.reason === REASON.WAIT_IDLE);
check('wait 决策里带上比例，便于面板显示', Math.round(busy.ratio * 100) === 70, busy.ratio);

check('本轮不是自然结束（interrupted）→ skip',
  decideAttempt({ ...base, triggerMatched: false }).reason === REASON.TRIGGER_MISMATCH);
check('已有压缩在飞 → skip',
  decideAttempt({ ...base, inFlight: true }).reason === REASON.IN_FLIGHT);
check('没有压力数据 → skip（不再拿默认值硬压）',
  decideAttempt({ ...base, used: undefined }).reason === REASON.NO_PRESSURE);
check('窗口为 0 → skip（除零保护）',
  decideAttempt({ ...base, window: 0 }).reason === REASON.NO_PRESSURE);
check('窗口为负 → skip',
  decideAttempt({ ...base, window: -1 }).reason === REASON.NO_PRESSURE);
check('未达阈值 → skip',
  decideAttempt({ ...base, used: 600_000 }).reason === REASON.BELOW_THRESHOLD);
check('刚好等于阈值 → attempt（>= 语义）',
  decideAttempt({ ...base, used: 650_000 }).action === ACTION.ATTEMPT);
check('没解析到 compaction 服务 → skip',
  decideAttempt({ ...base, armed: false }).reason === REASON.NOT_ARMED);
check('未达阈值时即使没 armed，也先报 below-threshold（更能解释"为什么没动"）',
  decideAttempt({ ...base, used: 100_000, armed: false }).reason === REASON.BELOW_THRESHOLD);
check('在飞 + 未达阈值 → 先报 in-flight（顺序稳定）',
  decideAttempt({ ...base, used: 100_000, inFlight: true }).reason === REASON.IN_FLIGHT);

// ── 2. 结果归类：null 不是失败 ──────────────────────────────────────────
console.log('\n结果归类（classifyResult）');
check('compactNow 返回 null → nothing-to-compact',
  classifyResult(null) === OUTCOME.NOTHING_TO_COMPACT);
check('undefined 也按"没有可压区间"处理',
  classifyResult(undefined) === OUTCOME.NOTHING_TO_COMPACT);
check('返回对象 → ok', classifyResult({ id: 'c1' }) === OUTCOME.OK);

// ── 3. 失败去重与记录 ──────────────────────────────────────────────────
console.log('\n失败可见性');
const busyErr = Object.assign(new Error('manual compaction requires an idle agent'), { code: 'busy' });
const summaryErr = Object.assign(new Error('could not produce a smaller summary'), { code: 'summary' });
check('同会话同 code → 同一个去重键（只 warn 一次）',
  failureKey('s1', 'compaction', busyErr) === failureKey('s1', 'compaction', busyErr));
check('不同 code → 不同键（换了错误类型仍会被看见）',
  failureKey('s1', 'compaction', busyErr) !== failureKey('s1', 'compaction', summaryErr));
check('不同会话 → 不同键', failureKey('s1', 'compaction', busyErr) !== failureKey('s2', 'compaction', busyErr));
check('没 code 的异常也能生成键', typeof failureKey('s1', 'compaction', new Error('x')) === 'string');

const attempt = makeAttempt({
  at: 1_700_000_000_000,
  sessionId: 'session-abc',
  turn: 12,
  outcome: OUTCOME.ERROR,
  reason: REASON.OVER_THRESHOLD,
  ratio: 0.7626,
  detail: busyErr,
});
check('lastAttempt 带时间/会话/轮次/结论',
  attempt.at === 1_700_000_000_000 && attempt.sessionId === 'session-abc' && attempt.turn === 12 &&
  attempt.outcome === OUTCOME.ERROR);
check('lastAttempt 带百分比（76%）', attempt.percent === 76, attempt.percent);
check('detail 截断到 300 字以内（面板不塞堆栈）',
  makeAttempt({ at: 1, outcome: OUTCOME.ERROR, detail: 'x'.repeat(1000) }).detail.length === 300);
check('没有 detail 时不带该字段',
  !('detail' in makeAttempt({ at: 1, sessionId: 's', outcome: OUTCOME.OK, reason: 'over-threshold' })));

// ── 3b. 调度器：turn/end 只登记，idle 才执行 ────────────────────────────
// 这一段是本次事故的**直接回归**：用假 agent 驱动真实的调度器，
// 断言"agent 还在跑时绝不调用压缩"。
console.log('\n调度器（createIdleScheduler）');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

{
  const agent = { status: 'running' };
  const calls = [];
  const sched = createIdleScheduler({
    afterTurnEnd: async (a, compaction, session, event) => { calls.push({ compaction, session, event }); },
    resolveCompaction: () => ({ name: 'compaction' }),
  });

  sched.queueTurnEnd(agent, { id: 's1' }, { type: 'turn/end', data: { turn: 1 } });
  await tick();
  check('**agent 还在跑：turn/end 只登记，不调用压缩**', calls.length === 0, calls.length);
  check('挂起计数为 1', sched.size() === 1, sched.size());

  sched.notifyStatus(agent, 'running');
  await tick();
  check('非 idle 的状态事件不触发执行', calls.length === 0);

  agent.status = 'idle';
  sched.notifyStatus(agent, 'idle');
  await tick();
  check('进入 idle 后执行一次', calls.length === 1, calls.length);
  check('执行时带上 session/event 与解析到的 compaction',
    calls[0]?.session?.id === 's1' && calls[0]?.event?.data?.turn === 1 && calls[0]?.compaction?.name === 'compaction');
  check('执行后挂起清空', sched.size() === 0);

  sched.notifyStatus(agent, 'idle');
  await tick();
  check('没有挂起时 idle 事件是空操作', calls.length === 1);
}

{
  // 轮末连发多条：只保留最新一条，且只执行一次（不重复压缩）
  const agent = { status: 'running' };
  const calls = [];
  const sched = createIdleScheduler({
    afterTurnEnd: async (a, c, session, event) => { calls.push(event.data.turn); },
    resolveCompaction: () => ({}),
  });
  sched.queueTurnEnd(agent, { id: 's2' }, { type: 'turn/end', data: { turn: 1 } });
  sched.queueTurnEnd(agent, { id: 's2' }, { type: 'turn/end', data: { turn: 2 } });
  await tick();
  check('多条挂起 → 只保留最新（last-wins）', sched.size() === 1);
  agent.status = 'idle';
  sched.notifyStatus(agent, 'idle');
  await tick();
  check('空闲后只执行一次，且用的是最新那条', calls.length === 1 && calls[0] === 2, calls);
}

{
  // 异常必须冒到 onError（由调用方 warn + 记录 lastAttempt），且不卡住挂起
  const agent = { status: 'idle' };
  const errors = [];
  const sched = createIdleScheduler({
    afterTurnEnd: async () => { throw Object.assign(new Error('busy'), { code: 'busy' }); },
    resolveCompaction: () => ({}),
    onError: (error, job) => errors.push({ code: error.code, sessionId: job.session.id }),
  });
  sched.queueTurnEnd(agent, { id: 's3' }, { type: 'turn/end', data: { turn: 3 } });
  await tick();
  check('afterTurnEnd 抛错 → 交给 onError（不会被吞掉）', errors.length === 1 && errors[0].code === 'busy');
  check('抛错后挂起已清空（下一次还能再试）', sched.size() === 0);
}

{
  // resolveCompaction 抛错 / 返回 undefined：仍然执行，只是 compaction 为 undefined
  const agent = { status: 'idle' };
  let seen;
  let armed = 0;
  const sched = createIdleScheduler({
    afterTurnEnd: async (a, compaction) => { seen = compaction; },
    resolveCompaction: () => { throw new Error('preset not mounted'); },
    onArmed: () => { armed++; },
  });
  sched.queueTurnEnd(agent, { id: 's4' }, { type: 'turn/end', data: { turn: 4 } });
  await tick();
  check('解析 compaction 抛错 → 按未就绪处理，不阻断 handoff 路径', seen === undefined);
  check('解析不到时不点亮 armed', armed === 0);

  const agent2 = { status: 'idle' };
  let armed2 = 0;
  const sched2 = createIdleScheduler({
    afterTurnEnd: async () => {},
    resolveCompaction: () => ({ ok: true }),
    onArmed: () => { armed2++; },
  });
  sched2.queueTurnEnd(agent2, { id: 's5' }, { type: 'turn/end', data: { turn: 5 } });
  await tick();
  check('解析到 compaction → onArmed 点亮面板指示灯', armed2 === 1);
}

{
  // forget：agent 销毁后不执行、不泄漏
  const agent = { status: 'running' };
  let calls = 0;
  const sched = createIdleScheduler({
    afterTurnEnd: async () => { calls++; },
    resolveCompaction: () => ({}),
  });
  sched.queueTurnEnd(agent, { id: 's6' }, { type: 'turn/end', data: { turn: 6 } });
  sched.forget(agent);
  agent.status = 'idle';
  sched.notifyStatus(agent, 'idle');
  await tick();
  check('agent 销毁后挂起被丢弃、不再执行', calls === 0 && sched.size() === 0);

  check('没有挂起时 flush 返回 false', (await sched.flush(agent)) === false);
}

// ── 4. 接线检查（逻辑对但没接上 = 白干）────────────────────────────────
console.log('\n接线检查');
const host = readFileSync(join(PACK, 'plugins', 'dsh-context-guard', 'index.js'), 'utf8');
const client = readFileSync(join(PACK, 'plugins', 'dsh-context-guard', 'client.js'), 'utf8');

check('host 监听 agent/status 并交给调度器', /on\('agent\/status'/.test(host) && /scheduler\.notifyStatus\(agent, status\)/.test(host));
check('turn/end 只登记（调度器 queueTurnEnd），不当场压缩',
  /scheduler\.queueTurnEnd\(agent, session, event\)/.test(host));
check('idle 准入的调度器是独立模块（可离线驱动）', /from '\.\/lib\/scheduler\.mjs'/.test(host));
check('压缩失败首次 warn（不再只有 debug）',
  /logger\?\.warn\?\.\(`\$\{line\}/.test(host) && /reportFailure\('compaction'/.test(host));
check('压缩失败会写入 lastAttempt', /recordAttempt\(session, OUTCOME\.ERROR/.test(host));
check('compactNow 返回 null 会被单独记录',
  /classifyResult\(result\)/.test(host) && /OUTCOME\.NOTHING_TO_COMPACT/.test(host));
check('面板接口暴露 lastAttempt / pending / version',
  /lastAttempt,/.test(host) && /pending: scheduler\.size\(\)/.test(host) && /version: 2/.test(host));
check('agent 销毁时清理挂起的检查', /scheduler\.forget\(agent\)/.test(host));
check('决策逻辑不在 host 里重复实现（单一来源 lib/trigger.mjs）',
  /from '\.\/lib\/trigger\.mjs'/.test(host) && /decideAttempt\(/.test(host));

check('client 渲染「上次检查」行', /panel\.lastAttempt/.test(client));
check('client 区分 ok / nothing-to-compact / error / skipped',
  /panel\.attempt\.ok/.test(client) && /panel\.attempt\.nothing-to-compact/.test(client) &&
  /panel\.attempt\.error/.test(client) && /panel\.attempt\.skipped/.test(client));
check('client 对旧宿主给出明确提示（版本握手）',
  /panel\.hostStale/.test(client) && /info\.version !== 2/.test(client));
check('client 在失败时给药丸加警示属性', /data-fail/.test(client));

// 反向断言：防止有人把压缩又塞回 turn/end 的同步路径
const turnEndListener = host
  .slice(
    host.indexOf("yield agent.ctx.on('session/event'"),
    host.indexOf("}, 'context-guard/agent')"),
  )
  // 去掉注释行再断言：注释里提到 compactNow 是**解释**，不是调用。
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
check('turn/end 监听器里没有 compactNow 调用',
  !/compactNow\s*\(/.test(turnEndListener), turnEndListener.slice(0, 200));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
