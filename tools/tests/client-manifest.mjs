#!/usr/bin/env node
/**
 * tools/tests/client-manifest.mjs — 浏览器端 client manifest 的回归门禁。
 *
 * 为什么需要（2026-11-26 真实事故）：
 *   有人在 bundle patch 里加了 4 行「同名同 id」的补丁，以为等于补插：
 *
 *       - id: ui-context-menu
 *         name: "@deepseek-ai/dsh-client-ui-context-menu"
 *       - id: ui-file-drag
 *         name: "@deepseek-ai/dsh-client-ui-file-drag"
 *
 *   但 Loader patch 方言规定：**只有 `insert:` 能新增行**；带 id 且无 insert 的
 *   patch 只会定位并覆盖已存在的行（真值 `name` 仅断言，不改名、不插入）。
 *   于是这两行被「盖了补丁章」，从 client manifest 里消失：79 个模块而不是 83 个。
 *   随后 contextMenus / fileDrag 服务不存在 → 二十多个客户端插件 pending →
 *   "N required entries did not activate"，界面只剩空壳。
 *
 *   这个故障**服务端完全干净**：host 0 warning、`--dump-config` 照样打印两行、
 *   `check-boot` 只看日志和端口 —— 唯一能看见它的是浏览器端真正收到的模块清单。
 *   所以本文件补的正是这块空白。
 *
 * 做法：从 `~/dsh/logs/web-run.log` 取本次启动的 token，抓 `/?token=…`，
 *       解析 `globalThis["__DSH_BOOT__"].entries`，断言关键模块在列、id 不重复、
 *       条目数不低于下限。内置「回归夹具」自证判定逻辑确实能抓住 79/缺模块那种载荷。
 *
 * 服务没在跑时**明确跳过并 exit 0**（`npm test` 用 `&&` 串起来，不能因此断链）。
 *
 * 用法：
 *   node tools/tests/client-manifest.mjs
 *   node tools/tests/client-manifest.mjs --json
 *   DSH_MANIFEST_MIN=80 node tools/tests/client-manifest.mjs   # 收紧下限（本机基线 83）
 *
 * @module tools/tests/client-manifest
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), 'dsh');
const LOG = process.env.DSH_CHECK_LOG || join(DSH_HOME, 'logs', 'web-run.log');
const PORT = process.env.DSH_WEB_PORT || '3080';
const BASE = `http://127.0.0.1:${PORT}`;
const MIN = Number(process.env.DSH_MANIFEST_MIN || 60);
const JSON_OUT = process.argv.includes('--json');

/**
 * 升级到 0.2.2-rc.5 后必须出现在 manifest 里的客户端模块。
 * 缺任一条 → contextMenus / fileDrag 服务不存在 → 界面空壳。
 */
const REQUIRED_MODULES = [
  '@deepseek-ai/dsh-client-ui-context-menu',
  '@deepseek-ai/dsh-client-ui-file-drag',
];

/**
 * 判定一份 boot 载荷是否健康。纯函数，便于用夹具自证。
 *
 * @param {unknown} boot `__DSH_BOOT__` 解析后的对象
 * @returns {{ ok: boolean, count: number, problems: string[] }}
 */
export function evaluateManifest(boot) {
  const problems = [];
  const entries = boot && Array.isArray(boot.entries) ? boot.entries : null;
  if (!entries) {
    return { ok: false, count: 0, problems: ['载荷里没有 entries 数组'] };
  }
  const ids = entries.map((e) => (e && typeof e.id === 'string' ? e.id : ''));
  const count = ids.length;

  const missing = REQUIRED_MODULES.filter((m) => !ids.includes(m));
  for (const m of missing) problems.push(`缺模块：${m}`);

  const seen = new Set();
  const dup = new Set();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  for (const id of dup) problems.push(`重复条目 id：${id}`);

  const empty = ids.filter((id) => !id).length;
  if (empty > 0) problems.push(`${empty} 条条目没有 id`);

  if (count < MIN) problems.push(`条目数 ${count} 低于下限 ${MIN}`);

  return { ok: problems.length === 0, count, problems };
}

