#!/usr/bin/env node
/**
 * tools/tests/acp-time-context.mjs — time-context 读数间隔的回归门禁。
 *
 * 为什么需要（2026-11-26）：
 *   升级到 0.2.2 后，会话里每 10 分钟就出现一条完整的「上下文注入 / time-context /
 *   取代先前的快照」块。文本本身是 **0.2.2 的新行为**（运行时上下文记录加了提醒包装，
 *   见升级指南 v0.2.2-rc.1/runtime-context-reminders），不是故障；吵的是频率。
 *
 *   频率写死在 `@deepseek-ai/dsh-time-context` 的插件默认值（refreshIntervalMs = 600000），
 *   而该行在 **preset** 里、不在 profile 的条目树里 —— profile patch 够不着它。
 *   唯一稳定的改法是在生成器里改：值放 `acp.json` 的 `timeContext.refreshIntervalMs`，
 *   由 `tools/gen-acp-preset.mjs` 写进 preset 覆盖层。
 *
 *   这个测试钉住三件事，任何一件退化都会让「调过的间隔」悄悄回到 10 分钟：
 *     1. 生成出的每个 time-context 行都带上了配置值；
 *     2. 值本来就是合法且被调过的（不是 0、不是上游默认的 10 分钟）；
 *     3. `timeContext` 没有混进 runtime.json（它是生成期输入，不是引擎配置）。
 *
 * 用法：node tools/tests/acp-time-context.mjs
 *
 * @module tools/tests/acp-time-context
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const CONFIG_DIR = join(PACK, 'plugins', 'dsh-context-acp', 'config');
const ACP_JSON = join(CONFIG_DIR, 'acp.json');
const GENERATED = join(CONFIG_DIR, 'preset-override.generated.yml');
const RUNTIME = join(CONFIG_DIR, 'runtime.json');
const GENERATOR = join(PACK, 'tools', 'gen-acp-preset.mjs');

/** 上游插件默认值：600000ms = 10 分钟。调过就必须与它不同。 */
const UPSTREAM_DEFAULT_MS = 600000;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// ── 1. 配置源 ────────────────────────────────────────────────────────────
console.log('\n配置源（acp.json）');
const acp = JSON.parse(readFileSync(ACP_JSON, 'utf8'));
const configured = acp?.timeContext?.refreshIntervalMs;

check('acp.json 声明了 timeContext.refreshIntervalMs', Number.isSafeInteger(configured), String(configured));
check('间隔是合法的非负安全整数', Number.isSafeInteger(configured) && configured >= 0);
check('间隔被真正调过（不是上游默认 10 分钟）', configured !== UPSTREAM_DEFAULT_MS,
  `${configured}ms = ${(configured ?? 0) / 60000} 分钟`);
check('间隔不为 0（0 = 每个步骤都注入，会把会话刷爆）', configured > 0);

// ── 2. 生成物：每个 time-context 行都带上了值 ────────────────────────────
// 注意：生成文件里含 `!!js` 标签（Loader 表达式），普通 YAML 解析器会直接报错，
// 所以这里按行扫描 —— 与生成器自身的漂移检测口径一致，也不引入额外依赖。
console.log('\n生成物（preset-override.generated.yml）');
const presetText = readFileSync(GENERATED, 'utf8');
const lines = presetText.split('\n');

/** 收集每个 `- id: time-context` 行及其后几行里出现的 refreshIntervalMs。 */
const observed = [];
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].trim() !== '- id: time-context') continue;
  // 向上找最近的 preset 行 id，便于报告
  let preset = '(unknown)';
  for (let j = i; j >= 0; j -= 1) {
    const m = /^- id: (preset-[\w.-]+)$/.exec(lines[j]);
    if (m) { preset = m[1]; break; }
  }
  // 向下 4 行内找 refreshIntervalMs
  let value;
  for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j += 1) {
    const m = /^\s*refreshIntervalMs:\s*(\d+)\s*$/.exec(lines[j]);
    if (m) { value = Number(m[1]); break; }
    if (lines[j].trim() === '- id:' || /^\s*- id: /.test(lines[j]) === false && /^- id: /.test(lines[j])) break;
  }
  observed.push({ preset, value });
}

check('生成物里确实有 time-context 行', observed.length > 0, `${observed.length} 行`);
check('每个 time-context 行都带 refreshIntervalMs',
  observed.every((row) => row.value !== undefined),
  observed.filter((row) => row.value === undefined).map((row) => row.preset).join(', ') || '全部已带');
check('每个 time-context 行的值都等于配置值',
  observed.every((row) => row.value === configured),
  observed.map((row) => `${row.preset}=${row.value ?? '缺失'}`).join(' '));
check('覆盖了 standard / ptc / cordis 三个 preset',
  ['preset-standard', 'preset-ptc', 'preset-cordis'].every((id) => observed.some((row) => row.preset === id)),
  [...new Set(observed.map((row) => row.preset))].join(', '));
check('minimal preset 不声明 time-context（上游如此，不该被硬塞）',
  !observed.some((row) => row.preset === 'preset-minimal'),
  observed.map((row) => row.preset).join(', '));
check('生成文件的头部注释记录了间隔',
  new RegExp(`time-context 读数间隔: ${configured}ms`).test(presetText));

// ── 3. runtime.json 不被污染 ─────────────────────────────────────────────
console.log('\nruntime.json');
const runtime = JSON.parse(readFileSync(RUNTIME, 'utf8'));
check('runtime.json 里没有 timeContext（生成期输入不该进引擎配置）', runtime.timeContext === undefined);
check('runtime.json 仍保留后端标记', runtime.backend === 'acp', String(runtime.backend));

// ── 4. 生成器仍负责这件事（否则重生成会丢掉覆盖） ───────────────────────
console.log('\n生成器');
const genSrc = readFileSync(GENERATOR, 'utf8');
check('生成器有 applyTimeContextInterval', /function applyTimeContextInterval\(/.test(genSrc));
check('生成器读 acp.json 的 timeContext.refreshIntervalMs', /timeContext\?\.refreshIntervalMs/.test(genSrc));
check('生成器会把 timeContext 从 runtime 里剥掉', /timeContext: _timeContext/.test(genSrc));

// ── 结论 ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
