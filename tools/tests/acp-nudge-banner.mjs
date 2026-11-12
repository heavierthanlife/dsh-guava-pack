#!/usr/bin/env node
/**
 * tools/tests/acp-nudge-banner.mjs — nudge 横幅「有回应就自动收」的行为门禁。
 *
 * ## 它防的是什么（2026-11-12 用户实测）
 *
 * 用户按 nudge 的提示输入了压缩指令、压缩也成功了，但横幅**不消失**：
 * 它只判断 `Date.now() - at < 15min`，完全不知道模型已经照办，于是一条
 * "建议压缩"的警报在压完之后还要杵满 15 分钟，只能手动点 ×。
 *
 * 修法是把横幅接上 `contextAcp` 投影的 `lastAt`（最近一次 `compaction/summary`
 * 的 event.time）：`lastAt >= at` 就说明这次 nudge 已经有回应，横幅从警报切成
 * 回执，4 秒后自动收起。
 *
 * ## 为什么必须是行为测试
 *
 * 这个仓库已经吃过一次亏：`applyEntryHrefs()` 被误插进 `.finally()`，语法正确、
 * 静态 grep 也搜得到，但**启动时从未调用**（见 console-entry-links.mjs 的注释）。
 * 自动收起同理 —— 定时器没被 arm、`resolved` 恒 false 都能让静态检查全绿，
 * 只有真跑一遍组件才暴露。
 *
 * 做法：用一套最小 React hook 运行时（useState/useEffect/useRef）+ 假定时器
 * 在 `node:vm` 里加载真正的 client.js，从 `slots.register` 里拿到 AcpNudge
 * 组件本体并渲染，断言可见文案与自动收起时机。
 *
 * 用法：node tools/tests/acp-nudge-banner.mjs
 *
 * @module tools/tests/acp-nudge-banner
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const CLIENT = readFileSync(join(PACK, 'plugins', 'dsh-context-acp', 'client.js'), 'utf8');

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

// ── 最小 React hook 运行时 ──────────────────────────────────────────────
// 只实现本组件用到的三个 hook，语义按 React 实现：hooks 顺序稳定、deps 浅比较、
// effect 在提交后跑且下次依赖变化前先跑 cleanup。

function createReactRuntime() {
  const hookSlots = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let dirty = false;
  let rendering = false;

  const depsEqual = (a, b) => {
    if (a === undefined || b === undefined) return false; // 无 deps = 每次都跑
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => Object.is(value, b[i]));
  };

  function useState(initial) {
    const slot = hookSlots[hookIndex] ?? (hookSlots[hookIndex] = { value: initial });
    hookIndex++;
    if (slot.setter === undefined) {
      slot.setter = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        dirty = true;
      };
    }
    return [slot.value, slot.setter];
  }

  function useRef(initial) {
    const slot = hookSlots[hookIndex] ?? (hookSlots[hookIndex] = { ref: { current: initial } });
    hookIndex++;
    return slot.ref;
  }

  function useEffect(fn, deps) {
    const index = hookIndex;
    const slot = hookSlots[hookIndex] ?? (hookSlots[hookIndex] = {});
    hookIndex++;
    if (!depsEqual(slot.deps, deps)) {
      slot.deps = deps;
      pendingEffects.push({ index, fn, slot });
    }
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } };
    },
    useState,
    useEffect,
    useRef,
  };

  /**
   * 渲染组件并提交 effects；effect 里的 setState 会触发下一轮。
   *
   * **必须 async**：横幅的状态来自 `fetch(/context-acp/getSettings)`，setState 发生在
   * 微任务里。同步循环会在 promise 兑现前就判定"没有 nudge"而全部失败 ——
   * 那正是第一版 harness 踩的坑。每轮之间 flush 微任务队列再决定要不要重渲染。
   */
  async function render(Component, props, options = {}) {
    const maxRounds = options.maxRounds ?? 10;
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    let element;
    for (let round = 0; round < maxRounds; round++) {
      dirty = false;
      hookIndex = 0;
      pendingEffects = [];
      let rendered;
      rendering = true;
      try {
        rendered = Component(props);
      } finally {
        rendering = false;
      }
      element = rendered;
      // 先跑上一轮的 cleanup，再跑本轮的 effect。
      for (const effect of pendingEffects) {
        if (typeof effect.slot.cleanup === 'function') {
          try { effect.slot.cleanup(); } catch { /* 测试里不因 cleanup 崩溃 */ }
          effect.slot.cleanup = undefined;
        }
        const result = effect.fn();
        effect.slot.cleanup = typeof result === 'function' ? result : undefined;
      }
      // 让 async effect（fetch → setState）有机会落地，再决定是否重渲染。
      for (let tick = 0; tick < 5 && !dirty; tick++) await flush();
      if (!dirty) break;
    }
    return element;
  }

  return { React, render, isRendering: () => rendering };
}

