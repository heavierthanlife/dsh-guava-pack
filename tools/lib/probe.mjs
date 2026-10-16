/**
 * probe.mjs — 真的去调一下，判断某个模型**当前能不能用**。
 *
 * ## 为什么必须有这个
 *
 * 「端点列出了它」≠「它能用」。实测（2026-10-16）同一份 `/models` 列表里：
 *
 *   · `inclusionai/ling-3.0-flash-sante:free` → `No endpoints found`（死配置）
 *   · `inclusionai/ling-3.1-flash:free`       → `tier has been retired`（已下线转付费）
 *   · `poolside/laguna-s-2.1-free`            → `at capacity`（当前不可用）
 *   · `stealth/glyph-cluster:free`            → 200 ✅ 真能用
 *   · opencode(zen) 全部免费                  → 403 `仅限 OpenCode app 内使用`
 *   · opencode-go 全部免费                    → 403 `需要订阅`
 *
 * **最坑的一点**：有几个是 **HTTP 200 但 body 里是错误**（commandcode 的桥接恒返回
 * SSE，容量不足时也是 200 + `data: {"error":...}`）。所以只看状态码会误判成"可用"。
 * 必须解 body。
 *
 * 因此"只要能用的免费模型"这条需求，**只能靠真调**，不能靠 id 猜测或状态码。
 *
 * ## 代价与缓存
 *
 * 每个模型一次 `max_tokens: 1` 的请求 —— 花费极小但要时间（16 个模型 ~30s）。
 * 所以结果缓存到 `config/.model-probe.json`，由 `--probe` 刷新；cron 每天跑一次时
 * 顺手刷新。**缓存过期时宁可放宽（当作都能用），也不静默丢掉能用模型。**
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 探测结果分类。`usable` 是唯一"能用"的。 */
export const KIND = {
  USABLE: 'usable',        // 真能调通
  NO_ACCESS: 'no-access',  // 403：需要订阅 / 只允许官方客户端
  REGION: 'region',        // 地区封锁
  DEAD: 'dead',            // 端点不存在 / 已下线
  CAPACITY: 'capacity',    // 上游满载（临时）
  NO_FUNDS: 'no-funds',    // 账户余额不足
  AUTH: 'auth',            // 401：key 无效
  UNKNOWN: 'unknown',
};

const KIND_LABEL = {
  usable: '✅ 可用',
  'no-access': '🚫 需订阅/限官方客户端',
  region: '🚫 地区封锁',
  dead: '❌ 已下线/无端点',
  capacity: '⚠️ 上游满载',
  'no-funds': '💰 余额不足',
  auth: '🔑 key 无效',
  unknown: '❓ 未分类',
};

export const kindLabel = (k) => KIND_LABEL[k] ?? k;

/**
 * 把响应体（可能是 SSE 多行 `data: {...}`，也可能是普通 JSON）里的错误信息挖出来。
 *
 * commandcode 的桥接**恒返回 SSE**，所以正常响应也长这样：
 *   data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}
 * 而失败时是：
 *   data: {"error":{"message":"...at capacity..."}}
 * 只看 HTTP 状态会把后者当成成功。
 */
function extractMessage(text) {
  // 优先找 error 字段
  const candidates = [];
  for (const line of text.split('\n')) {
    const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!raw || raw === '[DONE]') continue;
    try { candidates.push(JSON.parse(raw)); } catch { /* 非 JSON 行忽略 */ }
  }
  if (candidates.length === 0) {
    try { candidates.push(JSON.parse(text)); } catch { /* ignore */ }
  }
  for (const c of candidates) {
    const msg = c?.error?.message ?? c?.error?.type ?? c?.message;
    if (typeof msg === 'string') return { isError: true, message: msg, type: c?.error?.type };
  }
  // 没有 error 字段 → 看是不是正常的 chat completion
  for (const c of candidates) {
    if (c && (c.object === 'chat.completion' || c.object === 'chat.completion.chunk' || Array.isArray(c.choices))) {
      return { isError: false, message: '', type: undefined };
    }
  }
  return { isError: undefined, message: text.slice(0, 200), type: undefined };
}

/**
 * 按文本特征归类。**顺序有讲究**：先判最具体的，再退到通用。
 */
