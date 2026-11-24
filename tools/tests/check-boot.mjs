#!/usr/bin/env node
/**
 * tools/check-boot.mjs 的守卫测试。
 *
 * ## 为什么需要它
 *
 * 这个工具的价值全在「判断准不准」：它看的是**运行态**，而上游每次升级都可能
 * 换掉告警的措辞（`did not activate` / `pending (waiting for service: …)` /
 * `never started`）。措辞一变，它就从"哨兵"退化成"绿灯印章"——每次都说正常，
 * 什么也拦不住。那比没有更糟，因为它骗人。
 *
 * 所以这里用**合成日志**逐条钉住判定：
 *   ① 每种故障签名都要真的判红（负向）；
 *   ② 已知噪音不能误报（`[deepseek-account]` 之类）；
 *   ③ 只看**最后一段**：前面崩过、后来好了，就该是绿的；
 *   ④ `--advisory` 永远 exit 0（`install.mjs --check` 靠它不被打断）。
 *
 * 全部用 `DSH_CHECK_PORTS=none` 隔离端口状态，不依赖这台机器上有服务在跑。
 *
 * 用法：node tools/tests/check-boot.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const SCRIPT = join(PACK, 'tools/check-boot.mjs');

let passed = 0;
let failed = 0;

function ok(msg) {
  passed += 1;
  console.log(`  ✅ ${msg}`);
}
function no(msg, detail) {
  failed += 1;
  console.log(`  ❌ ${msg}`);
  if (detail) console.log(`     ${String(detail).replace(/\n/g, '\n     ').slice(0, 800)}`);
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-check-boot-'));
let seq = 0;

/** 造一个假 DSH_HOME，写入 logs/web-run.log。 */
function fixture(logText) {
  seq += 1;
  const home = join(ROOT, `home-${seq}`);
  if (logText !== null) {
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(join(home, 'logs', 'web-run.log'), logText, 'utf8');
  } else {
    mkdirSync(home, { recursive: true });
  }
  return home
}

