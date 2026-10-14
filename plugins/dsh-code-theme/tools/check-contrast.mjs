#!/usr/bin/env node
/**
 * dsh-code-theme/tools/check-contrast.mjs — 确定性的视觉验收。
 *
 * 为什么要有它：配色"好不好看"可以让人（或模型）看，但"看不看得清"是**可计算的**。
 * 这个脚本按 WCAG 2.1 逐项算对比度，低于 AA（4.5:1）就报错退出。
 * 手机屏幕小、亮度高，低于 4.5 的 token（原版 Monokai 的注释色只有 ~2.6:1）
 * 基本等于看不见。
 *
 * 调色板**不复制**：直接从 client.js 里把 `const PALETTES = {…}` 抽出来解析，
 * 保证这份检查永远对着真实生效的那份数据。
 *
 * 用法：node tools/check-contrast.mjs [--min 4.5]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');

const minFlag = process.argv.indexOf('--min');
const MIN = minFlag >= 0 ? Number(process.argv[minFlag + 1]) : 4.5;

/** sRGB 相对亮度（WCAG 2.1）。 */
function luminance(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度（1~21）。 */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 从 client.js 里抽出 PALETTES 对象字面量（不复制数据，避免两份真相）。 */
function loadPalettes() {
  const src = readFileSync(CLIENT, 'utf8');
  const start = src.indexOf('const PALETTES = ');
  if (start < 0) throw new Error('client.js 里找不到 const PALETTES');
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('PALETTES 花括号不平衡');
  const literal = src.slice(open, end);
  // 只求值这一段字面量；它不含函数或外部引用。
  return new Function(`return ${literal};`)();
}

const TOKENS = ['constant', 'string', 'comment', 'keyword', 'parameter', 'function', 'string-expression', 'punctuation', 'link'];

/**
 * 从 client.js 抽出纯函数区并在沙箱里求值，拿到真实的 buildCss。
 * 抽的是 `const SHIKI_TOKENS` 到样例数据之前那一段（含 varsFor / scope / buildCss）。
 */
function loadBuilder() {
  const src = readFileSync(CLIENT, 'utf8');
  const start = src.indexOf('const SHIKI_TOKENS');
  let end = src.indexOf('/** 代码预览用的样例');
  if (end < 0) end = src.indexOf('function overrideLayer');
  if (start < 0 || end < 0 || end <= start) throw new Error('client.js 结构变了：找不到纯函数区');
  const body = src.slice(start, end);
  return new Function(`const PKG_ID = 'dsh-code-theme';\n${body}\nreturn { buildCss, PALETTE_IDS };`)();
}

/**
 * 结构检查：对每种调色板 × 明暗 × 字体开关，检查生成的 CSS。
 *
 * 最重要的一条：**每个声明块都必须带 color**。没有语言标签的代码块不会分词，
 * 那段文字的颜色只由容器的 color 决定 —— 只设 --shiki-* 变量会被主题的
 * `code{color:…}` 接管（真实踩过的坑）。
 */
function checkCss() {
  const { buildCss, PALETTE_IDS } = loadBuilder();
  let failed = 0;
  let combos = 0;

  // 防呆：源文件里的调色板 label 数量必须等于解析出的键数量。
  // 曾经把新调色板插进了别的对象（锚点选错）—— 语法合法、node --check 不报、
  // 但静默失效。这一条专门拦这种情况。
  const labelCount = (readFileSync(CLIENT, 'utf8').match(/^\s*label: '/gm) ?? []).length;
  if (labelCount !== PALETTE_IDS.length) {
    failed += 1;
    console.log(`  ❌ 源文件有 ${labelCount} 个调色板 label，但 PALETTES 只解析出 ${PALETTE_IDS.length} 个 —— 有调色板没进对象`);
  }

  for (const id of PALETTE_IDS) {
    for (const scheme of ['auto', 'dark', 'light']) {
      for (const font of [true, false]) {
        combos += 1;
        const css = buildCss(id, scheme, font);
        const problems = [];
        const open = (css.match(/\{/g) ?? []).length;
        const close = (css.match(/\}/g) ?? []).length;
        if (open !== close) problems.push(`花括号不平衡 ${open}/${close}`);
        for (const block of css.match(/\{[^}]*\}/g) ?? []) {
          // 语义规则：凡声明了 --shiki-* 的块都必须同时给容器 color。
          // 全局字体变量块（--dsw-font-mono）不在此列。
          if (block.includes('--shiki-') && !block.includes('color:')) {
            problems.push('有 token 声明块缺少 color');
          }
        }
        for (const token of TOKENS) {
          if (!css.includes(`--shiki-token-${token}:`)) problems.push(`缺 --shiki-token-${token}`);
        }
        if (!css.includes('--shiki-background:')) problems.push('缺 --shiki-background');
        if (font && !css.includes('--ds-font-family-code')) problems.push('开了字体却没写 --ds-font-family-code');
        if (font && !css.includes('--dsw-font-mono')) problems.push('开了字体却没写 --dsw-font-mono（文件查看器/日志/JSON 面板会漏）');
        if (!font && css.includes('--ds-font-family-code')) problems.push('关了字体却仍写 --ds-font-family-code');
        if (!font && css.includes('--dsw-font-mono')) problems.push('关了字体却仍写 --dsw-font-mono');
        if (scheme !== 'auto' && !css.includes(`.dct-force-${scheme}`)) problems.push(`强制 ${scheme} 没有对应规则`);
        if (scheme === 'auto' && css.includes('.dct-force-')) problems.push('auto 模式不该出现强制规则');
        if (problems.length > 0) {
          failed += 1;
          console.log(`  ❌ ${id} / ${scheme} / font=${font}：${[...new Set(problems)].join('；')}`);
        }
      }
    }
  }

  console.log(`\nCSS 结构：${combos} 种组合，问题 ${failed} 处`);
  return failed;
}

function main() {
  const palettes = loadPalettes();
  let failed = 0;
  let checked = 0;

  for (const [id, palette] of Object.entries(palettes)) {
    for (const mode of ['light', 'dark']) {
      const m = palette[mode];
      const bg = m.background;
      console.log(`\n${palette.label} · ${mode}  (bg ${bg})`);
      const rows = [['foreground', m.foreground], ...TOKENS.map((t) => [t, m[t]])];
      for (const [name, color] of rows) {
        if (typeof color !== 'string') {
          console.log(`  ✗ ${name}: 缺色`);
          failed += 1;
          continue;
        }
        const ratio = contrast(color, bg);
        checked += 1;
        const pass = ratio >= MIN;
        if (!pass) failed += 1;
        console.log(`  ${pass ? '✅' : '❌'} ${name.padEnd(18)} ${color}  ${ratio.toFixed(2)}:1`);
      }
      // 行内代码：底色是 inline，文字用 foreground
      const inlineRatio = contrast(m.foreground, m.inline);
      checked += 1;
      if (inlineRatio < MIN) failed += 1;
      console.log(`  ${inlineRatio >= MIN ? '✅' : '❌'} ${'inline(前景/底)'.padEnd(16)} ${m.inline}  ${inlineRatio.toFixed(2)}:1`);
    }
  }

  console.log(`\n共检查 ${checked} 项，低于 ${MIN}:1 的有 ${failed} 项`);

  const cssProblems = checkCss();

  return failed === 0 && cssProblems === 0 ? 0 : 1;
}

process.exit(main());