// ── 假定时器（自动收起必须能被「推进时间」验证，不能真等 4 秒）─────────
function createClock(now = Date.parse('2026-11-12T14:00:00Z')) {
  let current = now;
  let seq = 0;
  const timers = new Map();

  const setTimeoutFake = (fn, delay) => {
    const id = ++seq;
    timers.set(id, { at: current + Math.max(0, Number(delay) || 0), fn, repeat: null });
    return id;
  };
  const setIntervalFake = (fn, delay) => {
    const id = ++seq;
    const step = Math.max(1, Number(delay) || 1);
    timers.set(id, { at: current + step, fn, repeat: step });
    return id;
  };
  const clearFake = (id) => {
    timers.delete(id);
  };

  /** 推进 ms：按到期顺序触发，允许回调里再排定时器。 */
  const advance = (ms) => {
    const target = current + ms;
    let guard = 0;
    for (;;) {
      if (guard++ > 1000) throw new Error('假定时器触发次数异常（可能死循环）');
      let next = null;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (next === null || timer.at < next.timer.at)) next = { id, timer };
      }
      if (next === null) break;
      current = next.timer.at;
      if (next.timer.repeat === null) timers.delete(next.id);
      else next.timer.at = current + next.timer.repeat;
      next.timer.fn();
    }
    current = target;
  };

  return {
    setTimeout: setTimeoutFake,
    setInterval: setIntervalFake,
    clearTimeout: clearFake,
    clearInterval: clearFake,
    now: () => current,
    advance,
    pending: () => timers.size,
  };
}

// ── 加载 client.js，取出 AcpNudge ────────────────────────────────────────
/**
 * @param {object} options
 * @param {object} options.nudge  getSettings 返回的 lastNudge（null 表示没 nudge）
 * @param {object} [options.projection]  contextAcp 投影（undefined = 投影未就绪）
 * @param {boolean} [options.withUseProjection] 是否给组件注入 useProjection
 * @param {string} [options.storage] 预置的 sessionStorage 内容
 */
function loadBanner({ nudge, projection, withUseProjection = true, storage = {} }, clock) {
  const runtime = createReactRuntime();
  let factory;
  const windowStub = {
    __ModuleLoader__: {
      load(descriptor) {
        factory = descriptor.factory;
      },
    },
  };

  const store = new Map(Object.entries(storage));
  const sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };

  const documentStub = {
    querySelector: () => null, // 不是赛博主题
  };

  const fetchStub = async () => ({
    json: async () => ({
      result: { ok: true, value: { version: 2, armed: true, lastNudge: nudge ?? null, tunables: {} } },
    }),
  });

  // 组件用 `Date.now()` 判断「这次 nudge 多久了」。既不冻结 Date 也不推进假时钟的话，
  // 测试里固定的 nudge 时间会离真实 now 越来越远，15 分钟过期与 4 秒倒计时全都对不上
  // —— 第一版 harness 就是在这里全军覆没（横幅永远判成过期，渲染出 null）。
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now());
      else super(...args);
    }
    static now() {
      return clock.now();
    }
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    sessionStorage,
    fetch: fetchStub,
    Date: FakeDate,
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimeout,
    clearInterval: clock.clearInterval,
    console,
  };
  const context = vm.createContext(sandbox);

  // client.js 顶层的 load() 调用需要 window；factory 需要 require('react')。
  vm.runInContext(CLIENT, context, { filename: 'dsh-context-acp/client.js' });
  if (typeof factory !== 'function') throw new Error('client.js 没有调用 __ModuleLoader__.load');
  const mod = factory((name) => {
    if (name === 'react') return runtime.React;
    throw new Error(`require(${JSON.stringify(name)}) 未预期`);
  });

  // 走真实 apply()，从 slot 注册里取组件 —— 顺便验证注册 id 没被改掉。
  const registrations = [];
  const ctx = {
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    locale: { register: () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);

  const nudgeReg = registrations.find((entry) => entry.options?.id === 'dsh-acp-nudge');
  if (nudgeReg === undefined) throw new Error('没有注册 id=dsh-acp-nudge 的槽位条目');

  const baseProps = { sessionId: 'sess-1', t: (key) => key };
  if (withUseProjection) baseProps.useProjection = (key) => (key === 'contextAcp' ? projection : undefined);

  return {
    render: (override) => runtime.render(nudgeReg.component, { ...baseProps, ...(override ?? {}) }),
    store,
  };
}

