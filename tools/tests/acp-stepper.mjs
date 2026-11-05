#!/usr/bin/env node
/**
 * 回归测试：ACP 面板的步进器必须用**各自的**步长。
 *
 * 2026-11-05 bug：stepperRow 用 `unit === '%' ? RATIO_STEP : GROWTH_STEP` 猜步长，
 * 而 handoff 那一行的单位是 '×'，于是误用 GROWTH_STEP(1000)：
 *   2 + 1000 → 夹到上限 5；2 - 1000 → 夹到下限 1
 * 用户看到的是「点加号直接 5×、点减号直接 1×」，1~5 之间选不到。
 *
 * 这里做源码级断言（UI 步进器在无头环境不便稳定断言，但模式可以锁死）。
 *
 * @module tools/tests/acp-stepper
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../plugins/dsh-context-acp/client.js', import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

check('step 是显式形参', /const stepperRow = \(term, value, unit, min, max, step, onDelta\)/.test(src));
check('加号用 +step', /onDelta\(step\)/.test(src));
check('减号用 -step', /onDelta\(-step\)/.test(src));
check('不再按单位猜步长', !/unit === '%' \? RATIO_STEP/.test(src));
check('阈值行用 RATIO_STEP', /shownPercent, '%', RATIO_MIN, RATIO_MAX, RATIO_STEP/.test(src));
check('增长行用 GROWTH_STEP', /shownGrowth, '', GROWTH_MIN, GROWTH_MAX, GROWTH_STEP/.test(src));
check('兜底行用 RATIO_STEP', /shownFallbackPercent, '%', RATIO_MIN, RATIO_MAX, RATIO_STEP/.test(src));
check('交接行用 1（1~5 可逐个选）', /shownHandoff, '×', HANDOFF_MIN, HANDOFF_MAX, 1,/.test(src));

console.log('');
if (failures > 0) {
  console.log(`  ❌ ${failures} 个断言失败`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
