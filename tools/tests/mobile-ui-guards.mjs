#!/usr/bin/env node
/**
 * 手机界面适配的**静态守卫**（不需要浏览器，进 `npm test`）。
 *
 * ## 它防的是什么
 *
 * 2026-10-28 的真实漂移：`dsh-context-guard` 合并进 `dsh-context-acp` 后，
 * "给 composer dock 撑开布局"的那段 JS 一起被删了。结果手机端 dock 只有 32px，
 * 所有插件药丸变成 0 宽跑到屏幕外 —— 但**单测全绿、控制台无报错**。
 *
 * 动态版由 `tools/mobile-audit.mjs` 在真实浏览器里量；这里补一层**静态**守卫：
 * 只要有人再把关键规则删掉/改小，`npm test` 立刻红，不必等到真机。
 *
 * 断言的都是"承载能力的骨架"，不是像素级外观：
 *   1. mobile-ui 必须拥有 dock 布局（打标 + 撑开规则）；
 *   2. ACP 面板的步进按钮在手机端必须有 ≥40px 的可点区域；
 *   3. 药丸必须有手机短标签；
 *   4. 各插件在窄屏下必须允许换行或抬高触控尺寸；
 *   5. 不允许出现 >360px 的硬编码宽度（手机上必然溢出）。
 *
 * @module tools/tests/mobile-ui-guards
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const read = (rel) => readFileSync(join(PACK, rel), 'utf8');

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

const mobileUiRaw = read('plugins/dsh-mobile-ui/lib/client.js');
// mobile-ui 的 CSS 由字符串拼接而成（':root.' + PHONE_CLASS + ' ...'）；
// 直接对源码做正则会被拼接打断，先归一化成最终选择器文本再断言。
const mobileUi = mobileUiRaw
  .replace(/'\:root\.'\s*\+\s*PHONE_CLASS\s*\+\s*'/g, "':root.dsh-phone ")
  .replace(/'\:root\.'\s*\+\s*PHONE_CLASS\s*\+\s*"[^"]*"/g, "':root.dsh-phone ")
  // 拼接还原后会出现双空格（'…dsh-phone ' + ' .xxx'），统一压成一个
  .split(':root.dsh-phone  ').join(':root.dsh-phone ')
const acp = read('plugins/dsh-context-acp/client.js');
const purge = read('plugins/dsh-session-purge/client.js');
const router = read('plugins/provider-router/lib/client.js');
const search = read('plugins/dsh-web-search-switch/lib/client.js');

// ── 1. 旧版两列布局的归属：mobile-ui 负责 dock 网格 ─────────────────────
// 2026-10-28 复现：关闭侧栏时 dock 有 350px，但内部是一行 flex → 三块挤成一排、
// 文字被截断。旧版（context-guard 时期）是 2×2 网格：左列统计上下叠放、右列
// 占用与插件药丸上下叠放。布局归属回到 mobile-ui。
console.log('\ndock 两列布局（mobile-ui）');
check('mobile-ui 提供 installComposerDock', /function installComposerDock\s*\(/.test(mobileUi));
check('apply 里安装 dock 布局', /return installComposerDock\(\)/.test(mobileUi));
check('从统计锚点定位 dock（bOPqQW）', /bOPqQW/.test(mobileUi) && /_dock/.test(mobileUi));
check('dock 改为两列网格', /:root\.dsh-phone \.dsh-mobile-dock\s*\{[^}]*display:\s*grid/.test(mobileUi) &&
  /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/.test(mobileUi));
check('统计在左列上下叠放', /bOPqQW[^}]*grid-row:\s*1\s*\/\s*span 2/.test(mobileUi) &&
  /bOPqQW[^}]*flex-direction:\s*column/.test(mobileUi));
check('占用量在右列上行', /JObwrW[^}]*grid-row:\s*1/.test(mobileUi) && /JObwrW[^}]*grid-column:\s*2/.test(mobileUi));
check('插件药丸在右列下行（内联，非悬浮）', /_anchor"\]?:not\(\[class\*="bOPqQW"\]\)[^}]*grid-row:\s*2/.test(mobileUi));
check('DOM 重建后能重新打标（MutationObserver）', /MutationObserver/.test(mobileUi));

// ── 2. ACP 面板的手机尺寸 ──────────────────────────────────────────────
console.log('\nACP 面板手机适配');
// 手机规则现在以 `:root.dsh-phone .acp_*` 选择器书写（不再只放 @media），
// 所以这里把所有这些规则拼起来当"手机形态"的权威文本。
// 选择器可能带伪元素（.acp_step::after）或后代（.acp_rows dt），
// 所以匹配到 `{` 之前允许任意非括号字符。
const acpPhone = [...acp.matchAll(/:root\.dsh-phone \.acp_[^{]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
check('存在手机形态规则（:root.dsh-phone）', acpPhone.length > 0);
check('步进按钮可点区域用 ::after 扩到 ≥40（视觉尺寸不撑高面板）',
  /:root\.dsh-phone \.acp_step::after\s*\{[^}]*inset:\s*-[4-9]px/.test(acpPhone), acpPhone.slice(0, 120));
check('长标签在手机上允许折行（dt 不再 nowrap）',
  /:root\.dsh-phone \.acp_rows dt\s*\{[^}]*white-space:\s*normal/.test(acpPhone));
check('面板最大高度用 dvh 且可滚动',
  /max-height:\s*min\(\d+dvh/.test(acpPhone) && /overflow-y:\s*auto/.test(acpPhone));
check('手机用完整文案（旧版样式），短标签保留但隐藏',
  /\.acp_short\s*\{\s*display:\s*none/.test(acp) && !/:root\.dsh-phone \.acp_short\s*\{\s*display:\s*inline/.test(acpPhone));
check('药丸在手机上抬高到 ≥40px', /:root\.dsh-phone \.acp_pill\s*\{[^}]*min-height:\s*40px/.test(acpPhone));

// 2026-10-28 两个实测踩到的坑，各钉一条：
// ① 手机规则不能只挂 @media —— 横屏宽度 844 > 520 时媒体查询不命中，
//    但宿主仍然标记 dsh-phone，于是药丸又变回 0 宽。
check('手机规则以 :root.dsh-phone 为准（横屏也生效）',
  /:root\.dsh-phone \.acp_anchor\s*\{/.test(acp) && /:root\.dsh-phone \.acp_panel\s*\{/.test(acp));
// ② 悬浮锚点不能带 backdrop-filter/filter/transform —— 它们会给 fixed 后代
//    创建包含块，面板变成相对药丸定位（实测横屏面板 91px 宽、top=-80）。
const anchorRule = acp.match(/:root\.dsh-phone \.acp_anchor\{([^}]*)\}/)?.[1] ?? '';
check('悬浮锚点不创建包含块（无 backdrop-filter/filter/transform）',
  !/backdrop-filter|(^|[^-])filter\s*:|transform\s*:/.test(anchorRule), anchorRule.slice(0, 120));

// ── 3. 其它插件的窄屏处理 ──────────────────────────────────────────────
console.log('\n其它插件');
check('session-purge 手机行高 ≥40px',
  /@media \(max-width:520px\)\{[\s\S]*?\.spurge_row\{min-height:40px/.test(purge), purge.match(/\.spurge_row\{min-height:\d+px/)?.[0]);
check('provider-router 行允许换行', /flexWrap:\s*'wrap'/.test(router));
check('provider-router 按钮最小高度 ≥32', /minHeight:\s*3[2-9]/.test(router));
check('provider-router 备注可断词', /wordBreak:\s*'break-word'/.test(router));
check('web-search 输入行在手机上换行', /\.wsw_key \.row\{flex-wrap:wrap\}/.test(search));

// ── 4. 禁止硬编码大宽度 ────────────────────────────────────────────────
console.log('\n窄屏安全（无硬编码大宽度）');
const clientFiles = [
  'plugins/dsh-context-acp/client.js',
  'plugins/dsh-mobile-ui/lib/client.js',
  'plugins/dsh-session-purge/client.js',
  'plugins/provider-router/lib/client.js',
  'plugins/dsh-web-search-switch/lib/client.js',
  'plugins/dsh-code-theme/client.js',
  'plugins/dsh-theme-manager/lib/client.js',
  'plugins/dsh-theme-cyberpunk2077/lib/client.js',
];
const offenders = [];
for (const rel of clientFiles) {
  const src = read(rel);
  for (const line of src.split('\n')) {
    // 媒体查询的断点（max-width: 520px 之类）不是布局宽度，跳过；
    // 注释行（含中文说明、没有 CSS 声明结尾的分号）也跳过。
    if (/@media/.test(line) || !/;/.test(line)) continue;
    for (const m of line.matchAll(/(?<!max-)\b(?:width|min-width):\s*(\d{3,4})px/g)) {
      const px = Number(m[1]);
      if (px > 360) offenders.push({ file: rel, px, line: line.trim().slice(0, 60) });
    }
  }
}
check('没有 >360px 的硬编码宽度（手机上必然溢出）', offenders.length === 0, offenders.slice(0, 6));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
