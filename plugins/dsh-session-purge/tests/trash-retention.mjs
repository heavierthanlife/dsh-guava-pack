#!/usr/bin/env node
/**
 * 回滚区保留策略自检（2026-10-30）。
 *
 * ## 为什么必须有这份测试
 *
 * 这个功能会**真删用户磁盘上的回滚点**（`.purge-trash/<时间戳>/`）。它只有两个
 * 安全支点：
 *   1. 只认我们自己创建的目录名（14 位 UTC 时间戳，可带 -2 后缀）；
 *   2. `.purge-trash/*.md` 是清单/跨会话交接载体，附件引用扫描要读 —— 永远不能删。
 * 所以测试重点不是"策略算得对不对"（那是纯函数），而是**边界**：未知目录、
 * 符号链接、清单、最新一个、以及 dry-run 不动盘。
 *
 * 覆盖：
 *   · parseTrashName / normalizeTrashPolicy 的边界；
 *   · selectTrashEvictions：时间/数量/体积/组合/0=关闭/最新保留/--all；
 *   · buildTrashPlan：真实临时目录、.md 与未知目录不受影响、符号链接不跟随；
 *   · applyTrashPlan：只删名单、拒绝名字不符、失败不中断；
 *   · planDigest 绑回滚区名单；executePlan 会顺带执行并回传结果；
 *   · CLI `--gc-trash` 端到端（临时 DSH_HOME）。
 *
 * 零第三方依赖，全程临时目录，结束即删。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRASH_DEFAULTS,
  applyTrashPlan,
  buildTrashPlan,
  collectTrashEntries,
  executePlan,
  normalizeTrashPolicy,
  parseTrashName,
  planDigest,
  renderTrashPlan,
  selectTrashEvictions,
} from '../lib/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'lib', 'core.mjs');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0); // 2026-10-30T12:00:00Z
const stamp = (at) => new Date(at).toISOString().replace(/[-:T]/g, '').slice(0, 14);

// ── 1. 命名解析 ─────────────────────────────────────────────────────────────
console.log('\n命名解析（parseTrashName）');
check('正常时间戳', parseTrashName('20261030120000') === NOW, parseTrashName('20261030120000'));
check('去重后缀 -2 可解析', parseTrashName('20261030120000-2') === NOW);
check('非 14 位不认', parseTrashName('202610301200') === undefined);
check('非法日期不认（13 月/32 日）',
  parseTrashName('20261330120000') === undefined && parseTrashName('20261032120000') === undefined);
check('普通目录名不认', parseTrashName('backup') === undefined && parseTrashName('20261030') === undefined);
check('非法输入不抛', parseTrashName(null) === undefined && parseTrashName(undefined) === undefined);

// ── 2. 策略归一化 ───────────────────────────────────────────────────────────
console.log('\n策略归一化（normalizeTrashPolicy）');
{
  const d = normalizeTrashPolicy({});
  check('空对象 → 默认 7 天 / 2 GiB / 10 个',
    d.maxAgeDays === TRASH_DEFAULTS.maxAgeDays
    && d.maxBytes === TRASH_DEFAULTS.maxBytes
    && d.maxEntries === TRASH_DEFAULTS.maxEntries, d);
  const negative = normalizeTrashPolicy({ maxAgeDays: -1, maxBytes: -5, maxEntries: -2 });
  check('负数回落到默认值',
    negative.maxAgeDays === TRASH_DEFAULTS.maxAgeDays && negative.maxBytes === TRASH_DEFAULTS.maxBytes
    && negative.maxEntries === TRASH_DEFAULTS.maxEntries, negative);
  const clamped = normalizeTrashPolicy({ maxAgeDays: 9999, maxEntries: 9999 });
  check('超上限被夹取（365 天 / 100 个）', clamped.maxAgeDays === 365 && clamped.maxEntries === 100, clamped);
  const zero = normalizeTrashPolicy({ maxAgeDays: 0, maxBytes: 0, maxEntries: 0 });
  check('0 = 关闭该维度（原样保留 0）', zero.maxAgeDays === 0 && zero.maxBytes === 0 && zero.maxEntries === 0, zero);
  check('小数被取整', normalizeTrashPolicy({ maxAgeDays: 3.9 }).maxAgeDays === 3);
}

// ── 3. 纯选择逻辑 ───────────────────────────────────────────────────────────
console.log('\n选择逻辑（selectTrashEvictions）');
const mk = (name, ageDays, bytes) => ({ name, at: NOW - ageDays * DAY, bytes });
{
  const entries = [mk('20261030120000', 0, 10), mk('20261029120000', 1, 20), mk('20261020120000', 10, 30)];
  const picked = selectTrashEvictions(entries, { maxAgeDays: 7, maxBytes: 0, maxEntries: 0 }, { now: NOW });
  check('时间策略：超 7 天的被删，最新恒留',
    picked.evicted.length === 1 && picked.evicted[0].name === '20261020120000'
    && picked.kept.some((e) => e.name === '20261030120000'), picked.evicted);
  check('时间策略：未超龄不删',
    selectTrashEvictions(entries, { maxAgeDays: 30, maxBytes: 0, maxEntries: 0 }, { now: NOW }).evicted.length === 0);
}
{
  const entries = [mk('00000000000001', 0, 1), mk('00000000000002', 1, 1), mk('00000000000003', 2, 1), mk('00000000000004', 3, 1)];
  const picked = selectTrashEvictions(entries, { maxAgeDays: 0, maxBytes: 0, maxEntries: 2 }, { now: NOW });
  check('数量策略：最多 2 个 → 删最旧 2 个',
    picked.evicted.length === 2 && picked.evicted.every((e) => e.reasons.includes('entries')), picked.evicted);
}
{
  const entries = [mk('20261030120000', 0, 100), mk('20261029120000', 1, 100), mk('20261028120000', 2, 100)];
  const picked = selectTrashEvictions(entries, { maxAgeDays: 0, maxBytes: 250, maxEntries: 0 }, { now: NOW });
  check('体积策略：总量 300 > 250 → 从最旧删到 200',
    picked.evicted.length === 1 && picked.evicted[0].name === '20261028120000', picked.evicted);
}
{
  const entries = [mk('20261030120000', 0, 1000), mk('20261029120000', 1, 1000)];
  const picked = selectTrashEvictions(entries, { maxAgeDays: 0, maxBytes: 500, maxEntries: 0 }, { now: NOW });
  check('体积超限也不删最新一个（最新恒留）',
    picked.evicted.length === 1 && picked.evicted[0].name === '20261029120000'
    && picked.kept.length === 1 && picked.kept[0].name === '20261030120000', picked);
}
{
  const entries = [mk('20261030120000', 0, 10), mk('20261029120000', 1, 10)];
  const all = selectTrashEvictions(entries, { maxAgeDays: 7, maxBytes: 0, maxEntries: 0 }, { now: NOW, all: true });
  check('--all：全部删除（含最新）', all.evicted.length === 2 && all.kept.length === 0, all);
}
check('空列表不抛', selectTrashEvictions([], {}, { now: NOW }).evicted.length === 0);

// ── 4. 真实目录：扫描与安全边界 ─────────────────────────────────────────────
console.log('\n真实目录（buildTrashPlan / applyTrashPlan）');
const home = mkdtempSync(join(tmpdir(), 'purge-trash-test-'));
try {
  const root = join(home, '.purge-trash');
  mkdirSync(root, { recursive: true });
  const oldName = '20261020120000'; // 10 天前
  const newName = stamp(NOW - DAY);
  const sideName = '20261025120000'; // 5 天前
  for (const [name, size] of [[oldName, 400], [newName, 300], [sideName, 200]]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'data.bin'), Buffer.alloc(size));
  }
  // 非回滚点：清单 md、未知目录、文件、符号链接 —— 都不能被删/跟随。
  writeFileSync(join(root, 'PURGED-session-x.md'), 'referenced by attachments scan');
  writeFileSync(join(root, 'session-abc.md'), 'manifest');
  mkdirSync(join(root, 'keep-me'));
  writeFileSync(join(root, 'not-a-dir'), 'x');
  const linkPath = join(root, '20261019120000'); // 看起来像回滚点的符号链接
  symlinkSync(join(root, 'keep-me'), linkPath);

  const trash = buildTrashPlan({ home, policy: { maxAgeDays: 7, maxBytes: 0, maxEntries: 0 }, now: NOW });
  check('只把真实时间戳目录当回滚点', trash.entries.length === 3, trash.entries.map((e) => e.name));
  check('未知目录/文件/符号链接进 invalid，不算回滚点',
    trash.invalid.includes('keep-me') && trash.invalid.includes('not-a-dir') && trash.invalid.includes('20261019120000'), trash.invalid);
  check('.md 清单不参与清理', trash.invalid.every((n) => !n.endsWith('.md')), trash.invalid);
  check('按策略只选中超 7 天的那一个',
    trash.evicted.length === 1 && trash.evicted[0].name === oldName, trash.evicted.map((e) => e.name));
  check('最新回滚点保留', trash.kept.some((e) => e.name === newName));
  check('dry-run 不改盘（旧目录仍在）', existsSync(join(root, oldName)));

  const rendered = renderTrashPlan(trash);
  check('CLI 文本包含策略与将清理项',
    rendered.includes('将清理 1 个') && rendered.includes(oldName) && rendered.includes('7 天'), rendered.slice(0, 300));

  // apply：只删名单里的；md/未知目录/符号链接都不动。
  const result = applyTrashPlan(trash);
  check('apply 删除 1 个且释放 400B',
    result.removed.length === 1 && result.removed[0].name === oldName && result.freedBytes === 400, result);
  check('旧回滚点已消失', !existsSync(join(root, oldName)));
  check('.md 清单仍在', existsSync(join(root, 'PURGED-session-x.md')) && existsSync(join(root, 'session-abc.md')));
  check('未知目录仍在', existsSync(join(root, 'keep-me')));
  check('符号链接没被跟随删除（目标仍在、链接仍在）',
    existsSync(join(root, 'keep-me')) && lstatSync(linkPath).isSymbolicLink());

  // 拒绝名字不符/越界的伪造条目。
  const fake = {
    root,
    evicted: [
      { name: 'evil', path: join(root, '..', 'evil'), bytes: 1, reasons: ['all'] },
      { name: '20261020120000', path: join(root, '20261020120000'), bytes: 1, reasons: ['all'] },
    ],
  };
  const fakeResult = applyTrashPlan(fake);
  check('伪造/不存在的回滚点被拒绝，不误删',
    fakeResult.removed.length === 0 && fakeResult.failures.length === 2, fakeResult);

  // 老的全清：--all
  const all = buildTrashPlan({ home, policy: {}, now: NOW, all: true });
  const allResult = applyTrashPlan(all);
  check('--all 清空剩余回滚点（含最新）',
    allResult.removed.length === 2 && all.entries.length === 2, allResult);
  check('--all 也不碰 .md 与未知目录',
    existsSync(join(root, 'PURGED-session-x.md')) && existsSync(join(root, 'keep-me')));

  // collectTrashEntries 可能为空（刚清完），只断言不抛。
  check('collectTrashEntries 空目录不抛', collectTrashEntries(home).entries.length === 0);
} finally {
  rmSync(home, { recursive: true, force: true });
}

// ── 5. 计划指纹 + executePlan 顺带清理 ──────────────────────────────────────
console.log('\n指纹与执行联动（planDigest / executePlan）');
const home2 = mkdtempSync(join(tmpdir(), 'purge-trash-exec-'));
try {
  const root = join(home2, '.purge-trash');
  mkdirSync(root, { recursive: true });
  const old1 = '20261010120000';
  const old2 = '20261015120000';
  for (const name of [old1, old2]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'x'), 'x');
  }
  const trashPlan = buildTrashPlan({ home: home2, policy: { maxAgeDays: 7, maxBytes: 0, maxEntries: 0 }, now: NOW });
  const basePlan = { home: home2, entries: [], missing: [], archived: [], workspaceFile: join(home2, 'storages', 'workspace.json') };
  const withTrash = { ...basePlan, trash: trashPlan };
  const withoutTrash = planDigest(basePlan, { mode: 'trash' });
  const digestA = planDigest(withTrash, { mode: 'trash' });
  const digestB = planDigest({ ...withTrash, trash: { ...trashPlan, evicted: trashPlan.evicted.slice(0, 1) } }, { mode: 'trash' });
  check('指纹包含回滚区名单（不同名单 → 不同指纹）', digestA !== withoutTrash && digestA !== digestB);

  const executed = executePlan(basePlan, { mode: 'trash', trashPlan });
  check('executePlan 顺带执行回滚区清理并回传结果',
    executed.trash !== null && executed.trash.removed.length === 2, executed.trash);
  check('两个过期回滚点已删', !existsSync(join(root, old1)) && !existsSync(join(root, old2)));
} finally {
  rmSync(home2, { recursive: true, force: true });
}

// ── 6. CLI 端到端（--gc-trash） ─────────────────────────────────────────────
console.log('\nCLI（--gc-trash）');
const home3 = mkdtempSync(join(tmpdir(), 'purge-trash-cli-'));
try {
  const root = join(home3, '.purge-trash');
  mkdirSync(root, { recursive: true });
  const oldName = '20261020120000';
  mkdirSync(join(root, oldName));
  writeFileSync(join(root, oldName, 'x'), 'x');
  writeFileSync(join(root, 'PURGED-keep.md'), 'keep');
  const env = { ...process.env, DSH_HOME: home3 };
  const dry = execFileSync(process.execPath, [CLI, '--gc-trash'], { encoding: 'utf8', env });
  check('dry-run 输出将清理项且不删文件', dry.includes(oldName) && existsSync(join(root, oldName)), dry.slice(0, 200));
  const done = execFileSync(process.execPath, [CLI, '--gc-trash', '--confirm'], { encoding: 'utf8', env });
  check('--confirm 真删并报告', done.includes('清理完成') && !existsSync(join(root, oldName)), done);
  check('CLI 不动 .md 清单', existsSync(join(root, 'PURGED-keep.md')));
  const none = execFileSync(process.execPath, [CLI, '--gc-trash'], { encoding: 'utf8', env });
  check('空回滚区不报错', none.includes('（空）') || none.includes('没有需要清理'), none.slice(0, 200));
} finally {
  rmSync(home3, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
