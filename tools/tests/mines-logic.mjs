#!/usr/bin/env node
/**
 * tools/tests/mines-logic.mjs — 扫雷**玩法语义**的断言（不碰 DOM）。
 *
 * 为什么单独一份：`arcade-pages.mjs` 只能证明"页面骨架还在"，证明不了
 * "右键插旗之后再左键不会点爆"这类规则。玩法改动是这次的重点
 * （经典 95 版操作），所以把纯逻辑抽成 mines.html 里的 `PURE:START/END`
 * 标记块，这里直接抽出来在 vm 里跑真实对局。
 *
 * 用法：node tools/tests/mines-logic.mjs
 *
 * @module tools/tests/mines-logic
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const PAGE = join(PACK, 'ops', 'arcade', 'public', 'mines.html');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const raw = readFileSync(PAGE, 'utf8');
const block = /\/\* PURE:START[\s\S]*?\/\* PURE:END \*\//.exec(raw);
if (!block) {
  console.log('❌ 找不到 PURE:START / PURE:END 标记块（纯逻辑被挪走或标记删了）');
  process.exit(1);
}

const sandbox = { Uint8Array, Math, Object, Number, isFinite, console };
vm.createContext(sandbox);
vm.runInContext(
  `${block[0]}
  globalThis.api = { createGame, neighbors, placeMines, computeAdj, floodOpen,
                     reveal, toggleFlag, flagsAround, canChord, chord, isWin };`,
  sandbox,
);
const { api } = sandbox;

/** 造一个雷区已知的棋局（避免随机性干扰断言）。 */
function fixedGame(rows, cols, mineIdx) {
  const g = api.createGame(rows, cols, mineIdx.length);
  for (const i of mineIdx) g.mines[i] = 1;
  api.computeAdj(g);
  g.started = true;
  return g;
}

console.log('\n布雷与首点安全');
{
  const cases = [
    [9, 9, 10],
    [16, 16, 40],
    [16, 30, 99],
  ];
  let ok = true;
  let details = [];
  for (const [rows, cols, n] of cases) {
    for (let trial = 0; trial < 60; trial++) {
      const g = api.createGame(rows, cols, n);
      const safe = Math.floor(Math.random() * g.total);
      api.placeMines(g, safe);
      const count = g.mines.reduce((a, b) => a + b, 0);
      if (count !== n) { ok = false; details.push(`雷数 ${count} != ${n}`); break; }
      if (g.mines[safe]) { ok = false; details.push('首点就是雷'); break; }
      const bad = api.neighbors(g, safe).filter((i) => g.mines[i]);
      if (bad.length && g.total - 9 >= n) {
        ok = false; details.push('首点八邻布雷了'); break;
      }
    }
  }
  check('三档 × 60 次随机布雷：雷数正确、首点与八邻无雷', ok, details.slice(0, 3));
  check('邻雷数与实际雷区一致', (() => {
    const g = fixedGame(3, 3, [0]);   // 0 号是雷；3×3 里它的邻居只有 1 / 3 / 4
    return g.adj[0] === 0 && g.adj[1] === 1 && g.adj[2] === 0
      && g.adj[3] === 1 && g.adj[4] === 1 && g.adj[5] === 0
      && g.adj[6] === 0 && g.adj[7] === 0 && g.adj[8] === 0;
  })());
}

console.log('\n经典操作：右键插旗 / 取消，旗子保护');
{
  const g = fixedGame(3, 3, [0]);
  g.started = true;

  // 插旗
  check('第一次右键 → 插旗', api.toggleFlag(g, 4) === true && g.state[4] === 2 && g.flags === 1);
  // 旗子格左键：无效（经典：不会被点爆）
  const r1 = api.reveal(g, 4);
  check('插旗后左键：不翻开、不点爆', r1.changed === false && r1.hit === false && g.state[4] === 2 && g.opened === 0);
  // 再右键 → 取消
  check('再右键 → 取消插旗', api.toggleFlag(g, 4) === true && g.state[4] === 0 && g.flags === 0);
  // 已翻开的格子不能插旗
  api.reveal(g, 8);
  check('已翻开的格子右键无效', api.toggleFlag(g, 8) === false && g.state[8] === 1);
  // 旗子不设上限（经典里计数器会变负数）
  const big = fixedGame(5, 5, [0]);
  for (let i = 1; i < 10; i++) api.toggleFlag(big, i);
  check('旗数可以超过雷数（经典：计数器变负）', big.flags === 9 && big.flags > big.mineCount, {
    flags: big.flags, mines: big.mineCount,
  });
}

console.log('\n翻开与连锁');
{
  // 3×3，雷在角落 0：点 4（中心，adj=1）只开一格；点 5（adj=0）会连锁
  const g = fixedGame(3, 3, [0]);
  g.started = true;
  api.reveal(g, 4);
  check('点数字格只开自己', g.opened === 1 && g.state[4] === 1);

  const g2 = fixedGame(3, 3, [0]);
  g2.started = true;
  api.reveal(g2, 5);
  const expected = [1, 2, 3, 4, 5, 6, 7, 8].every((i) => g2.state[i] === 1);
  check('点空白格连锁开到底（不含雷格）', expected && g2.opened === 8 && g2.state[0] === 0);

  // 踩雷
  const g3 = fixedGame(3, 3, [0]);
  g3.started = true;
  const r = api.reveal(g3, 0);
  check('踩雷返回 hit', r.hit === true && r.changed === true);
}

console.log('\n和弦（中键）');
{
  const g = fixedGame(3, 3, [0]);   // 雷在左上角
  g.started = true;
  api.reveal(g, 4);                 // 中央是数字 1（邻 0 号雷）
  check('未插旗时不能和弦', api.canChord(g, 4) === false && api.chord(g, 4).changed === false);

  api.toggleFlag(g, 0);
  check('旗数 == 数字时可以和弦', api.canChord(g, 4) === true);

  const before = g.opened;
  const r = api.chord(g, 4);
  check('和弦翻开其余邻格', r.changed === true && g.opened > before && g.state[1] === 1);

  // 旗插错位置时，和弦会踩雷
  const g2 = fixedGame(3, 3, [0]);
  g2.started = true;
  api.reveal(g2, 4);
  api.toggleFlag(g2, 1);            // 插错
  const r2 = api.chord(g2, 4);
  check('旗插错 → 和弦踩雷（与经典一致）', r2.hit === true);
}

console.log('\n胜负判定');
{
  const g = fixedGame(3, 3, [0]);
  g.started = true;
  api.reveal(g, 4);              // 中心是数字格：只开这一格，远没开完
  check('没开完不算赢', api.isWin(g) === false && g.opened === 1);
  // 把剩下的非雷格开掉
  for (const i of [1, 2, 3, 4, 6, 7, 8]) if (g.state[i] === 0) api.reveal(g, i);
  check('非雷格全开即赢', api.isWin(g) === true && g.opened === 8);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} mines-logic: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
