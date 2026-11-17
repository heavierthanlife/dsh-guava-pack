#!/usr/bin/env node
/**
 * tools/tests/console-entry-links.mjs — 控制台入口链接的**行为**回归门禁。
 *
 * 为什么需要（2026-11-12 真实事故）：
 *   上一版把 `applyEntryHrefs()` 误插进了 `doAction()` 的 `.finally()` 里 ——
 *   语法正确、静态 grep 也能搜到函数名，但**启动时从未调用**，于是入口卡没有 href，
 *   用户点「监控面板 / 推送」毫无反应（只有 miniserve 因为走另一条赋值路径还能用）。
 *   纯静态断言抓不到这种"位置错"的 bug。
 *
 * 做法：用最小 DOM 桩在 node:vm 里真跑一遍页面主脚本，断言四张入口卡的 href
 * 按「当前访问 host」生成。
 *
 * 用法：node tools/tests/console-entry-links.mjs
 *
 * @module tools/tests/console-entry-links
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const PAGE = join(PACK, 'ops', 'console', 'index.html');
const html = readFileSync(PAGE, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const main = scripts[scripts.length - 1];

function makeEl() {
  const attrs = new Map();
  return {
    attributes: attrs,
    className: '',
    textContent: '',
    hidden: false,
    style: {},
    children: [],
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    contains() { return false; },
    closest() { return null; },
  };
}

const PORTED = [22022, 22023, 3001, 8080];
const entries = PORTED.map((p) => {
  const a = makeEl();
  a.setAttribute('data-port', String(p));
  if (p === 22022 || p === 22023) a.setAttribute('data-path', '/go');
  return a;
});
const mini = makeEl();
mini.setAttribute('id', 'miniserve-link');
// 令牌路径类入口卡（2026-11-17 加的休闲角）：href 由 /api/status 里各服务的
// url 动态给，且要把 100.x 换成"当前访问 host"——和文件中转卡同一个坑。
const arcade = makeEl();
arcade.setAttribute('id', 'arcade-link');

const byId = new Map();
byId.set('miniserve-link', mini);
byId.set('arcade-link', arcade);
byId.set('theme', Object.assign(makeEl(), { value: 'graphite' }));

// $ 是页面里的便捷函数：sel 以 # 开头时走 getElementById，否则 querySelector。
const document = {
  documentElement: makeEl(),
  hidden: false,
  querySelector: (sel) => {
    if (sel === 'meta[name="theme-color"]') return makeEl();
    if (sel === 'style[data-cyberpunk-theme]') return null;
    return makeEl();
  },
  getElementById: (id) => byId.get(id) || makeEl(),
  querySelectorAll: (sel) => (sel === '[data-port]' ? entries : []),
  createElement: () => makeEl(),
  createDocumentFragment: () => makeEl(),
  // 页面里有 `valueNode instanceof Node` 与 createTextNode：
  // 不给这两个，renderRestic 会抛 "Node is not defined"，
  // 而它被 refreshStatus 的 .catch 吞掉 —— 表现为 href 永远 null。
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  addEventListener() {},
  body: makeEl(),
};

const ctx = {
  document,
  Node: class Node {},
  location: { protocol: 'http:', hostname: 'localhost' },
  localStorage: { getItem: () => null, setItem() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  AbortController,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  console,
};
ctx.window = ctx;
ctx.globalThis = ctx;

vm.createContext(ctx);
// 页面用了 window.confirm / alert 之类，补上
ctx.confirm = () => false;
ctx.alert = () => {};
vm.runInContext(main, ctx, { timeout: 5000 });

let bad = 0;
const expect = { 22022: 'http://localhost:22022/go', 22023: 'http://localhost:22023/go', 3001: 'http://localhost:3001/', 8080: 'http://localhost:8080/' };
for (const a of entries) {
  const port = a.getAttribute('data-port');
  const got = a.getAttribute('href');
  const ok = got === expect[port];
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} :${port} -> ${got}`);
}
// ── 令牌路径入口卡（文件中转 :8081 / 休闲角 :8091）─────────────────────────
// 这两张卡的 href 不来自 HTML，而是 /api/status 返回的绝对 URL（服务端只知道
// tailnet 地址）。所以它们有两个独立的失败方式，都必须覆盖：
//   1. 忘了把 100.x 换成当前 host → 经 localhost 打开控制台时点了打不开；
//   2. 端口替换错了（8091 的链接被套上 8081）→ 跳到另一个服务上。
// 页面脚本启动时会真的去 fetch('/api/status')，但那份响应是空的（桩），
// 所以这里直接调用页面暴露不了的内部函数行不通 —— 改为给 fetch 桩喂真实
// 形状的 /api/status 响应，让整条链路跑一遍。
async function checkTokenEntries() {
  const entriesCtx = {
    ...ctx,
    fetch: async (url) => {
      if (String(url).includes('/api/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            version: '1.0.0',
            host: 'vps',
            ts: new Date().toISOString(),
            // 必须给真实形状：renderTunnels 读 data.items，传 {} 会抛，
            // 而那个异常被 refreshStatus 的 .catch 吞掉 —— 表现为"卡片 href 一直是 null"，
            // 看起来像我们的链接逻辑坏了，实际是桩数据不合法。
            services: { items: [] },
            tunnels: { items: [] },
            restic: { snapshots: 0 },
            gitmirror: {},
            security: {},
            disk: {}, memory: {}, load: { one: 0, five: 0, fifteen: 0 },
            // 服务端只知道 tailnet 地址，这正是被替换的输入
            miniserve: { ok: true, url: 'http://100.109.125.37:8081/x970d26da939494d24507/' },
            arcade: { ok: true, url: 'http://100.109.125.37:8091/abcdef0123456789abcdef0123456789/' },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  entriesCtx.window = entriesCtx;
  entriesCtx.globalThis = entriesCtx;
  entriesCtx.confirm = () => false;
  entriesCtx.alert = () => {};
  vm.createContext(entriesCtx);

  const miniEl = Object.assign(makeEl(), {});
  miniEl.setAttribute('id', 'miniserve-link');
  const arcadeEl = Object.assign(makeEl(), {});
  arcadeEl.setAttribute('id', 'arcade-link');
  const ids = new Map([['miniserve-link', miniEl], ['arcade-link', arcadeEl],
    ['theme', Object.assign(makeEl(), { value: 'graphite' })]]);
  const doc = {
    ...document,
    getElementById: (id) => ids.get(id) || makeEl(),
  };
  entriesCtx.document = doc;

  vm.createContext(entriesCtx);
  vm.runInContext(main, entriesCtx, { timeout: 5000 });
  // 等首轮 refreshStatus 落地
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

  let bad = 0;
  const cases = [
    [miniEl, 'http://localhost:8081/x970d26da939494d24507/', '文件中转 :8081'],
    [arcadeEl, 'http://localhost:8091/abcdef0123456789abcdef0123456789/', '休闲角 :8091'],
  ];
  for (const [el, want, label] of cases) {
    const got = el.getAttribute('href');
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${got}`);
  }
  return bad;
}

bad += await checkTokenEntries();

console.log(bad === 0 ? '\nPASS 入口链接已按当前 host 生成' : `\nFAIL ${bad} 条未赋值`);
process.exit(bad === 0 ? 0 : 1);