/** 从渲染结果里取可见文案（组件返回的是 span 树）。 */
function textOf(element) {
  if (element === null || element === undefined) return '';
  if (typeof element === 'string') return element;
  const parts = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') { parts.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type === 'string' && node.type === 'style') return; // CSS 不算文案
    walk(node.props?.children);
  };
  walk(element);
  return parts.join(' ');
}

function findByClass(element, className) {
  if (element === null || element === undefined || typeof element === 'string') return null;
  if (Array.isArray(element)) {
    for (const child of element) {
      const found = findByClass(child, className);
      if (found !== null) return found;
    }
    return null;
  }
  const own = String(element.props?.className ?? '').split(/\s+/);
  if (own.includes(className)) return element;
  return findByClass(element.props?.children, className);
}

// ── 用例 ────────────────────────────────────────────────────────────────
const T = Date.parse('2026-11-12T14:00:00Z');

console.log('用例 1：还没压缩过 —— 保持「建议压缩」，且不自动消失');
{
  const clock = createClock(T);
  const banner = loadBanner({ nudge: { at: T, usedTokens: 70_000, contextWindow: 100_000, reason: 'pressure' } }, clock);
  const view = await banner.render();
  const text = textOf(view);
  check('横幅出现', view !== null);
  check('文案是「上下文 70%」', text.includes('上下文 70%'), text);
  check('提示是「建议压缩」', text.includes('建议压缩'), text);
  check('没有倒计时条', findByClass(view, 'acp_nudge_progress') === null);
  clock.advance(60_000);
  const later = await banner.render();
  check('60 秒后仍然在（未响应不该自己走）', later !== null);
  check('没有写 dismiss 键', banner.store.size === 0, [...banner.store.keys()]);
}

console.log('\n用例 2：压缩发生在 nudge 之后 —— 切成回执并在 4 秒后自动收起');
{
  const clock = createClock(T);
  const banner = loadBanner({
    nudge: { at: T, usedTokens: 70_000, contextWindow: 100_000, reason: 'pressure' },
    projection: { blocks: 1, lastAt: T + 5_000 }, // 5 秒后压了一次
  }, clock);
  const view = await banner.render();
  const text = textOf(view);
  check('横幅出现', view !== null);
  check('文案切成「已压缩」', text.includes('已压缩'), text);
  check('提示改成「4 秒后自动收起」', text.includes('4 秒后自动收起'), text);
  check('badge 变成 ✓', textOf(findByClass(view, 'acp_nudge_badge')).includes('✓'));
  check('有倒计时条', findByClass(view, 'acp_nudge_progress') !== null);
  check('data-resolved=true', findByClass(view, 'acp_nudge')?.props?.['data-resolved'] === 'true');
  check('倒计时时长通过 CSS 变量下发', String(findByClass(view, 'acp_nudge')?.props?.style?.['--acp-nudge-auto-close-ms']) === '4000ms');

  clock.advance(3_900);
  check('3.9 秒时还在（不能提前消失）', (await banner.render()) !== null);
  check('3.9 秒时还没写 dismiss 键', banner.store.size === 0, [...banner.store.keys()]);

  clock.advance(200); // 4.1 秒
  const gone = await banner.render();
  check('4 秒后自动收起（不需要手动点 ×）', gone === null, textOf(gone));
  check('收起状态写进 sessionStorage', banner.store.get('dsh-acp-nudge-dismissed:sess-1') === String(T),
    banner.store.get('dsh-acp-nudge-dismissed:sess-1'));
}

