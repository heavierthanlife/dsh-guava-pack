/**
 * model-config.mjs — `cordis.patch.yml` 里 `providers:` 块的**文本手术**工具。
 *
 * ## 为什么是文本手术，不是 YAML 解析
 *
 * 这份 patch 是**手工维护**的：里面有大量注释、字段顺序、以及人写的
 * `contextWindow` / `reasoningEfforts` / `compat`（这些值来自实测，端点上拿不到）。
 * 用 `js-yaml` 解析再 dump 会把注释全丢掉、还会重排字段 —— 那是不可接受的破坏。
 * 所以统一走"按行定位 + 只替换 models 子块"的路线，**逐字节保留其它一切**。
 *
 * ## 谁在用
 *
 * - `tools/sync-models.mjs` —— 把端点新增的模型补进来（默认不删）
 * - `tools/sync-model-policy.mjs` —— 按 `config/model-policy.yml` 的**策略**算出目标清单
 *
 * 两边的解析/渲染/家族兜底必须完全一致，否则同一个文件会被两个工具写出两种结果。
 * 所以这些函数集中在这里，**不要在各脚本里复制**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 缩进：从文件里探测，别硬编码 ─────────────────────────────────────────
// 这份 patch 是手工维护的，缩进可能变。按 `providers:` 那行推出整条链：
//   providers: 4 → <name>: 6 → fields 8 → models: 8 → "- id:" 10 → items 12 → list 14
export const IND = { providers: 4, name: 6, field: 8, models: 8, model: 10, item: 12, list: 14 };

export function detectIndent(lines) {
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

export const sp = (n) => ' '.repeat(n);

// ── 解析 profile 的 providers 块 ─────────────────────────────────────────

/**
 * 把 patch 文件按行切开，找出每个 provider 块的范围。
 */
