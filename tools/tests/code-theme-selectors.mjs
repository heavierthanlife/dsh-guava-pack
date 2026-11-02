#!/usr/bin/env node
/**
 * dsh-code-theme 的「代码面覆盖」自检。
 *
 * ## 为什么需要它（真实事故）
 *
 * 插件原本用 `[class*="_codeBody"]` / `_codeBlock` / `_ioCard` / `_diffBody` /
 * `_terminalBody` 这五个 CSS Module 类名后缀来选择代码容器。DSH 换构建后这些类名
 * 全变了 —— 五个选择器**一个都不再生效**（死选择器），插件实际只覆盖了 `pre`，
 * 于是 ReadBlock（读取卡，div 型 + `data-read`）整块回落到宿主默认 token 表：
 * 用户在设置里选 Monokai Pro，聊天区的读取卡却显示成宿主的粉/紫/蓝/绿（看着像
 * 换了套主题）。没有测试盯着，这种「静默降级」只能靠肉眼发现。
 *
 * ## 这个测试盯什么
 *
 *   1. 宿主产物里仍然存在我们依赖的**语义锚点**（`data-read` / `data-diff` /
 *      `data-terminal`）—— 上游改名就红，提示同步改插件。
 *   2. 插件的 CODE_SEL 覆盖了每一个锚点，且至少含 `pre` / `code`。
 *   3. CODE_SEL 里**不许**再出现 `[class*="_…"]` 这种 CSS Module 哈希依赖
 *      （它一定会随构建漂移，是上次事故的根因）。
 *   4. buildCss 里存在全局 token 层（`:root:root` + `tokenVarsFor`）—— 容器白名单
 *      漏掉的代码面靠它兜底。
 *
 * 找不到 DSH 安装目录时**跳过**（exit 0）：这个测试是开发期守卫，不该让运维机
 * 或纯分发环境因为没装 DSH 而红。
 *
 * 用法：node tools/tests/code-theme-selectors.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const CLIENT = join(PACK, 'plugins/dsh-code-theme/client.js');

/** 我们依赖的语义锚点（宿主 emit 的 data-* 属性，比类名哈希稳定）。 */
const REQUIRED_ANCHORS = ['data-read', 'data-diff', 'data-terminal'];

const DSH_HOME = process.env.DSH_HOME || join(homedir(), 'dsh');
const PRIMITIVES = join(DSH_HOME, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js');

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
};

const source = readFileSync(CLIENT, 'utf8');

/** 取 CODE_SEL 数组里的条目（源码里是单引号字符串 + `.join(',')`）。 */
function codeSelEntries() {
  const block = /const CODE_SEL = \[([\s\S]*?)\]\.join\(','\)/.exec(source);
  if (block === null) return undefined;
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const entries = codeSelEntries();

console.log('\n插件选择器（CODE_SEL）');
check('能解析出 CODE_SEL', Array.isArray(entries) && entries.length > 0, entries);
if (Array.isArray(entries)) {
  check('含稳定元素 pre', entries.includes('pre'));
  check('含稳定元素 code', entries.includes('code'));
  check(
    '不含 CSS Module 哈希依赖（[class*="_…"] 必随构建漂移）',
    entries.every((entry) => !/\[class\*?=["']?_\w/.test(entry)),
    entries,
  );
  for (const anchor of REQUIRED_ANCHORS) {
    check(`覆盖语义锚点 [${anchor}]`, entries.includes(`[${anchor}]`));
  }
}

console.log('\n全局 token 兜底层（buildCss）');
check('定义了 tokenVarsFor', /function tokenVarsFor\(/.test(source));
check('生成 :root:root 全局 token 规则', /:root:root\{[^}]*\$\{tokenVarsFor\(/.test(source) || source.includes(':root:root{${tokenVarsFor(palette.light)}'));
check(
  '生成深色全局 token 规则（:root body[data-ds-dark-theme]）',
  source.includes(':root body[data-ds-dark-theme]{${tokenVarsFor(palette.dark)}'),
);
check('强制明暗时全局 token 层跟随', /lines\.push\(`\$\{prefix\}\{\$\{tokenVarsFor\(forced\)\}\}`\)/.test(source));

if (!existsSync(PRIMITIVES)) {
  console.log(`\n跳过上游锚点核对：找不到 ${PRIMITIVES}`);
  console.log(`(设 DSH_HOME 指向 DSH 安装目录可启用)\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
} else {
  const upstream = readFileSync(PRIMITIVES, 'utf8');
  console.log('\n上游产物里的锚点（DSH client-ui-primitives）');
  for (const anchor of REQUIRED_ANCHORS) {
    check(`上游仍 emit "${anchor}"`, upstream.includes(`"${anchor}"`));
  }
  // 反向线索：如果上游出现了新的代码面锚点而我们没覆盖，给出可见警告（不判红，
  // 避免上游加个无关的 data-* 就误报；但打印出来提示人工确认）。
  const upstreamAnchors = [...upstream.matchAll(/"data-([a-z-]+)": ""/g)].map((match) => `data-${match[1]}`);
  const uncovered = [...new Set(upstreamAnchors)].filter(
    (anchor) => REQUIRED_ANCHORS.includes(anchor) === false && (anchor.includes('code') || anchor.includes('read') || anchor.includes('diff') || anchor.includes('terminal')),
  );
  if (uncovered.length > 0) {
    console.log(`  ℹ️  上游还有疑似代码面锚点未覆盖（人工确认）：${uncovered.join(', ')}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}
