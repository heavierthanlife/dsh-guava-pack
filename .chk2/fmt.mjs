// 直接跑首页的 formatScore，喂真实记录形态，确认显示为 33s 而不是 33452s
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync('ops/arcade/public/index.html','utf8');
const blocks=[...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
// 页面脚本是 IIFE，把 formatScore 抽出来单独求值即可（它不依赖 DOM）
const src = blocks[blocks.length-1];
const m = /(function normalizeMineMs[\s\S]*?\n  \}\n)([\s\S]*?function formatScore[\s\S]*?\n  \})/.exec(src);
if (!m) { console.log('FAIL 抽不到函数'); process.exit(1); }
const ctx = { console, Number, isFinite, Math };
vm.createContext(ctx);
vm.runInContext(m[1] + m[2] + '\nglobalThis.f = formatScore;', ctx);
const f = ctx.f;

let pass=0, fail=0;
const ok=(l,c,d)=>{ if(c){pass++;console.log('  ok   '+l);} else {fail++;console.log('  FAIL '+l+(d===undefined?'':' — '+d));} };

ok('毫秒记录 33452 → 33s', f('mines',{easy:33452}) === '初级 33s', f('mines',{easy:33452}));
ok('旧秒级记录 33 → 33s', f('mines',{easy:33}) === '初级 33s', f('mines',{easy:33}));
ok('三档混排', f('mines',{easy:33452,medium:88500,hard:120000}) === '初级 33s · 中级 89s · 高级 120s',
  f('mines',{easy:33452,medium:88500,hard:120000}));
ok('秒级旧记录三档', f('mines',{easy:33,medium:88}) === '初级 33s · 中级 88s', f('mines',{easy:33,medium:88}));
ok('全空 → 暂无记录', f('mines',{}) === '暂无记录');
ok('null → 暂无记录', f('mines',null) === '暂无记录');
ok('非数字被忽略', f('mines',{easy:'abc',medium:42000}) === '中级 42s', f('mines',{easy:'abc',medium:42000}));
ok('普通分数不受影响', f('g2048', 128) === '128 分', f('g2048',128));
console.log(`\n${fail===0?'✅':'❌'} ${pass} passed, ${fail} failed`);
process.exitCode = fail===0?0:1;