export function scanProviders(lines) {
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
export function field(body, key) {
  const re = new RegExp(`^\\s{${IND.field}}${key}:\\s*(.+?)\\s*$`);
  for (const l of body) { const m = l.match(re); if (m) return m[1].replace(/^["']|["']$/g, ''); }
  return undefined;
}

/**
 * 拆出 models 块并保留每个模型的**原始文本**（这样人工元数据一字不动）。
 */
export function parseModels(body) {
  const modelsRe = new RegExp(`^\\s{${IND.models}}models:\\s*$`);
  const headerIdx = body.findIndex((l) => modelsRe.test(l));
  if (headerIdx === -1) return { headerIdx: -1, models: [], tail: [] };
  const idRe = new RegExp(`^\\s{${IND.model}}- id:\\s*(.+?)\\s*$`);
  const models = [];
  let cur = null;
  let tailStart = body.length;
  for (let i = headerIdx + 1; i < body.length; i++) {
    const line = body[i];
    const m = line.match(idRe);
    if (m) {
      if (cur) models.push(cur);
      cur = { id: m[1].replace(/^["']|["']$/g, ''), lines: [line] };
      continue;
    }
    // 非空且缩进比模型项还浅 → `models:` 块已经结束，剩下的属于本 provider 的
    // 其它字段。**这是踩过的坑**：`opencode`（zen）把 `baseURL` 声明在 `models:`
    // **之后**，旧实现会把它当成最后一个模型的行吸走，重排时插到模型列表中间，
    // 产出 `mapping values are not allowed here` 的非法 YAML。
    if (line.trim() !== '' && line.match(/^(\s*)/)[1].length < IND.model) {
      tailStart = i;
      break;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) models.push(cur);
  // 尾随空行属于 tail，不属于最后一个模型
  const tail = body.slice(tailStart);
  while (models.length && models[models.length - 1].lines.length && models[models.length - 1].lines[models[models.length - 1].lines.length - 1].trim() === '') {
    tail.unshift(models[models.length - 1].lines.pop());
  }
  return { headerIdx, models, tail };
}

/** 端点路径：openai 系的 baseURL 一般已含 /v1，anthropic 系要自己补。 */
export function modelsUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, '');
  if (api === 'anthropic-messages') return `${base}/v1/models`;
  return `${base}/models`;
}

export async function fetchModels(url, apiKey, api, timeoutMs = 20000) {
  const headers = { accept: 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  if (api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = json?.data ?? json?.models ?? (Array.isArray(json) ? json : []);
  return items
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : undefined,
      contextLength: Number(m.context_length ?? m.contextLength ?? 0) || undefined,
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
export const FAMILIES = [
  { test: /^gpt-oss/, contextWindow: 131072, maxTokens: 32768, input: ['text'] },
  { test: /^gemini-/, contextWindow: 1000000, maxTokens: 65536, input: ['text', 'image'] },
  { test: /^claude-/, contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] },
  { test: /^gpt-/, contextWindow: 200000, maxTokens: 64000, input: ['text'] },
];
export const DEFAULT_FAMILY = { contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] };

/** 去掉 `vendor/` 前缀与 `:free` 后缀，拿到"纯 id"用于家族判断。 */
export function bareId(id) {
  const noVendor = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return noVendor.replace(/[-:]free$/, '');
}

export function familyOf(id) {
  const bare = bareId(id);
  return FAMILIES.find((f) => f.test.test(bare)) || DEFAULT_FAMILY;
}

/**
 * 思考强度家族表。
 *
 * ## 为什么只能按家族套
 *
 * **端点上完全拿不到 reasoning effort 信息**（实测 6 家的 `/models` 都只有
 * id/name/created/context，没有能力字段），要发真实请求才知道支持哪些档。
 * 所以规律是从**现有 24 条手工配置**里归纳的：
 *
 *   - deepseek 血统（xiaomi 的 mimo 走 `thinkingFormat: deepseek`、
 *     opencode-go 的 ds、commandcode 的 ds）→ `low/medium/high`；
 *     但 opencode-go / opencode 的 ds 实测支持到 `max` → `low/high/max`。
 *   - antigravity 的 claude → `low/medium/high`（与手工条目一致）。
 *   - antigravity 的 gemini、以及各家免费模型 → 手工条目**多数没给**，
 *     所以默认也不给（宁缺勿错：给错档位会导致请求 400）。
 *
 * 想改哪一条就改这里；**手工写在 profile 里的值永远优先**（见 solve 的保留逻辑）。
 */
export const EFFORT_FAMILIES = [
  // opencode 系（含 opencode-go 的 ds）实测支持 max
  { test: /^(deepseek|ds)-/, provider: /^(opencode|opencode-go)$/, efforts: ['low', 'high', 'max'] },
  { test: /^deepseek/, efforts: ['low', 'medium', 'high'] },
  { test: /^mimo-/, efforts: ['low', 'medium', 'high'] },
  { test: /^claude-/, provider: /^antigravity$/, efforts: ['low', 'medium', 'high'] },
];

/**
 * 给一个模型推导 `reasoningEfforts`。
 *
 * @returns {string[]|null} 档位列表；`null` = 这套家族不该给（宁缺勿错）。
 */
export function effortsFor(providerName, id) {
  const bare = bareId(id);
  for (const f of EFFORT_FAMILIES) {
    if (!f.test.test(bare)) continue;
    if (f.provider && !f.provider.test(providerName)) continue;
    return f.efforts;
  }
  return null;
}

/** 把 efforts 列表渲染成 YAML 行（`low: low` 这种同值映射，与手工条目一致）。 */
export function renderEfforts(efforts, itemIndent) {
  if (!efforts || efforts.length === 0) return [];
  // `itemIndent` 是**模型字段那一层的绝对缩进**（`- id:` 的缩进 + 2）。
  // 踩过的坑：这里曾写成 `sp(itemIndent)` 而把已经算好的空格串再 repeat 一次，
  // 得到空串 → `reasoningEfforts:` 落在第 0 列 → 直接终止 models 块，
  // 后面的模型全被吞进 tail（解析出的模型数变少，且产出非法 YAML）。
  return [`${sp(itemIndent)}reasoningEfforts:`, ...efforts.map((e) => `${sp(itemIndent + 2)}${e}: ${e}`)];
}

// ── 人类可读名 ───────────────────────────────────────────────────────────

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
export const ACRONYMS = new Set(['gpt', 'oss', 'ai', 'api', 'llm', 'tts', 'asr', 'vl', 'ui', 'xl', 'xxl']);

export function humanize(id) {
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

/** 判断某个 id 是不是免费模型（`-free` / `:free` / `free-` 三种写法都算）。 */
export function isFree(id) {
  return /(^|[/:-])free($|[-:])|[-:]free$/.test(id) || /\bfree\b/.test(id);
}

/**
 * 为一个新模型生成 YAML 行，缩进跟随探测结果。
 *
 * `reasoningEfforts` 默认**不**生成（见 EFFORT_FAMILIES 的说明）；传
 * `efforts` 才生成。手工加过的值以后都会被保留。
 */
export function renderModel(m, { efforts = null } = {}) {
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
    ...renderEfforts(efforts, IND.item),
  ];
}

/** 从 ~/.bashrc 取 `export NAME=value`（本机密钥放在那里）。 */
export function envFromBashrc(name) {
  if (process.env[name]) return process.env[name];
  try {
    const rc = readFileSync(join(process.env.HOME || '', '.bashrc'), 'utf8');
    const m = rc.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
    if (m) return m[1];
  } catch {}
  return undefined;
}

/**
 * 从 profile patch 里找出所有**被别处引用**的 `provider::model`。
 *
 * ## 为什么必须有这个
 *
 * 删模型会**静默打断**引用它的地方：
 *   - `agent-default-model` —— 主 agent 的默认模型（本机现在指着一个**免费模型**
 *     `commandcode::stealth/glyph-cluster:free`，扫描器很容易把它当"不要的"删掉，
 *     然后主 agent 就没有可用默认模型）
 *   - `subagent-model-selection-settings.allowedModels` —— 子代理允许的路由，
 *     删掉会让那些路由报 `is not allowed for this Session`
 *
 * 所以任何"目标清单"在落盘前都要过这道检查：**被引用的模型一律保留**。
 *
 * @param {object} doc - js-yaml 解析后的 patch 数组
 * @param {string} piAiId - llm-pi-ai 条目的 id（跳过它自己，避免把定义当引用）
 * @returns {Map<string,string[]>} `provider::model` → 引用它的条目 id 列表
 */
export function collectModelRefs(doc, piAiId = 'llm-pi-ai') {
  const refs = new Map();
  const add = (provider, model, by) => {
    if (typeof provider !== 'string' || typeof model !== 'string') return;
    const key = `${provider}::${model}`;
    if (!refs.has(key)) refs.set(key, []);
    if (!refs.get(key).includes(by)) refs.get(key).push(by);
  };
  for (const entry of Array.isArray(doc) ? doc : []) {
    if (!entry || entry.id === piAiId) continue;
    const cfg = entry.config;
    if (!cfg || typeof cfg !== 'object') continue;
    // 形态 1：{ provider, model }
    add(cfg.provider, cfg.model, entry.id);
    // 形态 2：allowedModels: [{ provider, model }, …]
    if (Array.isArray(cfg.allowedModels)) {
      for (const r of cfg.allowedModels) add(r?.provider, r?.model, entry.id);
    }
  }
  return refs;
}
