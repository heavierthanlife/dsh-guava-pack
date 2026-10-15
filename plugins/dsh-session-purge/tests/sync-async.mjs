/**
 * dsh-session-purge 的自检：**同步驱动与异步驱动必须产出完全相同的后果**。
 *
 * ## 为什么这个测试必须有
 *
 * `lib/core.mjs` 把逻辑写成 generator（在昂贵步骤之间 `yield`），再用两个驱动器跑：
 *   · `driveSync`  —— 一路到底，CLI 用（独立进程，简单直接）；
 *   · `driveAsync` —— 每个 yield 点让出事件循环，**host 路由用**（DSH 唯一的那个事件循环，
 *                    解一份 4.5MB 日志要 ~200ms，同步跑会把正在流式输出的对话冻住）。
 *
 * 这两个驱动器共用同一份 generator 实现（generator 之间用 `yield*` 委托），
 * 所以理论上不可能漂移 —— 但"理论上"不值钱。**这个插件会删用户的数据**，
 * 而异步路径正是实际执行删除的那条；一旦两者对同一份数据得出不同的计划
 * （比如异步漏掉一个会话、或多算一个附件），后果是不可逆的。
 *
 * 所以这里用**真实数据**（本机 `$DSH_HOME` 下的会话）逐条比对，并额外覆盖
 * `attachments:true`（走附件引用扫描，逻辑分支更多）。
 *
 * 没有会话数据时跳过比对并明确说明（不算通过）—— 免得在空环境里假装绿灯。
 *
 * 用法：node tests/sync-async.mjs          （或 npm test）
 * 退出码：0 全部通过 / 1 有失败项
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  buildPlan,
  buildPlanAsync,
  decodeSessionLog,
  decodeSessionLogDetailed,
  decodeSessionLogDetailedAsync,
  extractSessionFacts,
  extractSessionFactsAsync,
  readStaleIds,
} from '../lib/core.mjs';

const home = process.env.DSH_HOME || join(homedir(), 'dsh');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

/** 收集真实的会话日志路径（只读）。 */
function findLogs() {
  const root = join(home, 'sessions');
  const out = [];
  if (!existsSync(root)) return out;
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(root, slug.name);
    for (const entry of readdirSync(slugDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const log = join(slugDir, entry.name, 'session.v4.jsonl.zstd');
      if (existsSync(log)) out.push(log);
    }
  }
  return out;
}

console.log(`DSH_HOME = ${home}`);

// ── 1. 逐帧解码：两条路径必须给出一样的文本与帧统计 ──────────────────
const logs = findLogs();
console.log(`\n找到 ${logs.length} 份真实会话日志`);

if (logs.length === 0) {
  console.log('  （本机没有会话日志，跳过逐条比对 —— 这是"没测到"，不是"通过"）');
} else {
  let mismatch = 0;
  let totalFrames = 0;
  let incomplete = 0;
  for (const log of logs) {
    const s = decodeSessionLogDetailed(log);
    const a = await decodeSessionLogDetailedAsync(log);
    totalFrames += s.frames;
    if (!s.complete) incomplete += 1;
    if (
      s.text !== a.text ||
      s.frames !== a.frames ||
      s.decodedFrames !== a.decodedFrames ||
      s.failedFrames !== a.failedFrames ||
      s.complete !== a.complete
    ) {
      mismatch += 1;
      console.error(`      不一致: ${log}`);
    }
  }
  check(`decodeSessionLogDetailed ≡ decodeSessionLogDetailedAsync（${logs.length} 份 / ${totalFrames} 帧）`, mismatch === 0, { mismatch });
  // 顺带确认走帧判据在这批数据上没误报（截断会被判 complete=false，这里应当全 true）
  check(`全部日志 by-frame 判定为完整（incomplete=${incomplete}）`, incomplete === 0, { incomplete });

  // ── 2. 逐行解析：两条路径结果必须一致 ──────────────────────────────
  let factsMismatch = 0;
  for (const log of logs) {
    const text = decodeSessionLog(log);
    const s = extractSessionFacts(text);
    const a = await extractSessionFactsAsync(text);
    const same =
      s.cwd === a.cwd &&
      JSON.stringify(s.files) === JSON.stringify(a.files) &&
      s.attachments.size === a.attachments.size &&
      [...s.attachments].every((x) => a.attachments.has(x));
    if (!same) {
      factsMismatch += 1;
      console.error(`      不一致: ${log}`);
    }
  }
  check(`extractSessionFacts ≡ extractSessionFactsAsync（${logs.length} 份）`, factsMismatch === 0, { factsMismatch });
}

// ── 3. 完整计划：同步 vs 异步必须逐字节相同 ──────────────────────────
// 这是最关键的一条：计划决定"删哪些"，两条路径必须给出同一个答案。
console.log('\n完整计划比对');
for (const attachments of [false, true]) {
  const s = buildPlan({ attachments });
  const a = await buildPlanAsync({ attachments });
  const same = JSON.stringify(s) === JSON.stringify(a);
  check(
    `buildPlan({attachments:${attachments}}) ≡ buildPlanAsync（${s.entries.length} 个会话）`,
    same,
    same ? undefined : { sync: s.entries.map((e) => e.id), async: a.entries.map((e) => e.id) },
  );
  // 再显式比对会真的被删掉的那批 id —— 这是不可逆的部分
  const idsSame = JSON.stringify(s.entries.map((e) => e.id)) === JSON.stringify(a.entries.map((e) => e.id));
  check(`  其中"将删除的 id 列表"逐项相同`, idsSame);
}

// ── 4. readStaleIds 与 buildPlan().missing 必须一致 ─────────────────
// 面板每次页面加载走 cheap 通道，`plan` 走完整通道；两者对"残留 id"的判断必须相同，
// 否则面板显示的残留列表与实际计划会对不上。
const stale = readStaleIds();
const plan = buildPlan({ attachments: false });
check(
  'readStaleIds().missing ≡ buildPlan().missing',
  JSON.stringify(stale.missing) === JSON.stringify(plan.missing),
  { stale: stale.missing, plan: plan.missing },
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