/** 跑一次 checker。 */
function run(home, extraArgs = [], extraEnv = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_CHECK_PORTS: 'none',
      ...extraEnv,
    },
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` }
}

/** 成功判据：退出码 + 必须出现的子串 + 必须**不**出现的子串。 */
function expect(label, { code, out }, wantCode, must = [], mustNot = []) {
  const problems = [];
  if (code !== wantCode) problems.push(`退出码 ${code}，期望 ${wantCode}`);
  for (const s of must) if (!out.includes(s)) problems.push(`输出缺少：${s}`);
  for (const s of mustNot) if (out.includes(s)) problems.push(`输出不该有：${s}`);
  if (problems.length === 0) ok(label);
  else no(label, `${problems.join('；')}\n--- 输出 ---\n${out}`);
}

const BANNER = 'dsh web: http://127.0.0.1:3080/?token=FAKE-token_123\n';

console.log('tools/check-boot.mjs 判定测试\n');

// ── ① 干净的一段 ───────────────────────────────────────────────────────────
expect(
  '干净日志 → 绿、exit 0',
  run(fixture(`${BANNER}[llm-deepseek-account] model listing … loaded 2 model(s)\n`)),
  0,
  ['结果：正常', '没有 "entry did not activate"'],
);

// ── ② 激活审计（2026-11-24 场景）────────────────────────────────────────────
expect(
  'did not activate → 红、exit 1',
  run(
    fixture(
      `${BANNER}dsh: warning: 2 required entries did not activate\n` +
        '@deepseek-ai/dsh-client-ui-context-menu (required): pending (waiting for service: slots)\n',
    ),
  ),
  1,
  ['did not activate', 'BREAK-GLASS.md', '§8.21'],
);

// ── ③ pending 条目名要点出来 ───────────────────────────────────────────────
expect(
  'pending 条目 → 红，并点名',
  run(
    fixture(
      `${BANNER}` +
        '@deepseek-ai/dsh-client-ui-sidebar (required): pending (waiting for services: uiWorkspace, fileDrag)\n' +
        '@deepseek-ai/dsh-client-ui-chat (required): pending (waiting for services: uiConversation, sidebarRight)\n',
    ),
  ),
  1,
  ['2 个插件仍 pending', 'dsh-client-ui-sidebar'],
);

// ── ④ 子路径没起来（会话打不开）────────────────────────────────────────────
expect(
  'never started → 红、指向 §8.22',
  run(
    fixture(
      `${BANNER}api-session/error: resume failed … RemoteError: tool-subagent-list-agents\n` +
        ' (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started\n',
    ),
  ),
  1,
  ['never started', '§8.22'],
);

// ── ⑤ 已知噪音不许误报 ─────────────────────────────────────────────────────
expect(
  '账号接口噪音 → 仍然绿',
  run(
    fixture(
      `${BANNER}` +
        '[deepseek-account] request failed {\n  path: \'/api/v0/users/get_user_summary\',\n  errorCode: \'no-response\'\n}\n' +
        '(node:123) ExperimentalWarning: stripTypeScriptTypes is experimental\n',
    ),
  ),
  0,
  ['结果：正常'],
);

// ── ⑥ 只看最后一段：早先崩过、现在好了 ──────────────────────────────────────
expect(
  '早期故障段不算数（只看最后一段）',
  run(
    fixture(
      'dsh web: http://127.0.0.1:3080/?token=OLD\ndsh: warning: 2 required entries did not activate\n' +
        `${BANNER}一切正常\n`,
    ),
  ),
  0,
  ['结果：正常'],
);

// ── ⑦ 没有日志：不该红 ─────────────────────────────────────────────────────
expect('没有日志 → exit 0 + 提示', run(fixture(null)), 0, ['没有日志']);

// ── ⑧ --advisory：坏日志也必须 exit 0 ──────────────────────────────────────
expect(
  '--advisory 对坏日志仍然 exit 0',
  run(fixture(`${BANNER}dsh: warning: 1 entry did not activate\n`), ['--advisory']),
  0,
  ['did not activate'],
);

// ── ⑨ --json：机器可读 ─────────────────────────────────────────────────────
{
  const home = fixture(`${BANNER}dsh: warning: 1 entry did not activate\n`);
  const { code, out } = run(home, ['--json']);
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    /* 下面统一判 */
  }
  if (!parsed) no('--json 输出可解析', out);
  else if (parsed.ok === false && parsed.failures >= 1 && Array.isArray(parsed.results)) ok('--json 输出可解析且 ok=false');
  else no('--json 语义', JSON.stringify(parsed).slice(0, 400));
  if (code === 1) ok('--json 仍然用退出码表达失败');
  else no('--json 退出码', `拿到 ${code}`);
}

// ── ⑩ 端口判定（真的探一个确定关闭的端口）────────────────────────────────────
{
  // 先占一个端口再放掉，保证它此刻是关的。
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const closedPort = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));

  const home = fixture(`${BANNER}一切正常\n`);
  const { code, out } = run(home, [], {
    DSH_CHECK_PORTS: String(closedPort),
    DSH_WEB_PORT: String(closedPort),
    DSH_ROUTER_PORT: String(closedPort),
  });
  if (code === 1 && out.includes(`${closedPort} 没在监听`)) ok(`端口 ${closedPort} 没监听 → 红`);
  else no(`端口 ${closedPort} 没监听 → 红`, out);
}

// ── ⑪ 自我一致性：脚本读不存在的 DSH_HOME 也不能崩 ───────────────────────────
expect(
  '不存在的 DSH_HOME → 优雅退出',
  run(join(ROOT, 'does-not-exist')),
  0,
  ['没有日志'],
);

// ── ⑫ 登记检查：脚本自身被 install.mjs 的必需清单覆盖 ───────────────────────
{
  const installSrc = readFileSync(join(PACK, 'install.mjs'), 'utf8');
  if (installSrc.includes("'tools/check-boot.mjs'")) ok('install.mjs 的 REQUIRED 已登记 check-boot.mjs');
  else no('install.mjs 的 REQUIRED 未登记 check-boot.mjs');
  if (installSrc.includes("'tools/tests/check-boot.mjs'")) ok('install.mjs 的 REQUIRED 已登记本测试');
  else no('install.mjs 的 REQUIRED 未登记本测试');
}

// ── ⑬ 文档反向索引存在（§8.21 / §8.22 真写了）──────────────────────────────
{
  const bg = join(PACK, 'ops/tunnel/BREAK-GLASS.md');
  if (!existsSync(bg)) no('BREAK-GLASS.md 存在');
  else {
    const text = readFileSync(bg, 'utf8');
    if (/### 8\.21/.test(text)) ok('BREAK-GLASS 有 §8.21');
    else no('BREAK-GLASS 缺 §8.21（checker 会指向一个不存在的章节）');
    if (/### 8\.22/.test(text)) ok('BREAK-GLASS 有 §8.22');
    else no('BREAK-GLASS 缺 §8.22');
  }
}

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
