#!/usr/bin/env node
/**
 * sync-models.mjs — 让 DSH 的模型列表跟上服务商端。
 *
 * ## 为什么需要它
 *
 * DSH 的可选模型来自 profile 里**静态声明**的 `models:` 数组
 * （`dsh-llm-pi-ai` 的 `listModels()` 读的是编译后的配置，不查端点）。
 * 而各家 `/models` 是随时变的：commandcode 的免费模型换了一茬、
 * antigravity 反代已经提供 29 个而配置里只声明了 10 个、还有 3 个已下线。
 *
 * 两个松绑让「同步」成为可行方案：
 *   1. `llm` 服务文档明确：**Catalog membership does not constrain core routing**
 *      ——没列出的 id 照样能调用，列表只影响 UI 里选不选得到。
 *   2. profile 的用户 patch 层是**热重载**的（dsh-app-boot:486
 *      "The user patch layer inside a profile directory (hot-reloaded on
 *      long-lived surfaces)"）——改完配置**不用重启 DSH**。
 *
 * ## 设计要点
 *
 * - **合并，不是替换**：已存在的模型保留它原来的整段 YAML（人工写的
 *   contextWindow / maxTokens / reasoningEfforts / compat 都不丢），
 *   只新增端点有而配置没有的。
 * - **默认绝不删模型**：这点是实测逼出来的。antigravity 反代上
 *   `gemini-2.5-flash` 已不在 /models 里，但调用它**仍然成功**，服务端
 *   静默别名到 `gemini-3.1-flash-lite`；`claude-opus-4-6` → `-thinking`
 *   同理。说明「端点没列」≠「不能用」。所以要删得显式加 `--prune`。
 * - **只动 `models:` 块**：纯文本手术，不重排你的文件、不动注释与其它字段。
 * - **默认 dry-run**：不加 `--write` 就只打印 diff，绝不落盘。
 * - 落盘前自动备份（`cordis.patch.yml.bak-modelsync-<时间戳>`）。
 *
 * ## 用法
 *
 *   node tools/sync-models.mjs                    # 预览（默认，不改文件）
 *   node tools/sync-models.mjs --write             # 落盘
 *   node tools/sync-models.mjs --free-only         # 只要 id 含 free 的
 *   node tools/sync-models.mjs --exclude "tts|asr|embed"   # 排除非对话模型
 *   node tools/sync-models.mjs --prune --write     # 顺手删掉端点已无的（慎用）
 *   node tools/sync-models.mjs --only antigravity  # 只同步某一家
 *
 * ## 已知边界（诚实说明）
 *
 * - 端点只告诉「有哪些模型」，**不告诉**「免费额度还剩多少 / 每日上限」——
 *   那些在服务商条款里，同步器只能按 id 里的 `free` 标记判断是否免费。
 * - **端点列表 ≠ 可用列表**：旧 id 可能被服务端别名到新模型而继续可用
 *   （见上），所以默认不删。
 * - 「自动升级到新模型」这种事同步器查不到。实测 antigravity 的
 *   `gemini-3.5-flash` 直接返回 "Gemini 3.5 Flash is no longer…"，
 *   **并没有**自动连到 3.8 —— 官方说法和实际行为不一致，以实测为准。
 * - 新模型没有 endpoint 元数据时**按 id 家族**给兜底值（`gemini-*` → 1M/65536、
 *   `claude-*` → 200k/64k、`gpt-oss*` → 128k/32k 且纯文本、其余 200k/64k）。
 *   家族表是**启发式**，不是端点事实 —— 需要精确值请手工改，改过之后
 *   下次同步会**保留**你的值。
 * - 有意**不**自动生成 `reasoningEfforts`：它改变请求负载，跨协议容忍度未知；
 *   且档位已写在 id 后缀（`-low`/`-high`/…）的型号本来就不需要选择器。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WRITE = has('--write');
const FREE_ONLY = has('--free-only');
const PRUNE = has('--prune');
const ONLY = valueOf('--only');
const EXCLUDE = valueOf('--exclude') ? new RegExp(valueOf('--exclude')) : undefined;
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
const PROFILE = valueOf('--profile') || join(DSH_HOME, 'profiles', 'web');
const PATCH = join(PROFILE, 'cordis.patch.yml');
const TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS || 20000);

// ── 小工具 ───────────────────────────────────────────────────────────────

const ok = (m) => console.log(`  \u2705 ${m}`);
const bad = (m) => console.log(`  \u274c ${m}`);
const info = (m) => console.log(`  \u2139\ufe0f  ${m}`);

/** 从 ~/.bashrc 取 `export NAME=value`（本机密钥放在那里）。 */
function envFromBashrc(name) {
  if (process.env[name]) return process.env[name];
  try {
    const rc = readFileSync(join(process.env.HOME || '', '.bashrc'), 'utf8');
    const m = rc.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
    if (m) return m[1];
  } catch {}
  return undefined;
}