function classify(status, message, type) {
  const m = String(message || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  if (status === 200 && !m) return KIND.USABLE;
  if (/no endpoints found/.test(m)) return KIND.DEAD;
  if (/has been retired|now a paid model|no longer (available|supported)/.test(m)) return KIND.DEAD;
  if (/not found|does not exist|unknown model|invalid model|not recognized|is unavailable|unavailable/.test(m)) return KIND.DEAD;
  if (/region|not available in your country/.test(m) || /regionerror/.test(t)) return KIND.REGION;
  if (/free tier can only be used|subscription is required|requires? (an )?active|upgrade to/.test(m)) return KIND.NO_ACCESS;
  if (/capacity|rate limit|too many requests|overloaded/.test(m)) return KIND.CAPACITY;
  if (/insufficient|funds|quota|billing|credit/.test(m)) return KIND.NO_FUNDS;
  if (status === 401) return KIND.AUTH;
  if (status === 403) return KIND.NO_ACCESS;
  if (status === 404) return KIND.DEAD;
  if (status === 429) return KIND.CAPACITY;
  if (status === 200) return KIND.USABLE;   // 200 且没抓到明确错误 → 当作可用
  return KIND.UNKNOWN;
}

/** 拼调用路径：openai 系 base 一般已含 /v1，anthropic 系要自己补 /v1/messages。 */
function callUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, '');
  if (api === 'anthropic-messages') return `${base}/v1/messages`;
  return `${base}/chat/completions`;
}

/**
 * 探测一个模型。
 *
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} opts.api
 * @param {string} [opts.apiKey]
 * @param {string} opts.model
 * @param {string} [opts.provider] - 用于决定要不要补 `x-opencode-session`
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{kind:string,status:number,message:string,ms:number}>}
 */
export async function probeModel({ baseURL, api, apiKey, model, provider, timeoutMs = 25000 }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  if (api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  // opencode 的反代要求这个头才能"高效路由"（本机由 dsh-opencode-session-header 插件注入）。
  // 探测时补一个随机值，否则会拿到 MissingSessionID 而不是真实的可用性。
  if (provider && /opencode/.test(provider)) {
    headers['x-opencode-session'] = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  }
  const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };

  const started = Date.now();
  let status = 0;
  let text = '';
  try {
    const res = await fetch(callUrl(baseURL, api), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    return { kind: KIND.UNKNOWN, status: 0, message: `请求失败: ${err.message}`, ms: Date.now() - started };
  }

  const { isError, message, type } = extractMessage(text);
  if (!isError && status === 200) return { kind: KIND.USABLE, status, message: '', ms: Date.now() - started };
  const kind = classify(status, message, type);
  return { kind, status, message: String(message).slice(0, 160), ms: Date.now() - started };
}

// ── 缓存 ────────────────────────────────────────────────────────────────────

/** 缓存默认 36 小时 —— 比 cron 的 24h 周期长一点，容忍偶尔跳过一天。 */
export const CACHE_TTL_MS = Number(process.env.PROBE_CACHE_TTL_MS || 36 * 3600 * 1000);

export function cachePath(packDir) {
  return join(packDir, 'config', '.model-probe.json');
}

export function loadCache(packDir) {
  const file = cachePath(packDir);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const age = Date.now() - Date.parse(data.at ?? 0);
    return { ...data, ageMs: age, fresh: Number.isFinite(age) && age < CACHE_TTL_MS, file };
  } catch {
    return null;
  }
}

export function saveCache(packDir, results) {
  const file = cachePath(packDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n', 'utf8');
  return file;
}

/** 判断某个模型在缓存里是否被判为可用；缓存缺失/过期 → 返回 `undefined`（未知）。 */
export function cachedKind(cache, provider, model) {
  if (!cache?.fresh) return undefined;
  return cache.results?.[provider]?.[model]?.kind;
}

/**
 * 并发探测一批模型（默认 4 并发 —— 再高容易被上游当风控）。
 */
export async function probeMany(items, { concurrency = 4, onResult } = {}) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const it = items[idx];
      const r = await probeModel(it);
      out[idx] = r;
      onResult?.(it, r);
    }
  });
  await Promise.all(workers);
  return out;
}
