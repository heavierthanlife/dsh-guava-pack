#!/usr/bin/env node
/**
 * tools/tests/backup-host-tag.mjs — 备份的机器 tag 回归门禁。
 *
 * 为什么需要（2026-11-12 真实事故）：
 *   两台 PC（YGY12 / MSI）备份到**同一仓库、同一路径、同一用户名**，
 *   只靠 restic 的 `--host` 区分。于是 `restore latest` / `ls latest` 会随机
 *   命中另一台 —— 在主力机上恢复文件，拿到的是 MSI 的快照（实测踩到）。
 *
 * 修复：`restic-backup.sh` 额外打 `host-<短主机名小写>` tag。
 * 这个测试钉住两件事：脚本**确实传了两个 tag**，以及 tag 的**归一化规则**。
 *
 * 用法：node tools/tests/backup-host-tag.mjs
 *
 * @module tools/tests/backup-host-tag
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const SRC = join(PACK, 'ops', 'backup', 'restic-backup.sh');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const script = readFileSync(SRC, 'utf8');

// ── 静态断言 ──────────────────────────────────────────────────────────────
check('保留 dsh-nightly tag（历史兼容）', /--tag dsh-nightly/.test(script));
check('额外传机器 tag（--tag "$HOST_TAG"）', /--tag "\$HOST_TAG"/.test(script));
check('机器 tag 由 hostname 推导', /HOST_TAG="host-\$\(hostname/.test(script));
check('短主机名优先（hostname -s）', /hostname -s/.test(script));
check('归一化：大写转小写', /tr 'A-Z' 'a-z'/.test(script));
check('归一化：非法字符换 -', /tr -c 'a-z0-9\._-' '-'/.test(script));
check('归一化：去掉结尾多余 -', /\$\{HOST_TAG%-}/.test(script));

// ── 行为断言：复刻归一化逻辑，验证真实主机名的产出 ────────────────────────
function hostTag(hostname) {
  let tag = `host-${hostname}`;
  tag = tag.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return tag.replace(/-+$/, '');
}
const cases = [
  ['YGY12', 'host-ygy12'],
  ['ygy12', 'host-ygy12'],
  ['MSI', 'host-msi'],
  ['msi', 'host-msi'],
  ['my pc', 'host-my-pc'],
  ['node_1.local', 'host-node_1.local'],
  ['HOST-', 'host-host'], // 尾部连字符被剥掉
];
for (const [input, want] of cases) {
  const got = hostTag(input);
  check(`归一化 "${input}" → "${want}"`, got === want, got);
}

// tag 必须能安全放进 restic 的 --tag（不含空格/中文/斜杠）
const weird = hostTag('我的电脑 (2)');
check('中文/括号主机名被转成安全字符', /^host-[a-z0-9._-]*$/.test(weird), weird);
check('tag 不含空格', !hostTag('a b c').includes(' '), hostTag('a b c'));

// ── 契约：两个 tag 同时存在（不能只剩一个） ───────────────────────────────
// 只统计**非注释行**里的 --tag（注释里会举例提到 `--tag host-MSI`，不能算进去）
const tagLines = script
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .filter((l) => /--tag /.test(l));
check('恰好两条 --tag 行', tagLines.length === 2, `lines=${tagLines.length}`);
check('两条 tag 都直接紧跟 `"$@"` 之前（同一 backup 命令）',
  /--tag dsh-nightly \\\n\s+--tag "\$HOST_TAG" \\\n\s+"\$@"/.test(script));

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} ${passed}/${passed + failures.length}${failures.length ? ` — ${failures.join('; ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
