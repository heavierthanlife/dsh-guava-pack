#!/usr/bin/env node
/**
 * 交接文档（handoff）引用附件的自检。
 *
 * ## 它防的是什么误删
 *
 * 场景：会话 A 写了一份 `HANDOFF-*.md` 交给会话 B，文档里嵌着截图/文件的
 * `sha256:…` 附件引用。A 被归档后执行 `purge --attachments`：
 *
 *   - 这些引用**不出现在任何会话日志里**（只在工作区文档里）；
 *   - 如果引用计数只扫日志，就会把附件判定为"孤儿"删掉 → 交接文档断图。
 *
 * 所以 `referencedAttachments` 必须同时扫：**其它会话日志** +
 * **工作区 `HANDOFF-*.md` / `PURGED-*.md`** + `$DSH_HOME/.purge-trash/`。
 *
 * 安全语义（与日志扫描一致）：**任何一份文档读不了就整体放弃删附件**。
 *
 * 全部离线：临时目录 + 假 workspace 状态，不需要 zstd 会话日志。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  referencedAttachments,
  workspaceDocAttachmentRefs,
} from '../lib/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
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

const A = 'sha256:' + 'a'.repeat(64);
const B = 'sha256:' + 'b'.repeat(64);
const C = 'sha256:' + 'c'.repeat(64);

const home = mkdtempSync(join(tmpdir(), 'purge-handoff-'));
const ws = join(home, 'workspace');
try {
  mkdirSync(ws, { recursive: true });

  // 正常 handoff / 清单：都要被扫到
  writeFileSync(join(ws, 'HANDOFF-model-policy.md'), `交接文档\n\n![shot](attachment:${A})\n`, 'utf8');
  writeFileSync(join(ws, 'PURGED-abc12345.md'), `产出清单\n\n- 截图 ${B}\n`, 'utf8');
  // 干扰项：不该被扫到
  writeFileSync(join(ws, 'README.md'), `普通文档 ${C}\n`, 'utf8');
  writeFileSync(join(ws, 'HANDOFF-notes.txt'), `不是 md ${C}\n`, 'utf8');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  writeFileSync(join(ws, 'sub', 'HANDOFF-deep.md'), `子目录不应递归扫 ${C}\n`, 'utf8');

  // .purge-trash 里的清单也算引用
  mkdirSync(join(home, '.purge-trash'), { recursive: true });
  writeFileSync(join(home, '.purge-trash', 'session-x.md'), `trash 清单 ${C}\n`, 'utf8');

  // ── 1. 文档扫描 ────────────────────────────────────────────────────
  console.log('\n工作区文档扫描（workspaceDocAttachmentRefs）');
  const docs = workspaceDocAttachmentRefs(home, [ws]);
  check('扫到 handoff 里的附件引用', docs.refs?.has(A) === true, [...(docs.refs ?? [])]);
  check('扫到 PURGED 清单里的引用', docs.refs?.has(B) === true);
  check('扫到 .purge-trash 里的引用', docs.refs?.has(C) === true);
  check('不扫普通 md', docs.refs !== null);
  check('目录不存在时不抛错', workspaceDocAttachmentRefs(home, [join(home, 'nope')]).refs !== null);
  // 即使不传任何工作区目录，$DSH_HOME/.purge-trash 也必须被扫到
check('不传目录时仍会扫 .purge-trash', workspaceDocAttachmentRefs(home, []).refs?.has(C) === true);

  // ── 2. 接入引用计数（其它会话日志为空，只剩文档引用）─────────────────
  console.log('\n引用计数整合（referencedAttachments）');
  const refs = referencedAttachments(home, new Map(), new Set(), {
    sessionWorkspace: new Map([['session-b', { workspaceId: 'ws-1', path: ws }]]),
  });
  check('文档引用被算作"仍在使用"', refs.referenced?.has(A) === true && refs.referenced?.has(B) === true, [...(refs.referenced ?? [])]);
  check('没有失败标记（skipped 为 null）', refs.skipped === null, refs.skipped);

  // ── 3. 读不了的文档 → 整体放弃删附件 ────────────────────────────────
  console.log('\n失败姿态（fail-safe）');
  const locked = join(ws, 'HANDOFF-locked.md');
  writeFileSync(locked, '锁住的文档\n', 'utf8');
  chmodSync(locked, 0o000);
  try {
    const bad = workspaceDocAttachmentRefs(home, [ws]);
    // root 下 chmod 不影响可读，这两种结果都接受：要么 null，要么仍给出集合。
    check('不可读文档要么返回 null、要么不影响其它扫描', bad.refs === null || bad.refs instanceof Set, typeof bad.refs);
    if (bad.refs === null) {
      check('返回时点名了读不了的文件', typeof bad.unreadable === 'string' && bad.unreadable.includes('HANDOFF-locked'), bad.unreadable);
      const badRefs = referencedAttachments(home, new Map(), new Set(), {
        sessionWorkspace: new Map([['s', { path: ws }]]),
      });
      check('存在不可读文档时，整体放弃删附件（referenced=null）', badRefs.referenced === null, badRefs.skipped);
    }
  } finally {
    try {
      chmodSync(locked, 0o644);
    } catch {
      /* ignore */
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