/**
 * 人类可读名：`gemini-3.5-flash-low` → `Gemini 3.5 Flash Low`。
 *
 * 两条规则踩过坑才写成这样：
 *   - **别把短词全大写**：早先「长度 ≤ 3 就大写」会把 `-low` 变成 `LOW`、
 *     `pro` 变成 `PRO`，而手工条目的风格是 `Gemini 2.5 Flash Lite`。
 *     只有真缩写才大写（ACRONYMS）。
 *   - **连续数字合成版本号**：`claude-opus-4-6` 应为 `Claude Opus 4.6`，
 *     不是 `Claude Opus 4 6`。
 */
const ACRONYMS = new Set(['gpt', 'oss', 'ai', 'api', 'llm', 'tts', 'asr', 'vl', 'ui', 'xl', 'xxl']);

function humanize(id) {
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const trailing = /[-:]free$/.test(bare) ? ' (free)' : '';
  const core = bare.replace(/[-:]free$/, '');
  const words = core
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => {
      if (ACRONYMS.has(w)) return w.toUpperCase();
      if (/^[0-9]+(\.[0-9]+)*[a-z]?$/.test(w)) return w; // 3.5 / 120b / 4
      return w[0].toUpperCase() + w.slice(1); // low → Low, pro → Pro
    });
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev !== undefined && /^[0-9]+$/.test(w) && /^[0-9]+$/.test(prev)) out[out.length - 1] = `${prev}.${w}`;
    else out.push(w);
  }
  return out.join(' ') + trailing;
}

const isFree = (id) => /(^|[/:-])free($|[-:])|[-:]free$/.test(id) || /\bfree\b/.test(id);

// ── 缩进：从文件里探测，别硬编码 ─────────────────────────────────────────
// 这份 patch 是手工维护的，缩进可能变。按 `providers:` 那行推出整条链：
//   providers: 4 → <name>: 6 → fields 8 → models: 8 → "- id:" 10 → items 12 → list 14
const IND = { providers: 4, name: 6, field: 8, models: 8, model: 10, item: 12, list: 14 };

function detectIndent(lines) {
  const line = lines.find((l) => /^\s*providers:\s*$/.test(l));
  if (!line) return;
  const base = line.match(/^(\s*)/)[1].length;
  IND.providers = base;
  IND.name = base + 2;
  IND.field = base + 4;
  IND.models = base + 4;
  IND.model = base + 6;
  IND.item = base + 8;
  IND.list = base + 10;
}

const sp = (n) => ' '.repeat(n);

// ── 解析 profile 的 providers 块 ─────────────────────────────────────────

/**
 * 把 patch 文件按行切开，找出每个 provider 块的范围。
 */
function scanProviders(lines) {
  const found = [];
  let inProviders = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (new RegExp(`^${sp(IND.providers)}providers:\\s*$`).test(line)) { inProviders = true; continue; }
    if (!inProviders) continue;
    const m = line.match(new RegExp(`^${sp(IND.name)}([A-Za-z0-9_.-]+):\\s*$`));
    if (!m) {
      // 离开 providers 段（缩进回到 providers 之前且不是空行/注释）
      if (/^\s{0,}\S/.test(line) && line.trim() !== '' && !line.trimStart().startsWith('#')) {
        const indent = line.match(/^(\s*)/)[1].length;
        if (indent <= IND.providers) inProviders = false;
      }
      continue;
    }
    const name = m[1];
    let end = i + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() === '' || new RegExp(`^\\s{${IND.name + 1},}`).test(l)) { end++; continue; }
      break;
    }
    found.push({ name, start: i, end, body: lines.slice(i, end) });
  }
  return found;
}

