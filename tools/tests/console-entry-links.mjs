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

const byId = new Map();
byId.set('miniserve-link', mini);
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
  addEventListener() {},
  body: makeEl(),
};

const ctx = {
  document,
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
console.log(bad === 0 ? '\nPASS 入口链接已按当前 host 生成' : `\nFAIL ${bad} 条未赋值`);
process.exit(bad === 0 ? 0 : 1);
