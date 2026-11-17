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
import vm from 'node:vm';

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

// ── 变量定义完整性（2026-11-17 真实踩过）──────────────────────────────────
// 教训：重构配色时删掉了 --tap / --radius 的定义，但 8 个文件仍在用 var(--tap)。
// CSS 对未定义的自定义属性**不报错**，只是让 min-height 退化成 auto ——
// 于是所有按钮塌成一行文字高度，手机上几乎点不中，而所有门禁全绿。
// 所以这里机械核对：凡是被 var(--x) 引用的属性，必须真的定义过。
console.log('\nCSS 变量完整性');
const definedVars = new Set(
  [...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]),
);
// 运行时才由 arcade.js 写到 <html> 上的属性（不在 CSS 里定义，属正常）
const runtimeVars = new Set(['--accent', '--accent-soft']);
const usedVars = new Set(
  [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]),
);
const missingVars = [...usedVars].filter((name) => !definedVars.has(name) && !runtimeVars.has(name));
check(`引用的 CSS 变量都有定义（共 ${usedVars.size} 个）`, missingVars.length === 0,
  `未定义却在用：${missingVars.join(', ')}`);
check('明暗两套底色都定义了', /html\[data-mode="dark"\]/.test(css) && /html\[data-mode="light"\]/.test(css));

// ── 主题与明暗（2026-11-17 新增需求）─────────────────────────────────────
console.log('\n主题系统');
const arcadeJs = readFileSync(join(PUBLIC, 'arcade.js'), 'utf8');
check('共用运行时存在 arcade.js', arcadeJs.length > 2000);
check('首页的 5 套主题在 CSS 里都有定义',
  ['graphite', 'cyber', 'navy', 'ember', 'ice'].every((t) => css.includes(`[data-theme="${t}"]`)),
  '缺主题选择器');
check('每个子页面的强调色都定义了（暗/亮各一套）',
  ['gold', 'mint', 'rose', 'violet', 'sky', 'sunset', 'cyan'].every(
    (a) => css.includes(`[data-accent="${a}"][data-mode="dark"]`)
      && css.includes(`[data-accent="${a}"][data-mode="light"]`),
  ),
  '缺 data-accent 规则');

