#!/usr/bin/env node
/**
 * tools/tests/arcade-pages.mjs — 休闲角页面的静态门禁。
 *
 * ## 它防的是什么
 *
 * 这套页面是纯静态的，没有构建步骤、没有依赖 —— 好处是改起来快，坏处是
 * **没有任何编译器帮我们抓错**。真实会发生的漂移：
 *
 *   · 页面写了 `src="/logo.png"` → 丢掉令牌前缀（前缀是路径 `/x970…/`），
 *     于是 404，但本地直接开文件时完全正常；
 *   · 复制别处的模板带进来一个 `https://fonts.googleapis.com` → 断网就白屏，
 *     而这套页面明确承诺离线可用；
 *   · 忘了 `href="index.html"` 返回链接 → 进去出不来（手机上只能改地址栏）；
 *   · `localStorage` 裸读写 → Safari 隐私模式直接抛异常，整页脚本死掉。
 *
 * 全部断言都是"承重的骨架"，不是像素级外观。
 *
 * 用法：node tools/tests/arcade-pages.mjs
 *
 * @module tools/tests/arcade-pages
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const PUBLIC = join(PACK, 'ops', 'arcade', 'public');

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

/** 期望存在的页面（首页 + 7 个内容页）。顺序即输出顺序。 */
const PAGES = [
  ['index.html', '统一首页'],
  ['g2048.html', '2048'],
  ['snake.html', '贪吃蛇'],
  ['mines.html', '扫雷'],
  ['tetris.html', '俄罗斯方块'],
  ['relax.html', '放松一下'],
  ['decide.html', '选择困难'],
  ['pixel.html', '像素画板'],
];

console.log('\n存在的页面');
const missing = PAGES.filter(([file]) => !existsSync(join(PUBLIC, file)));
check('8 个页面齐全', missing.length === 0, missing.map(([f]) => f).join(', '));
check('共用样式存在', existsSync(join(PUBLIC, 'shared.css')));

// 缺文件时后面的逐页断言会全部刷屏，直接收口
if (missing.length > 0) {
  console.log(`\n❌ arcade-pages: ${passed} passed, ${failed} failed（缺文件，跳过逐页检查）`);
  process.exit(1);
}

