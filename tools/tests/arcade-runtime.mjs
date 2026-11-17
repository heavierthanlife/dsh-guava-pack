#!/usr/bin/env node
/**
 * tools/tests/arcade-runtime.mjs — `arcade.js` 共用运行时的**行为**门禁。
 *
 * ## 为什么必须测这个文件
 *
 * 主题切换、分数删除、存档槽、二次确认原本要抄进 8 个页面。抽出来之后，
 * 它是全部 8 个页面的公共依赖 —— 它错一处，八个页面一起错，而每个页面
 * 自己的门禁（arcade-pages.mjs）只看得到"有没有调用"，看不到"调了之后对不对"。
 *
 * 尤其是**存档淘汰规则**：用户要求"最多 5 个，超出删除分数最低的"。
 * 这类逻辑写反了（淘汰最高分、或者淘汰最旧的）静态检查完全看不出来，
 * 但会直接毁掉用户想留的存档。
 *
 * ## 怎么测
 *
 * 用最小 DOM 桩在 `node:vm` 里真加载 arcade.js 并调用它的 API。
 * 这个文件是 IIFE + `window.Arcade = {...}`，所以沙箱里 `window` 必须
 * **就是**全局对象（浏览器的语义），否则拿不到 Arcade。
 *
 * 用法：node tools/tests/arcade-runtime.mjs
 *
 * @module tools/tests/arcade-runtime
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(dirname(dirname(HERE)), 'ops', 'arcade', 'public');
const SOURCE = readFileSync(join(PUBLIC, 'arcade.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/** 最小元素桩。classList 必须是真的集合（armed 状态靠它）。 */
function makeEl(tag = 'div') {
  const attrs = new Map();
  const listeners = new Map();
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(), nodeType: 1, className: '', textContent: '',
    id: '', type: '', value: '', hidden: false, disabled: false, children: [], parentNode: null,
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    insertBefore(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener() {},
    dispatch(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event ?? { preventDefault() {}, stopPropagation() {} });
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

/**
 * 起一个沙箱并加载 arcade.js。
 * @param {object} [seed] 预置的 localStorage 内容
 * @param {boolean} [brokenStorage] true = localStorage 全部抛错（模拟隐私模式）
 */
function boot(seed = {}, brokenStorage = false) {
  const store = new Map(Object.entries(seed));
  const html = makeEl('html');
  const body = makeEl('body');
  const docListeners = new Map();

  const document = {
    documentElement: html,
    body,
    hidden: false,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, event) {
      for (const fn of docListeners.get(type) ?? []) fn(event ?? {});
    },
  };

  const localStorage = brokenStorage
    ? {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
      removeItem() { throw new Error('SecurityError'); },
    }
    : {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };

  const ctx = {
    console, document, localStorage,
    setTimeout, clearTimeout,
  };
  // 浏览器里 window === 全局对象；arcade.js 写的是 window.Arcade = {...}
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};

  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { timeout: 5000 });
  return { Arcade: ctx.Arcade, store, html, document };
}

// ── 存档槽：上限与淘汰 ────────────────────────────────────────────────────
console.log('\n存档槽：最多 5 个，超出淘汰分数最低的');
{
  const { Arcade } = boot();
  for (const score of [10, 20, 30, 40, 50]) Arcade.saveSlot('g', { score, state: { score } });
  check('存 5 个后正好 5 个', Arcade.listSlots('g').length === 5, String(Arcade.listSlots('g').length));

  const sixth = Arcade.saveSlot('g', { score: 60, state: { score: 60 } });
  const after = Arcade.listSlots('g');
  check('第 6 个仍然只有 5 个', after.length === 5, String(after.length));
  check('淘汰的是分数最低的 10（不是最旧的）', sixth.evicted !== null && sixth.evicted.score === 10,
    JSON.stringify(sixth.evicted?.score));
  check('留下 20/30/40/50/60',
    JSON.stringify(after.map((e) => e.score).sort((a, b) => a - b)) === JSON.stringify([20, 30, 40, 50, 60]),
    JSON.stringify(after.map((e) => e.score)));

  // 存一个比现有全部更低的：它自己就是最低分，应当被淘汰
  const lowest = Arcade.saveSlot('g', { score: 5, state: {} });
  check('存更低分时淘汰它自己', lowest.evicted !== null && lowest.evicted.score === 5,
    JSON.stringify(lowest.evicted?.score));
  check('集合保持不变',
    JSON.stringify(Arcade.listSlots('g').map((e) => e.score).sort((a, b) => a - b)) === JSON.stringify([20, 30, 40, 50, 60]));
}

