#!/usr/bin/env node
/**
 * 兜底自动压缩的自检（合并 context-guard 时新增的能力）。
 *
 * ## 为什么要有兜底
 *
 * ACP 的哲学是「模型决定何时压」。但模型可能就是不响应 nudge（能力弱、被长任务
 * 拖住、或用户选了不适合压缩的模型），上下文会一路涨到 provider 报错。
 * 合并前 `dsh-context-guard` 在 65% 上**无条件**自己压 —— 抢了模型的决定权。
 * 合并后的策略：**先提醒两次，还不理我，才自己动手**（用户 2026-10-27 指定：
 * 连续 2 次 nudge 未被响应 且 ≥75%）。
 *
 * 本文件钉三件事：
 *   1. "未响应"怎么数（从日志数，重启/恢复不丢，模型一压自动归零）；
 *   2. 什么时候才允许兜底（禁用/没压力/未达比例/还差几次提醒 → 都不动手）；
 *   3. 接线真的接上了（引擎方法存在、nudge 调用、生成器把 75% 写进引擎配置）。
 *
 * 全部离线：不起 Cordis、不联网、不需要会话。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FALLBACK,
  NUDGE_SOURCE_KIND,
  countUnansweredNudges,
  decideFallback,
  makeFallbackRecord,
} from '../../plugins/dsh-context-acp/lib/fallback.mjs';

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

const nudge = (turn) => ({
  type: 'user/message',
  data: { turn, content: [{ type: 'text', text: '[acp-nudge] ...' }], source: { kind: NUDGE_SOURCE_KIND, form: 'notice' } },
});
const user = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });
const summary = () => ({ type: 'compaction/summary', data: { shadowedTokenCount: 1000 } });

// ── 1. 数"未被响应的 nudge" ─────────────────────────────────────────────
console.log('\n未响应 nudge 计数（countUnansweredNudges）');
check('空日志 → 0', countUnansweredNudges([]) === 0);
check('一条 nudge → 1', countUnansweredNudges([nudge(1)]) === 1);
check('两条 nudge → 2', countUnansweredNudges([nudge(1), nudge(2)]) === 2);
check('压缩之后归零（模型响应了）', countUnansweredNudges([nudge(1), nudge(2), summary()]) === 0);
check('压缩后再提醒 → 重新从 1 数', countUnansweredNudges([nudge(1), nudge(2), summary(), nudge(3)]) === 1);
check('普通用户消息不算 nudge', countUnansweredNudges([user('你好'), user('继续')]) === 0);
check('普通消息不打断计数', countUnansweredNudges([nudge(1), user('嗯'), nudge(2)]) === 2);
check('其它事件类型被忽略', countUnansweredNudges([{ type: 'step/start' }, { type: 'tool/result' }, nudge(1)]) === 1);
check('null 事件不抛', countUnansweredNudges([null, undefined, nudge(1)]) === 1);
check('nudge source kind 与 nudge.mjs 同源常量', NUDGE_SOURCE_KIND === 'context-acp');

// ── 2. 兜底决策 ────────────────────────────────────────────────────────
console.log('\n兜底决策（decideFallback）');
const at = (used, unanswered, extra = {}) =>
  decideFallback({ used, window: 1000000, unansweredNudges: unanswered, cfg: DEFAULT_FALLBACK, ...extra });

check('两条未响应 + 75% → 动手', at(750_000, 2).compact === true, at(750_000, 2));
check('动手原因是 nudge-unanswered', at(750_000, 2).reason === 'nudge-unanswered');
check('只有一次未响应 → 不动手（先等模型）', at(750_000, 1).compact === false);
check('不足比例 → 不动手', at(700_000, 5).compact === false);
check('不足比例原因是 below-ratio', at(700_000, 5).reason === 'below-ratio');
check('等待模型原因可读，并给出还差几次', at(800_000, 1).reason === 'waiting-for-model' && at(800_000, 1).pending === 1);
check('禁用 → 永远不动手', at(990_000, 9, { cfg: { ...DEFAULT_FALLBACK, enabled: false } }).reason === 'disabled');
check('没有压力数据 → 不动手（不猜）', decideFallback({ used: undefined, window: 1e6, unansweredNudges: 9 }).reason === 'no-pressure');
check('窗口为 0 → 不动手（除零保护）', decideFallback({ used: 100, window: 0, unansweredNudges: 9 }).reason === 'no-pressure');
check('刚好 75% → 动手（>= 语义）', at(750_000, 2).compact === true);
check('阈值可配（80% 时 75% 不动手）',
  at(780_000, 2, { cfg: { ...DEFAULT_FALLBACK, ratio: 0.8 } }).compact === false);
check('需要次数可配（1 次就动手）',
  at(800_000, 1, { cfg: { ...DEFAULT_FALLBACK, afterUnansweredNudges: 1 } }).compact === true);
check('决策里带比例，便于面板显示', Math.round(at(800_000, 2).ratio * 100) === 80);

// ── 3. 兜底记录（面板"为什么动手"）──────────────────────────────────────
console.log('\n兜底记录（makeFallbackRecord）');
const rec = makeFallbackRecord({ at: 1_700_000_000_000, sessionId: 'session-x', reason: 'nudge-unanswered', compact: true, ratio: 0.78 });
check('记录带时间/会话/原因/是否尝试', rec.at === 1_700_000_000_000 && rec.sessionId === 'session-x' &&
  rec.reason === 'nudge-unanswered' && rec.attempted === true);
check('记录带百分比（78%）', rec.percent === 78, rec.percent);
check('detail 截断到 200 字', makeFallbackRecord({ at: 1, reason: 'x', compact: false, detail: 'y'.repeat(500) }).detail.length === 200);
check('没有 detail 时不带该字段', !('detail' in makeFallbackRecord({ at: 1, reason: 'x', compact: false })));

// ── 4. 接线检查 ────────────────────────────────────────────────────────
console.log('\n接线检查');
const engineSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'lib', 'engine.mjs'), 'utf8');
const nudgeSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'lib', 'nudge.mjs'), 'utf8');
const indexSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'lib', 'index.js'), 'utf8');
const runtime = JSON.parse(readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'config', 'runtime.json'), 'utf8'));
const preset = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'config', 'preset-override.generated.yml'), 'utf8');

check('引擎提供 compactByFallback（走父类 pressure 策略）',
  /async compactByFallback\(agent, signal\)/.test(engineSrc) && /super\.compactIfNeeded\(agent, 'pressure', signal\)/.test(engineSrc));
check('compactByFallback 只在 acp backend 生效',
  /if \(this\.backend !== 'acp'\) return null;/.test(engineSrc));
check('nudge 在 pre-step 里调用兜底', /compactByFallback\(agent, payload\.signal\)/.test(nudgeSrc));
check('nudge 用日志计数判断"未被响应"', /countUnansweredNudges\(agent\.session/.test(nudgeSrc));
check('兜底有节流（避免每步重试）', /retryCooldownSteps/.test(nudgeSrc) && /lastFallbackStep/.test(nudgeSrc));
check('兜底记录写进 state（面板可见）', /recordFallback\(agent/.test(nudgeSrc));
check('runtime 默认值包含 fallback 与 handoff',
  runtime?.fallback?.ratio === 0.75 && runtime?.fallback?.afterUnansweredNudges === 2 &&
  runtime?.handoff?.afterCompactions === 2);
check('生成物把兜底阈值写进引擎行（75%，与面板同源）',
  /thresholdRatio: 0\.75/.test(preset));
check('根插件创建并安装交接文档写入器',
  /deps\.handoff = createHandoff\(/.test(indexSrc) && /yield installHandoff\(deps\)/.test(indexSrc));
check('交接文档挂在 agent 作用域的 turn/end 上（根看不到 scoped 事件）',
  /agent\.ctx\.on\('session\/event'/.test(indexSrc) && /event\?\.type !== 'turn\/end'/.test(indexSrc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