/** 从启动日志里取最后一次出现的 token。 */
function readToken() {
  if (!existsSync(LOG)) return null;
  const text = readFileSync(LOG, 'utf8');
  const all = [...text.matchAll(/token=([A-Za-z0-9_-]{8,})/g)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * 抓首页并取出 `__DSH_BOOT__`。
 * 服务端会先用 303 + Set-Cookie 换掉 query token，所以要手动带 cookie 跟一跳。
 */
async function fetchBoot(token) {
  const url = `${BASE}/?token=${encodeURIComponent(token)}`;
  let res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    const next = loc ? new URL(loc, BASE).toString() : `${BASE}/`;
    res = await fetch(next, {
      headers: cookie ? { cookie } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
  }
  if (!res.ok) throw new Error(`抓首页失败：HTTP ${res.status}`);

  const html = await res.text();
  const marker = 'globalThis["__DSH_BOOT__"] = ';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('页面里没有 __DSH_BOOT__ 载荷');
  const end = html.indexOf('</script>', at);
  const raw = html.slice(at + marker.length, end).trim().replace(/;$/, '');
  return JSON.parse(raw);
}

/** 造一份最小合法载荷，避免夹具被真实计数掩盖问题。 */
function fixture(ids) {
  return { rev: 'fixture', entries: ids.map((id) => ({ id, url: `plugins/${id}/client.js` })) };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  if (!JSON_OUT) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// ── 1. 夹具自证：判定逻辑必须真的抓得住那次故障 ────────────────────────────
// 健康载荷要同时**满足下限**且含关键模块，否则会被「条目数不足」判红，
// 反而掩盖掉我们真正想钉的那条断言。
const GOOD = [
  ...REQUIRED_MODULES,
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-sidebar',
  ...Array.from({ length: Math.max(0, MIN) }, (_, i) => `@deepseek-ai/fixture-${i}`),
];

const full = evaluateManifest(fixture(GOOD));
check('夹具：健康的载荷判定为通过', full.ok, full.problems.join('; '));

// 事故复刻：79 条、缺那两个模块（数量过下限，只能靠模块缺失抓出来）
const brokenIds = Array.from({ length: 79 }, (_, i) => `@deepseek-ai/plugin-${i}`);
const broken = evaluateManifest(fixture(brokenIds));
check('夹具：缺 ui-context-menu / ui-file-drag 会被判失败', !broken.ok);
check('夹具：失败原因点名这两个模块',
  REQUIRED_MODULES.every((m) => broken.problems.some((p) => p.includes(m))),
  broken.problems.join('; '));

// 只有「数量够、模块缺」这一种才是那次事故的真形态，必须能被抓到。
// 用固定基线而不是 MIN：否则一旦有人调高 DSH_MANIFEST_MIN，
// 这条会退化成「数量不足」而失去对「数量正常但模块缺」的鉴别力。
const FIXTURE_FLOOR = 60;
check('夹具：条目数达标但缺模块仍然失败', broken.count >= FIXTURE_FLOOR && !broken.ok, `${broken.count} 条`);

const dupPayload = evaluateManifest(fixture([...GOOD, GOOD[0]]));
check('夹具：重复 id 会被判失败', !dupPayload.ok && dupPayload.problems.some((p) => p.includes('重复')));

const emptyPayload = evaluateManifest({});
check('夹具：没有 entries 会被判失败', !emptyPayload.ok);

// ── 2. 真实运行态 ──────────────────────────────────────────────────────────
const token = readToken();
let liveState = 'skipped';

if (!token) {
  liveState = 'no-token';
  if (!JSON_OUT) console.log(`  skip  没在 ${LOG} 里找到 token（服务没起过？）—— 跳过实机校验`);
} else {
  let boot = null;
  try {
    boot = await fetchBoot(token);
  } catch (err) {
    liveState = 'unreachable';
    if (!JSON_OUT) console.log(`  skip  连不上 ${BASE}（${err.message}）—— 跳过实机校验`);
  }
  if (boot) {
    liveState = 'checked';
    const v = evaluateManifest(boot);
    const ids = boot.entries.map((e) => e.id);
    check('实机：client manifest 判定通过', v.ok, v.problems.join('; '));
    check('实机：ui-context-menu 在列', ids.includes(REQUIRED_MODULES[0]));
    check('实机：ui-file-drag 在列', ids.includes(REQUIRED_MODULES[1]));
    check('实机：条目 id 无重复', new Set(ids).size === ids.length,
      `${v.count} 条 / ${new Set(ids).size} 个唯一 id`);
    check('实机：条目数达到下限', v.count >= MIN, `${v.count} 条（下限 ${MIN}）`);
    check('实机：release 版本可读', typeof boot.release?.version === 'string', boot.release?.version ?? '(无)');
    if (!JSON_OUT) {
      console.log(`  ℹ️  实际条目数 ${v.count}；release ${boot.release?.version ?? '?'}`);
    }
  }
}

// ── 3. 结论 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const passed = results.length - failed.length;

if (JSON_OUT) {
  console.log(JSON.stringify({ passed, failed: failed.length, liveState, failures: failed }, null, 2));
} else {
  console.log(`\n${passed} passed, ${failed.length} failed${liveState === 'checked' ? '' : `（实机校验：${liveState}）`}`);
}
process.exit(failed.length ? 1 : 0);