console.log('\n存档槽：同 id 覆盖而不新增（自动存档反复触发不该堆垃圾）');
{
  const { Arcade } = boot();
  Arcade.saveSlot('g', { id: 'auto', score: 10, state: { n: 1 } });
  Arcade.saveSlot('g', { id: 'auto', score: 99, state: { n: 2 } });
  const list = Arcade.listSlots('g');
  check('只有一条', list.length === 1, String(list.length));
  check('状态被更新', list[0].state.n === 2, JSON.stringify(list[0].state));
  check('分数被更新', list[0].score === 99, String(list[0].score));
}

console.log('\n存档槽：载入 / 删除 / 隔离');
{
  const { Arcade } = boot();
  Arcade.saveSlot('g', { id: 'x', score: 7, state: { hp: 3 } });
  const got = Arcade.loadSlot('g', 'x');
  check('loadSlot 拿回状态', got !== null && got.state.hp === 3, JSON.stringify(got?.state));
  check('不存在的 id 返回 null', Arcade.loadSlot('g', 'nope') === null);

  Arcade.saveSlot('other', { score: 1, state: {} });
  check('不同游戏的存档互不干扰',
    Arcade.listSlots('g').length === 1 && Arcade.listSlots('other').length === 1);

  Arcade.removeSlot('g', 'x');
  check('删除后为空', Arcade.listSlots('g').length === 0);
  check('删除不存在的 id 不抛错',
    (() => { try { Arcade.removeSlot('g', 'zzz'); return true; } catch { return false; } })());
}

// ── 分数记录 ──────────────────────────────────────────────────────────────
console.log('\n分数记录：单删 / 一键清空');
{
  const { Arcade, store } = boot({
    'arcade.g2048.best': '128',
    'arcade.snake.best': '42',
    'arcade.mines.best': JSON.stringify({ easy: 30, medium: 70, hard: 120 }),
    'arcade.tetris.best': '900',
    'arcade.pixel.canvas': 'KEEP-ME',
    'arcade.g2048.slots': '[]',
  });
  check('读数值型记录', Arcade.getScore('g2048') === 128, String(Arcade.getScore('g2048')));
  check('读对象型记录（扫雷三档）', Arcade.getScore('mines').easy === 30);
  check('快照列出 4 个游戏', Arcade.scoreSnapshot().length === 4, String(Arcade.scoreSnapshot().length));
  check('快照标出有记录', Arcade.scoreSnapshot().every((s) => s.has === true));

  Arcade.delScore('g2048');
  check('删一条后读为 null', Arcade.getScore('g2048') === null);
  check('删一条不影响其他', Arcade.getScore('snake') === 42);

  Arcade.clearScores();
  check('清空后 4 条都没了',
    ['g2048', 'snake', 'mines', 'tetris'].every((id) => Arcade.getScore(id) === null));
  check('清空不碰画板存档', store.get('arcade.pixel.canvas') === 'KEEP-ME');
  check('清空不碰存档槽', store.get('arcade.g2048.slots') === '[]');
}

// ── 二次确认 ──────────────────────────────────────────────────────────────
console.log('\n二次确认：第一下武装，第二下执行');
{
  const { Arcade } = boot();
  const btn = makeEl('button');
  btn.textContent = '删除';
  let fired = 0;
  Arcade.confirmAction(btn, { text: '删除', confirmText: '确认？', onConfirm: () => { fired++; } });

  btn.dispatch('click');
  check('第一次点不执行', fired === 0, String(fired));
  check('按钮进入确认态', btn.textContent === '确认？', btn.textContent);
  check('加上 armed 类（CSS 会染红）', btn.classList.contains('armed'));

  btn.dispatch('click');
  check('第二次点才执行', fired === 1, String(fired));
  check('执行后文案复原', btn.textContent === '删除', btn.textContent);
  check('执行后去掉 armed', !btn.classList.contains('armed'));
}