for (const [file, label] of PAGES) {
  console.log(`\n${file}（${label}）`);
  const raw = readFileSync(join(PUBLIC, file), 'utf8');

  check('是完整 HTML 文档', /^\s*<!doctype html>/i.test(raw) && /<html[\s>]/i.test(raw), undefined);
  check('声明 UTF-8', /charset=["']?utf-8/i.test(raw));
  check('有 viewport meta', /name=["']viewport["'][^>]*width=device-width/i.test(raw),
    '手机上会按 980px 渲染，所有布局都塌');
  check('有 color-scheme dark', /name=["']color-scheme["']/i.test(raw));

  // 外部资源：这套页面承诺离线可用，任何外链都是违约。
  // 排除 xmlns（SVG 命名空间不是请求）与 HTML 注释里的说明文字。
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
  const externalRefs = [...withoutComments.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\//gi)]
    .map((match) => match[0]);
  check('无外部资源引用', externalRefs.length === 0, externalRefs.slice(0, 3).join(', '));

  // 前导斜杠绝对路径会丢掉 /<令牌>/ 前缀
  const absolutePaths = [...withoutComments.matchAll(/(?:src|href)\s*=\s*["']\/(?!\/)/gi)].map((m) => m[0]);
  check('无前导斜杠绝对路径', absolutePaths.length === 0, absolutePaths.slice(0, 3).join(', '));

  check('无 eval(', !/\beval\s*\(/.test(withoutComments));
  check('无 new Function', !/new\s+Function\s*\(/.test(withoutComments));
  check('无 document.write', !/document\.write\s*\(/.test(withoutComments));

  // 不泄漏令牌相关的实现细节
  check('未出现令牌变量名', !/dsh_arcade|DSH_ARCADE|PREFIX/i.test(withoutComments));

  if (file !== 'index.html') {
    check('有统一顶栏', /class=["'][^"']*\btopbar\b/.test(raw));
    check('返回链接指向 index.html', /class=["'][^"']*\bback\b[^>]*href=["']index\.html["']/i.test(raw)
      || /href=["']index\.html["'][^>]*class=["'][^"']*\bback\b/i.test(raw),
    '没有返回链接的手机用户只能改地址栏');
    check('引用了共用样式', /href=["']shared\.css["']/i.test(raw));
  }
}

// ── localStorage 必须包在 try 里 ────────────────────────────────────────────
// Safari 隐私模式 / 禁用 cookie 时，裸访问 localStorage 会抛 SecurityError，
// 而它在脚本顶层 —— 一抛整个页面就死，表现为"点了没反应"。
console.log('\nlocalStorage 安全性');
for (const [file] of PAGES) {
  const raw = readFileSync(join(PUBLIC, file), 'utf8');
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const uses = [...withoutComments.matchAll(/localStorage\s*\.\s*(?:getItem|setItem|removeItem)/g)];
  if (uses.length === 0) {
    check(`${file}：未使用 localStorage`, true);
    continue;
  }
  // 粗略但有效：每个使用点往前 600 字符内必须出现 try
  const allGuarded = uses.every((match) => {
    const before = withoutComments.slice(Math.max(0, match.index - 600), match.index);
    return /\btry\s*\{/.test(before);
  });
  check(`${file}：localStorage 访问都在 try 内（${uses.length} 处）`, allGuarded,
    '隐私模式会抛 SecurityError 并让整页脚本停止');
}

// ── 键名前缀约定 ────────────────────────────────────────────────────────────
console.log('\n存档键名约定');
const EXPECTED_KEYS = {
  'g2048.html': 'arcade.g2048.best',
  'snake.html': 'arcade.snake.best',
  'mines.html': 'arcade.mines.best',
  'tetris.html': 'arcade.tetris.best',
  'relax.html': 'arcade.relax.settings',
  'decide.html': 'arcade.decide.options',
  'pixel.html': 'arcade.pixel.canvas',
};
for (const [file, key] of Object.entries(EXPECTED_KEYS)) {
  const raw = readFileSync(join(PUBLIC, file), 'utf8');
  check(`${file}：使用键 ${key}`, raw.includes(key),
    '键名是页面之间唯一的约定，改了就等于丢掉用户存档');
}

// ── 首页链接完整性 ──────────────────────────────────────────────────────────
console.log('\n首页链接');
const index = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
for (const [file] of PAGES) {
  if (file === 'index.html') continue;
  check(`首页链接到 ${file}`, index.includes(`href="${file}"`), `缺 href="${file}"`);
}
// 反向：首页不许链到不存在的文件
const linked = [...index.matchAll(/href=["']([^"'#?]+\.html)["']/g)].map((m) => m[1]);
const broken = linked.filter((target) => !existsSync(join(PUBLIC, target)));
check('首页没有死链', broken.length === 0, broken.join(', '));

// ── shared.css 骨架 ─────────────────────────────────────────────────────────
console.log('\n共用样式');
const css = readFileSync(join(PUBLIC, 'shared.css'), 'utf8');
check('有顶栏样式', /\.topbar\s*\{/.test(css));
check('有返回按钮样式', /\.back\s*\{/.test(css));
check('有按钮样式', /\.btn\s*\{/.test(css));
check('触控尺寸变量 ≥44px', /--tap:\s*44px/.test(css), '小于 44 手机上点不准');
check('尊重 prefers-reduced-motion', /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css));
check('无外部字体', !/@import|fonts\.googleapis|fonts\.gstatic/.test(css));

console.log(`\n${failed === 0 ? '✅' : '❌'} arcade-pages: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