console.log('\n用例 3：压缩发生在 nudge 之前 —— 不能拿旧压缩冒充「已回应」');
{
  const clock = createClock(T);
  const banner = loadBanner({
    nudge: { at: T, usedTokens: 82_000, contextWindow: 100_000, reason: 'pressure' },
    projection: { blocks: 2, lastAt: T - 600_000 }, // 10 分钟前压过一次
  }, clock);
  const view = await banner.render();
  const text = textOf(view);
  check('仍然提示「建议压缩」', text.includes('建议压缩') && !text.includes('已压缩'), text);
  check('没有倒计时条', findByClass(view, 'acp_nudge_progress') === null);
  clock.advance(60_000);
  check('不会自动消失', (await banner.render()) !== null);
}

console.log('\n用例 4：刷新后已经自动收过的 nudge 不再冒出来');
{
  const clock = createClock(T);
  const banner = loadBanner({
    nudge: { at: T, usedTokens: 70_000, contextWindow: 100_000, reason: 'pressure' },
    projection: { blocks: 1, lastAt: T + 1_000 },
    storage: { 'dsh-acp-nudge-dismissed:sess-1': String(T) },
  }, clock);
  check('直接不渲染', (await banner.render()) === null);
}

console.log('\n用例 5：下一次 nudge 会重新出现（收起只针对那一次）');
{
  const clock = createClock(T);
  const banner = loadBanner({
    nudge: { at: T + 600_000, usedTokens: 88_000, contextWindow: 100_000, reason: 'pressure' },
    projection: { blocks: 1, lastAt: T + 1_000 }, // 上一次压缩早于这次 nudge
    storage: { 'dsh-acp-nudge-dismissed:sess-1': String(T) }, // 上一次 nudge 已收起
  }, clock);
  const view = await banner.render();
  check('新 nudge 重新可见', view !== null);
  check('文案是新的占用率', textOf(view).includes('上下文 88%'), textOf(view));
}

console.log('\n用例 6：投影未就绪 / 宿主没给 useProjection —— 降级但不能崩');
{
  const clock = createClock(T);
  const noProjection = loadBanner({
    nudge: { at: T, usedTokens: 70_000, contextWindow: 100_000, reason: 'pressure' },
    projection: undefined, // host 投影还没到
  }, clock);
  const view = await noProjection.render();
  check('投影未就绪时按「未响应」显示', view !== null && textOf(view).includes('建议压缩'), textOf(view));

  const noHookClock = createClock(T);
  const noHook = loadBanner({
    nudge: { at: T, usedTokens: 70_000, contextWindow: 100_000, reason: 'pressure' },
    withUseProjection: false, // 旧宿主槽位没有这个 prop
  }, noHookClock);
  const legacy = await noHook.render();
  check('没有 useProjection 也不抛错', legacy !== null);
  check('仍然显示「建议压缩」', textOf(legacy).includes('建议压缩'), textOf(legacy));
}

console.log('\n用例 7：nudge 超过 15 分钟 —— 仍然会自己过期');
{
  const clock = createClock(T);
  const banner = loadBanner({
    nudge: { at: T, usedTokens: 70_000, contextWindow: 100_000, reason: 'pressure' },
  }, clock);
  check('刚 nudge 时可见', (await banner.render()) !== null);
  clock.advance(15 * 60 * 1000 + 1_000);
  check('15 分钟后自然过期', (await banner.render()) === null);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} acp-nudge-banner: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