console.log('\n二次确认：超时自动复原（避免半武装状态挂着）');
{
  const { Arcade } = boot();
  const btn = makeEl('button');
  btn.textContent = '清空';
  let fired = 0;
  Arcade.confirmAction(btn, { text: '清空', confirmText: '确认清空？', timeout: 30, onConfirm: () => { fired++; } });
  btn.dispatch('click');
  check('先进入确认态', btn.textContent === '确认清空？', btn.textContent);
  await new Promise((resolve) => setTimeout(resolve, 90));
  check('超时后复原', btn.textContent === '清空', btn.textContent);
  check('超时后不再 armed', !btn.classList.contains('armed'));
  btn.dispatch('click');
  check('超时后再点是重新武装而不是执行', fired === 0, String(fired));
}

console.log('\n禁用项');
{
  const { Arcade } = boot();
  const btn = makeEl('button');
  let fired = 0;
  Arcade.confirmAction(btn, { text: '删', onConfirm: () => { fired++; } });
  btn.dispatch('click');
  check('确认态下 textContent 不含"是/确定"这类危险默认词',
    !/^是$|^确定$/.test(btn.textContent), btn.textContent);
  check('未二次点击时 onConfirm 从未执行', fired === 0);
}

// ── 主题与明暗 ────────────────────────────────────────────────────────────
console.log('\n主题与明暗：按页面分键，互不影响');
{
  const { Arcade, store, html } = boot();
  Arcade.setTheme('navy');
  check('主题写到 <html>', html.getAttribute('data-theme') === 'navy', html.getAttribute('data-theme'));
  check('主题落盘', store.get('arcade.theme') === 'navy', store.get('arcade.theme'));
  check('非法主题被忽略', Arcade.setTheme('bogus') === 'navy', Arcade.getTheme());

  Arcade.setMode('g2048', 'light');
  check('明暗写到 <html>', html.getAttribute('data-mode') === 'light', html.getAttribute('data-mode'));
  check('明暗按页面分键', store.get('arcade.g2048.mode') === 'light', store.get('arcade.g2048.mode'));
  check('另一个页面仍是默认暗色', Arcade.getMode('snake') === 'dark', Arcade.getMode('snake'));
  check('toggleMode 会翻面', Arcade.toggleMode('g2048') === 'dark' && Arcade.getMode('g2048') === 'dark');
  check('明暗切换不影响主题', Arcade.getTheme() === 'navy', Arcade.getTheme());
}

console.log('\ninitTheme 的三层属性都落到 <html> 上');
{
  const { Arcade, html } = boot({ 'arcade.g2048.mode': 'light', 'arcade.theme': 'ember' });
  Arcade.initTheme({ page: 'g2048', accent: 'gold' });
  check('data-page', html.getAttribute('data-page') === 'g2048', html.getAttribute('data-page'));
  check('data-accent', html.getAttribute('data-accent') === 'gold', html.getAttribute('data-accent'));
  check('data-mode 读的是该页自己的键', html.getAttribute('data-mode') === 'light', html.getAttribute('data-mode'));

  const home = boot({ 'arcade.theme': 'cyber' });
  home.Arcade.initTheme({ themes: true });
  check('首页用 themes 模式', home.html.getAttribute('data-theme') === 'cyber', home.html.getAttribute('data-theme'));
}

// ── 存储不可用时的降级 ────────────────────────────────────────────────────
console.log('\n隐私模式（localStorage 抛错）必须降级而不是白屏');
{
  const { Arcade, html } = boot({}, true);
  check('脚本仍能加载并暴露 API', typeof Arcade === 'object' && typeof Arcade.saveSlot === 'function');
  check('读分数退化为 null', Arcade.getScore('g2048') === null);
  check('存档不抛错',
    (() => { try { Arcade.saveSlot('g', { score: 1, state: {} }); return true; } catch { return false; } })());
  check('删分数不抛错',
    (() => { try { Arcade.delScore('g2048'); return true; } catch { return false; } })());
  check('列存档退化为空数组', Arcade.listSlots('g').length === 0);
  check('主题仍能应用（内存态）',
    Arcade.setTheme('cyber') === 'cyber' && html.getAttribute('data-theme') === 'cyber');
}

console.log(`\n${failed === 0 ? '✅' : '❌'} arcade-runtime: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
