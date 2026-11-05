#!/usr/bin/env node
/**
 * 回归测试：面板提交的字段必须真的能改到 runtime。
 *
 * 2026-11-05 实测 bug：面板调「兜底自动压缩：nudge 阈值」时，界面闪出“已保存”，
 * 但数值一动不动。根因是**键名不匹配**：
 *
 *   客户端提交扁平键   { fallbackRatio: 0.9, handoffAfter: 3, ... }
 *   服务端 readTunable(payload, 'fallback', 'ratio')
 *     → 嵌套找 payload.fallback.ratio（无）
 *     → 扁平回退找 payload['ratio']（也没有，扁平键叫 fallbackRatio）
 *     → 永远 undefined → patch 为空 → setSettings 仍然返回 saved:true
 *
 * 所以这个测试用**客户端真实形状的 payload** 断言每个字段都进入 changed。
 *
 * @module tools/tests/acp-settings
 */

import { applyTunables } from '../../plugins/dsh-context-acp/lib/settings.mjs';

const runtime = {
  nudge: { pressureRatio: 0.65, growthTokens: 12000 },
  retain: { decompressPageSize: 8, searchLimit: 20 },
  fallback: { ratio: 0.75 },
  handoff: { afterCompactions: 2 },
};

/** 与 client.js 里 rpc('setSettings', {...}) 完全一致的形状。 */
const clientPayload = {
  pressureRatio: 0.5,
  growthTokens: 20000,
  fallbackRatio: 0.9,
  handoffAfter: 3,
};

const { runtime: next, changed } = applyTunables(runtime, clientPayload);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
};

console.log('用例 1：客户端扁平键全部生效');
check('pressureRatio', changed.pressureRatio === 0.5, changed.pressureRatio);
check('growthTokens', changed.growthTokens === 20000, changed.growthTokens);
check('fallbackRatio', changed.fallbackRatio === 0.9, `changed=${changed.fallbackRatio} runtime=${next.fallback?.ratio}`);
check('handoffAfter', changed.handoffAfter === 3, `changed=${changed.handoffAfter} runtime=${next.handoff?.afterCompactions}`);

console.log('\n用例 2：嵌套键也仍然支持（旧客户端/手写配置）');
const nested = applyTunables(runtime, { fallback: { ratio: 0.85 }, handoff: { afterCompactions: 4 } });
check('nested fallback.ratio', nested.changed.fallbackRatio === 0.85, nested.changed.fallbackRatio);
check('nested handoff.afterCompactions', nested.changed.handoffAfter === 4, nested.changed.handoffAfter);

console.log('\n用例 3：越界值被夹取，而不是被丢弃');
const clamped = applyTunables(runtime, { fallbackRatio: 0.99, handoffAfter: 99 });
check('fallbackRatio 夹到上限', clamped.changed.fallbackRatio === 0.95, clamped.changed.fallbackRatio);
check('handoffAfter 夹到上限', clamped.changed.handoffAfter === 5, clamped.changed.handoffAfter);

console.log('\n用例 4：非法值保留原值（不产生 patch）');
const invalid = applyTunables(runtime, { fallbackRatio: 'abc', handoffAfter: -1 });
check('非法 fallbackRatio 不产生 patch', invalid.changed.fallbackRatio === undefined);
check('非法 handoffAfter 不产生 patch', invalid.changed.handoffAfter === undefined);

console.log('');
if (failures > 0) {
  console.log(`  ❌ ${failures} 个断言失败`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