for (const [file] of PAGES) {
  const raw = readFileSync(join(PUBLIC, file), 'utf8');
  check(`${file}：加载了 arcade.js`, /<script\s+src=["']arcade\.js["']/.test(raw));
  if (file === 'index.html') {
    check('index.html：initTheme 用 themes 模式', /initTheme\(\{\s*themes:\s*true\s*\}\)/.test(raw));
    check('index.html：有主题下拉', /id=["']theme["']/.test(raw));
  } else {
    check(`${file}：initTheme 带 page 与 accent`, /initTheme\(\{[^}]*page:\s*'[a-z0-9]+'[^}]*accent:\s*'[a-z]+'/i.test(raw)
      || /initTheme\(\{[^}]*accent:\s*'[a-z]+'[^}]*page:\s*'[a-z0-9]+'/i.test(raw));
  }
  check(`${file}：顶栏有明暗切换按钮`, /id=["']mode["']/.test(raw));
}

// 每个子页面都要真的把切换按钮接上，否则按钮点了没反应
console.log('\n明暗切换接线');
for (const [file] of PAGES) {
  const raw = readFileSync(join(PUBLIC, file), 'utf8');
  if (file === 'index.html') {
    check('index.html：切换按钮有事件处理', /toggleMode\(/.test(raw));
    continue;
  }
  check(`${file}：mountModeToggle 已调用`, /mountModeToggle\s*\(/.test(raw),
    '按钮存在但没接线 = 点了没反应');
}

// ── 首页卡片：新标签页打开（2026-11-17 需求）────────────────────────────
console.log('\n首页卡片行为');
const indexRaw = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const cardAnchors = [...indexRaw.matchAll(/<a\b[^>]*class=["'][^"']*\bentry\b[^"']*["'][^>]*>/g)].map((m) => m[0]);
check('首页有入口卡', cardAnchors.length >= 7, `找到 ${cardAnchors.length} 张`);
const notBlank = cardAnchors.filter((tag) => !/target=["']_blank["']/.test(tag));
check('所有入口卡都用新标签页打开', notBlank.length === 0,
  `${notBlank.length} 张缺 target="_blank"`);
const noOpener = cardAnchors.filter((tag) => /target=["']_blank["']/.test(tag) && !/rel=["'][^"']*noopener/.test(tag));
check('新标签页都带 rel="noopener"', noOpener.length === 0,
  '缺 noopener 会让被打开的页面能操作本页');

// ── 扫雷时间的单位口径（2026-11-17 真实 bug）──────────────────────────────
// 扫雷的 best 存**毫秒**（33452 = 33.452 秒）。首页曾经直接
// `Math.round(v) + 's'`，把毫秒当秒显示成「33452s」——用户反馈"我明明是 33 秒"。
// 这类错误静态 grep 抓不到（代码完全合法），只能真跑格式化函数。
console.log('\n扫雷时间格式化');
{
  const indexScript = [...readFileSync(join(PUBLIC, 'index.html'), 'utf8')
    .matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop();
  const extracted = /(function normalizeMineMs[\s\S]*?\n  \})/.exec(indexScript);
  const formatter = /(function formatScore[\s\S]*?\n  \})/.exec(indexScript);
  if (extracted === null || formatter === null) {
    check('首页能抽出 formatScore 与归一函数', false, '函数改名或删除会导致本门禁失效');
  } else {
    const sandbox = { console, Number, isFinite, Math };
    vm.createContext(sandbox);
    vm.runInContext(`${extracted[1]}\n${formatter[1]}\nglobalThis.f = formatScore;`, sandbox);
    const format = sandbox.f;
    check('毫秒记录显示为秒（33452 → 33s）', format('mines', { easy: 33452 }) === '初级 33s',
      format('mines', { easy: 33452 }));
    check('旧秒级记录也显示为秒（33 → 33s）', format('mines', { easy: 33 }) === '初级 33s',
      format('mines', { easy: 33 }));
    check('三档同时存在时都归一', format('mines', { easy: 33452, medium: 88500 }) === '初级 33s · 中级 89s',
      format('mines', { easy: 33452, medium: 88500 }));
    check('普通游戏的分数不受影响', format('g2048', 128) === '128 分', format('g2048', 128));
  }
}

// ── 存档槽与记录管理 ────────────────────────────────────────────────────
console.log('\n存档与记录');
check('arcade.js 提供存档槽 API', /mountSlots\s*:/.test(arcadeJs));
check('arcade.js 提供分数行 API', /mountScoreRow\s*:/.test(arcadeJs));
check('存档上限是 5', /MAX_SLOTS\s*=\s*5/.test(arcadeJs));
check('超限时按分数淘汰（不是按时间）',
  /score/.test(arcadeJs) && /evicted/.test(arcadeJs) && /worst/.test(arcadeJs));
check('二次确认不用 window.confirm（样式与测试都不可控）', !/window\.confirm\s*\(/.test(arcadeJs));
check('二次确认有超时自动复原', /disarm/.test(arcadeJs) && /setTimeout/.test(arcadeJs));

// 4 个游戏必须接上存档
console.log('\n游戏存档接线');
for (const game of ['g2048.html', 'snake.html', 'mines.html', 'tetris.html']) {
  const raw = readFileSync(join(PUBLIC, game), 'utf8');
  check(`${game}：mountSlots 已调用`, /mountSlots\s*\(/.test(raw), '没接存档槽');
  check(`${game}：提供了 capture 与 restore`, /capture\s*:/.test(raw) && /restore\s*:/.test(raw));
  check(`${game}：提供了 onPause（退出要暂停）`, /onPause\s*:/.test(raw));
  check(`${game}：有最高分删除入口`, /mountScoreRow\s*\(/.test(raw) || /delScore\s*\(/.test(raw));
}

console.log(`\n${failed === 0 ? '✅' : '❌'} arcade-pages: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