/** 从 provider 块里取一个标量字段。 */
function field(body, key) {
  const re = new RegExp(`^\\s{${IND.field}}${key}:\\s*(.+?)\\s*$`);
  for (const l of body) { const m = l.match(re); if (m) return m[1].replace(/^["']|["']$/g, ''); }
  return undefined;
}

/**
 * 拆出 models 块并保留每个模型的**原始文本**（这样人工元数据一字不动）。
 */
function parseModels(body) {
  const modelsRe = new RegExp(`^\\s{${IND.models}}models:\\s*$`);
  const headerIdx = body.findIndex((l) => modelsRe.test(l));
  if (headerIdx === -1) return { headerIdx: -1, models: [] };
  const idRe = new RegExp(`^\\s{${IND.model}}- id:\\s*(.+?)\\s*$`);
  const models = [];
  let cur = null;
  for (let i = headerIdx + 1; i < body.length; i++) {
    const m = body[i].match(idRe);
    if (m) {
      if (cur) models.push(cur);
      cur = { id: m[1].replace(/^["']|["']$/g, ''), lines: [body[i]] };
      continue;
    }
    if (cur) cur.lines.push(body[i]);
  }
  if (cur) models.push(cur);
  return { headerIdx, models };
}

/** 端点路径：openai 系的 baseURL 一般已含 /v1，anthropic 系要自己补。 */
function modelsUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, '');
  if (api === 'anthropic-messages') return `${base}/v1/models`;
  return `${base}/models`;
}

async function fetchModels(url, apiKey, api) {
  const headers = { accept: 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  if (api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = json?.data ?? json?.models ?? (Array.isArray(json) ? json : []);
  return items
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : undefined,
      contextWindow: Number(m.context_length ?? m.contextWindow ?? 0) || undefined,
      maxTokens: Number(m.max_output_tokens ?? m.maxTokens ?? 0) || undefined,
    }));
}

// ── 新模型的元数据兜底：按 id 家族给 ────────────────────────────────────
// 实测：antigravity 的 /v1/models 只回 `{id, object, created, owned_by}` ——
// **一点 context/token 信息都没有**。全用同一个默认值会把 1M 的 Gemini
// 写成 200000，与同家族手工写的条目自相矛盾（UI 上的上下文提示会错）。
// 所以按 id 前缀家族给值。**这只是兜底**：一旦某条被手工改过，
// 之后每次同步都保留手工值（见 parseModels 的「保留原始文本」设计）。
const FAMILIES = [
  { test: /^gpt-oss/, contextWindow: 131072, maxTokens: 32768, input: ['text'] },
  { test: /^gemini-/, contextWindow: 1000000, maxTokens: 65536, input: ['text', 'image'] },
  { test: /^claude-/, contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] },
  { test: /^gpt-/, contextWindow: 200000, maxTokens: 64000, input: ['text'] },
];
const DEFAULT_FAMILY = { contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] };

function familyOf(id) {
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return FAMILIES.find((f) => f.test.test(bare)) || DEFAULT_FAMILY;
}

/**
 * 为一个新模型生成 YAML 行，缩进跟随探测结果。
 *
 * 有意**不**生成 `reasoningEfforts`：它会改变请求负载，而各供应商/协议
 * 对它的容忍度未知（对比 agentrouter 的 schema 400 一役）。档位已写在
 * id 后缀里的型号（`-low` / `-high` / `-tiered` …）本来也不需要选择器。
 * 想要就手工加，手工值以后都会被保留。
 */
function renderModel(m) {
  const fam = familyOf(m.id);
  const ctx = m.contextWindow || fam.contextWindow;
  const max = m.maxTokens || fam.maxTokens;
  const i0 = sp(IND.model);
  const i1 = sp(IND.item);
  const i2 = sp(IND.list);
  return [
    `${i0}- id: ${m.id}`,
    `${i1}name: ${m.name || humanize(m.id)}`,
    `${i1}contextWindow: ${ctx}`,
    `${i1}maxTokens: ${max}`,
    `${i1}input:`,
    ...fam.input.map((t) => `${i2}- ${t}`),
  ];
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function main() {
  console.log('sync-models — 让 DSH 模型列表跟上服务商端');
  console.log(`  profile : ${PROFILE}`);
  console.log(`  模式    : ${WRITE ? '写入' : '预览（dry-run，加 --write 才落盘）'}${FREE_ONLY ? ' + 仅免费' : ''}${PRUNE ? ' + 删除端点已无的' : ' + 不删除'}${EXCLUDE ? ` + 排除 /${EXCLUDE.source}/` : ''}${ONLY ? ` + 只同步 ${ONLY}` : ''}`);
  console.log();

  if (!existsSync(PATCH)) { bad(`找不到 ${PATCH}`); process.exit(1); }

  const original = readFileSync(PATCH, 'utf8');
  const lines = original.split('\n');
  detectIndent(lines);
  const providers = scanProviders(lines);
  if (providers.length === 0) { bad('没在 patch 里找到 providers 块'); process.exit(1); }
  info(`探测到缩进：providers=${IND.providers} 名称=${IND.name} 字段=${IND.field} 模型=${IND.model}`);

  // 从后往前替换，避免下标漂移
  const edits = [];
  let failures = 0;
  let changedProviders = 0;

  for (const p of providers) {
    if (ONLY && p.name !== ONLY) continue;
    const api = field(p.body, 'api');
    const baseURL = field(p.body, 'baseURL');
    const apiKeyEnv = field(p.body, 'apiKeyEnv');
    const { headerIdx, models: existing } = parseModels(p.body);

    if (!baseURL) { info(`${p.name}: 没声明 baseURL（走 pi-ai 内置目录），跳过`); continue; }
    if (headerIdx === -1) { info(`${p.name}: 没声明 models，跳过`); continue; }

    const url = modelsUrl(baseURL, api);
    let remote;
    try {
      remote = await fetchModels(url, apiKeyEnv ? envFromBashrc(apiKeyEnv) : undefined, api);
    } catch (err) {
      bad(`${p.name}: 查询 ${url} 失败 —— ${err.message}`);
      failures++;
      continue;
    }
    if (remote.length === 0) { info(`${p.name}: 端点没返回模型，跳过`); continue; }

    let candidates = remote;
    if (EXCLUDE) candidates = candidates.filter((m) => !EXCLUDE.test(m.id));
    if (FREE_ONLY) {
      const free = candidates.filter((m) => isFree(m.id));
      // --free-only 的语义是「只碰有免费模型的供应商」：没有就整家跳过，
      // 而不是退回全量 —— 否则会把一堆付费/非对话模型塞进列表，违背意图。
      if (free.length === 0) { info(`${p.name}: 无免费模型，跳过（--free-only）`); continue; }
      candidates = free;
    }

    const existingById = new Map(existing.map((m) => [m.id, m]));
    const candidateIds = new Set(candidates.map((m) => m.id));
    const added = candidates.filter((m) => !existingById.has(m.id));
    // 端点已不再列出 —— 但**不等于不能用**（可能被服务端别名，见文件头说明）
    const missing = existing.filter((m) => !candidateIds.has(m.id));

    const freeCount = candidates.filter((m) => isFree(m.id)).length;
    console.log(`  ${p.name}  (${api || 'api?'})  →  ${url}`);
    console.log(`    端点 ${remote.length} 个${freeCount ? `（筛后 ${candidates.length}，其中 ${freeCount} 个免费）` : ''} | 配置原有 ${existing.length} 个`);
    if (added.length) { console.log(`    + 新增 ${added.length}:`); for (const m of added) console.log(`        ${isFree(m.id) ? '🆓' : '  '} ${m.id}`); }
    if (missing.length) {
      console.log(`    ~ 端点已不列出 ${missing.length}${PRUNE ? '（将移除）' : '（**保留**，可能仍是有效别名）'}:`);
      for (const m of missing) console.log(`        ${m.id}`);
    }
    if (!added.length && !(PRUNE && missing.length)) console.log('    = 无需变更');

    if (!added.length && !(PRUNE && missing.length)) continue;

    // 保留原有顺序（UI 里不跳位），新模型追加在后
    const keptExisting = existing.filter((m) => !PRUNE || candidateIds.has(m.id));
    const newOnes = candidates.filter((m) => !existingById.has(m.id));
    const newModelLines = [
      ...keptExisting.flatMap((m) => m.lines),
      ...newOnes.flatMap((m) => renderModel(m)),
    ];
    const before = p.body.slice(0, headerIdx + 1);
    edits.push({ start: p.start, end: p.end, lines: [...before, ...newModelLines] });
    changedProviders++;
  }

  console.log();
  if (changedProviders === 0) {
    ok('没有任何变化，文件不用动');
    return;
  }
  if (failures) info(`${failures} 家查询失败，已跳过（不会误删它们的模型）`);

  if (!WRITE) {
    info(`预览结束：${changedProviders} 家需要更新。加 --write 落盘。`);
    return;
  }

  // 从后往前替换
  const out = lines.slice();
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out.splice(e.start, e.end - e.start, ...e.lines);
  }
  const backup = `${PATCH}.bak-modelsync-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  copyFileSync(PATCH, backup);
  writeFileSync(PATCH, out.join('\n'), 'utf8');
  ok(`已写入 ${changedProviders} 家`);
  ok(`备份：${backup}`);
  info('profile patch 是热重载的 —— 刷新页面即可看到新列表，通常不用重启 DSH');
  info('若没生效再重启：systemctl --user restart dsh.service');
}

main().catch((err) => { bad(err.stack || String(err)); process.exit(1); });
