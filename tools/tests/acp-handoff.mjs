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
 *   2. **该写才写**：未达次数不写、禁用不写、同一会话只写一份（含重启后认回旧文件）；
 *   3. **失败不静默**：写入失败返回 `{written:false, reason:'write-failed', error}`。
 *
 * 全部离线：用假 session（snapshotEvents + header.cwd）+ 临时目录。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HANDOFF,
  buildHandoff,
  collectStats,
  createHandoff,
  handoffSessionKey,
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

// ── 4. 写入器（该写才写 / 只写一份 / 失败可见）─────────────────────────
console.log('\n写入器（createHandoff）');
const dir = mkdtempSync(join(tmpdir(), 'acp-handoff-'));
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

  const two = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2 } });
  const written = await two.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 2 }) });
  check('压缩 2 次 → 写出', written.written === true && written.reason === 'written', written);
  const files = readdirSync(dir);
  check('文件名带插件前缀与次数', files.length === 1 && files[0].startsWith('HANDOFF-context-acp-77777777-c2-'), files);
  const text = readFileSync(join(dir, files[0]), 'utf8');
  check('落盘内容与 builder 一致（含摘要）', text.includes('第 2 次压缩的摘要'));

  const again = await two.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 2 }) });
  check('同一会话再触发 → 认缓存，不写第二份', again.written === true && again.reason === 'cached' && readdirSync(dir).length === 1);

  const restarted = createHandoff({ cfg: { ...DEFAULT_HANDOFF, afterCompactions: 2 } });
  const existing = await restarted.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 2 }) });
  check('新进程（无缓存）→ 认回磁盘上的旧文件', existing.written === true && existing.reason === 'existing' && readdirSync(dir).length === 1);

  const disabled = createHandoff({ cfg: { ...DEFAULT_HANDOFF, enabled: false, afterCompactions: 1 } });
  const off = await disabled.maybeHandoff({ ...fakeSession, snapshotEvents: () => makeEvents({ compactions: 2 }) });
  check('禁用 → 不写', off.written === false && off.reason === 'disabled');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 5. 接线检查 ────────────────────────────────────────────────────────
console.log('\n接线检查');
const indexSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'lib', 'index.js'), 'utf8');
const clientSrc = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'client.js'), 'utf8');
const runtime = JSON.parse(readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'config', 'runtime.json'), 'utf8'));
check('根插件在装配时创建 handoff 写入器', /deps\.handoff = createHandoff\(/.test(indexSrc));
check('handoff 挂在 agent 作用域（根看不到 scoped session/event）',
  /agent\.ctx\.on\('session\/event'/.test(indexSrc));
check('只在 turn/end 上检查（不做步级写盘）', /event\?\.type !== 'turn\/end'/.test(indexSrc));
check('runtime.json 的 handoff 配置存在且默认 2 次',
  runtime?.handoff?.enabled === true && runtime?.handoff?.afterCompactions === 2);
check('面板显示交接文档状态', /panel\.handoff/.test(clientSrc) && /handoffNotWritten/.test(clientSrc));
check('面板可调"压满几次"', /handoffAfter/.test(clientSrc) && /HANDOFF_MIN/.test(clientSrc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
