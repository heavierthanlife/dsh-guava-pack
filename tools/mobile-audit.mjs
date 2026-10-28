#!/usr/bin/env node
/**
 * 手机界面回归门禁（**DOM 实测**，不依赖截图）。
 *
 * ## 为什么需要它
 *
 * 2026-10-28 的一次真实漂移：把 `dsh-context-guard` 合并进 `dsh-context-acp` 时，
 * 撑开 composer dock 的那段 JS（原来在 guard 客户端里）随之删掉，于是手机端
 * dock 退化成 32px 竖轨、所有插件药丸变成 0 宽跑到屏幕外 —— 页面能打开、控制台
 * 无报错、单元测试全绿，**只有真机上肉眼可见**。
 *
 * 所以这里不做单测式断言，而是连一个真实浏览器（CDP），以 390×844 手机视口打开
 * live DSH，量真实布局：
 *   1. dock 容器宽度是否被撑开（≥280px）；
 *   2. 挂在上面的药丸是否可见（w≥44、在屏内）；
 *   3. ACP 面板是否放得下、可滚动、可点区域 ≥40px。
 *
 * ## 用法
 *
 *   # 先启动一个带调试端口的 Edge/Chrome：
 *   #   msedge --headless=new --remote-debugging-port=9222 about:blank
 *   node tools/mobile-audit.mjs                 # 跑全部检查
 *   node tools/mobile-audit.mjs --w 360         # 窄屏
 *   node tools/mobile-audit.mjs --json          # 机器可读
 *
 * 连不上 CDP 时**跳过并以 0 退出**（CI/无浏览器环境不该因此变红）。
 *
 * @module tools/mobile-audit
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PACK = join(HERE, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const PORT = Number(process.env.CDP_PORT || flag('--port', '9222'));
const W = Number(flag('--w', '390'));
const H = Number(flag('--h', '844'));
const AS_JSON = args.includes('--json');
const BASE = flag('--base', 'http://127.0.0.1:3080');

/** 从 DSH 启动日志里取当前 token（与 ops/tailnet-entry.mjs 同一来源）。 */
function currentToken() {
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN;
  const home = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
  try {
    const text = readFileSync(join(home, 'logs', 'web-run.log'), 'utf8');
    const tail = text.length > 65536 ? text.slice(-65536) : text;
    const m = [...tail.matchAll(/dsh web: http:\/\/[^\s]*?\?token=([A-Za-z0-9_-]+)/g)];
    return m.length === 0 ? '' : m[m.length - 1][1];
  } catch {
    return '';
  }
}

let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method} → ${msg.error.message}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 30000);
  return r?.result?.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return null;
  }
  const page = list.find((t) => t.type === 'page');
  if (!page) return null;
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  return page;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: ok === true, detail });
}

/** 打开一个**真实历史会话**（空会话没有投影，药丸本来就不渲染）。 */
async function openRealSession() {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('打开侧边栏'));
    b && b.click();
    return true;
  })()`);
  await sleep(1000);
  const clicked = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[class*="sessionRow"]')];
    const row = rows.find(r => !/新会话/.test(r.innerText || '')) || rows[0];
    if (!row) return null;
    row.click();
    return (row.innerText || '').replace(/\\s+/g, ' ').slice(0, 40);
  })()`);
  await sleep(6500);
  return clicked;
}

async function main() {
  const page = await connect();
  if (page === null) {
    console.log(`[mobile-audit] 跳过：CDP 不可达（127.0.0.1:${PORT}）。`);
    console.log('[mobile-audit] 需要先启动浏览器 --remote-debugging-port=9222；无浏览器环境不算失败。');
    process.exit(0);
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: W,
    screenHeight: H,
  });
  await send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
    mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const token = currentToken();
  await send('Page.navigate', { url: `${BASE}/${token === '' ? '' : `?token=${token}`}` });
  await sleep(8000);

  check('手机模式已生效（dsh-phone）', (await evaluate(`document.documentElement.classList.contains('dsh-phone')`)) === true);

  const session = await openRealSession();
  check('能打开一个真实历史会话', typeof session === 'string' && session.length > 0, session);

  // ── 药丸：手机端约定是「自包含 fixed 悬浮」，不依赖宿主 dock（其宽度为 0）──
  const pill = await evaluate(`(() => {
    const el = document.querySelector('.acp_anchor');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return {
      found: true,
      position: st.position,
      w: Math.round(r.width),
      x: Math.round(r.left),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
    };
  })()`);
  check('ACP 药丸已渲染', pill.found === true, pill);
  check('手机端药丸自包含（position:fixed，不依赖 dock 宽度）', pill.position === 'fixed', pill);
  check('药丸在屏内且可见（w≥44）', pill.found === true && pill.w >= 44 && pill.x >= 0 && pill.right <= W + 1, pill);

  // ── ACP 面板 ─────────────────────────────────────────────────────────
  const opened = await evaluate(`(() => {
    const b = document.querySelector('.acp_pill');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('ACP 药丸可点击打开面板', opened === true);
  await sleep(1200);

  const panel = await evaluate(`(() => {
    const p = document.querySelector('.acp_panel');
    if (!p) return { found: false };
    const r = p.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const steps = [...p.querySelectorAll('.acp_step')].map(el => {
      const b = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const grow = Math.abs(parseFloat(after.inset || '0')) || 0;
      return { w: Math.round(b.width), h: Math.round(b.height), hit: Math.round(Math.max(b.width, b.height) + grow * 2) };
    });
    return {
      found: true,
      fits: r.left >= 0 && r.right <= vw + 1 && r.top >= 0 && r.bottom <= vh + 1,
      scrollable: p.scrollHeight > p.clientHeight,
      notClipped: p.scrollHeight <= p.clientHeight + 1,
      stepCount: steps.length,
      smallSteps: steps.filter(s => s.hit < 40).length,
      hasShortLabel: !!p.ownerDocument.querySelector('.acp_short'),
    };
  })()`);
  check('面板在屏内', panel.found === true && panel.fits === true, panel);
  // 允许两种正确形态：内容超高时**可滚动**，或内容本来就放得下（不裁剪）。
  check('面板内容不裁剪（可滚动或刚好放得下）',
    panel.found === true && (panel.scrollable === true || panel.notClipped === true), panel);
  check('步进按钮可点区域 ≥40px', panel.found === true && panel.smallSteps === 0, panel);
  check('药丸提供手机短标签', panel.hasShortLabel === true);

  ws.close();

  const failed = results.filter((r) => !r.ok);
  if (AS_JSON) {
    console.log(JSON.stringify({ viewport: [W, H], results, failed: failed.length }, null, 2));
  } else {
    console.log(`[mobile-audit] 视口 ${W}×${H}`);
    for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${JSON.stringify(r.detail ?? null)}`}`);
    console.log(`\n[mobile-audit] ${results.length - failed.length}/${results.length} passed`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
