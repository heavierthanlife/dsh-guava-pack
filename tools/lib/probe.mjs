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
  REASONING_ONLY: 'reasoning-only', // 200 但正文为空：推理吃光 token（**探针曾误判为可用**）
  SLOW: 'slow',            // 200 且正文正常，但**慢到不能当主力**（上游限流）
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
  'reasoning-only': '🧠 只出推理不出正文',
  slow: '🐌 能通但极慢（上游限流）',
  unknown: '❓ 未分类',
};

export const kindLabel = (k) => KIND_LABEL[k] ?? k;

/**
 * 慢速阈值：单次探测超过这个毫秒数就算 `slow`（能通但不可用）。
 *
 * 默认 15s —— 对话场景里单轮 >15s 就已经明显卡顿；实测正常模型都在 0.4–3.5s，
 * 而限流中的 gemini-3.8 家族是 50–59s，分界很干净。
 * 可用 `PROBE_SLOW_MS` 覆盖。
 */
export const SLOW_MS = Number(process.env.PROBE_SLOW_MS || 15000);

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

// ── 工具（function calling）能力探测 ──────────────────────────────────────
//
// ## 为什么必须单独探一次
//
// "能聊"和"能挂工具"是两件事，而 DSH 是 **Agent**：每一轮都会把工具清单塞进
// 请求。实测踩过的坑：AgentRouter 的 Anthropic 适配层把 /v1/messages 翻成
// OpenAI /v1/chat/completions，而 `gpt-6.1-sol` 在那个端点上**禁止 Function
// tools**（400 "Function tools with reasoning_effort are not supported"），
// 同一个模型走 /v1/responses 却完全正常。只看纯文本探测会把它判成 ✅ 可用，
// 用户一选就当主模型，每轮必炸。
//
// 所以：纯文本探测通过后，再发一次**带工具的最小请求**，只有真的回了一个
// 工具调用才算支持。判不了（网络/未知错误）记 `unknown`，绝不冤枉模型。

/** 工具探测结果三态。`unknown` 表示"没测出来"，不应据此打标签。 */
export const TOOL = { OK: 'ok', NO: 'no', UNKNOWN: 'unknown' };

const TOOL_LABEL = { ok: '✅ 支持工具', no: '❌ 不支持工具', unknown: '❓ 工具未知' };
export const toolLabel = (t) => TOOL_LABEL[t] ?? t;

/** 探测用工具定义（三协议共用同一份语义，只是包装不同）。 */
export const PROBE_TOOL = {
  name: 'probe_echo',
  description: 'Echo the given text back. Always call this when the user asks you to echo.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The text to echo back.' } },
    required: ['text'],
    additionalProperties: false,
  },
};

const PROBE_TOOL_PROMPT = 'Call the probe_echo tool with text "ping". Do not answer in prose.';

function toolUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, '');
  if (api === 'anthropic-messages') return `${base}/v1/messages`;
  if (api === 'openai-responses') return `${base}/responses`;
  return `${base}/chat/completions`;
}

/** 把三协议的工具定义包装成各自的上游形状。 */
function toolPayload(api) {
  const p = PROBE_TOOL;
  // ⚠️ 不要传 tool_choice：实测 Anthropic 侧一旦开思考模式就报
  //   "Thinking mode does not support this tool_choice"
  // 而真实使用里 DSH 默认也不带 tool_choice。探测必须**贴近真实请求**，
  // 否则会把能用的模型误判成不支持（真踩过）。
  if (api === 'anthropic-messages') {
    return {
      tools: [{ name: p.name, description: p.description, input_schema: p.parameters }],
    };
  }
  if (api === 'openai-responses') {
    return {
      tools: [{ type: 'function', name: p.name, description: p.description, parameters: p.parameters }],
    };
  }
  return {
    tools: [{ type: 'function', function: { name: p.name, description: p.description, parameters: p.parameters } }],
  };
}

/** 解析响应里有没有工具调用；返回 { detected, sawText }。 */
export function detectToolCall(text, api) {
  let detected = false;
  let sawText = false;
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    // openai-completions：非流式 message.tool_calls / 流式 delta.tool_calls
    for (const ch of obj.choices ?? []) {
      const d = ch?.delta ?? ch?.message ?? {};
      if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) detected = true;
      if (typeof d.content === 'string' && d.content.length > 0) sawText = true;
    }
    // anthropic-messages：完整 message 的 tool_use / 流式 content_block_start
    for (const blk of obj.content ?? []) {
      if (blk?.type === 'tool_use') detected = true;
      if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.length > 0) sawText = true;
    }
    if (obj?.type === 'content_block_start' && obj?.content_block?.type === 'tool_use') detected = true;
    if (obj?.type === 'content_block_delta' && typeof obj?.delta?.text === 'string' && obj.delta.text.length > 0) sawText = true;
    // openai-responses：output[] 里的 function_call
    for (const item of obj.output ?? []) {
      if (item?.type === 'function_call' || item?.type === 'custom_tool_call') detected = true;
      if (item?.type === 'message') {
        for (const c of item.content ?? []) {
          if (c?.type === 'output_text' && typeof c.text === 'string' && c.text.length > 0) sawText = true;
        }
      }
    }
  };
  for (const line of text.split('\n')) {
    const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!raw || raw === '[DONE]') continue;
    try { visit(JSON.parse(raw)); } catch { /* 非 JSON 行忽略 */ }
  }
  if (!detected) { try { visit(JSON.parse(text)); } catch { /* ignore */ } }
  return { detected, sawText };
}

/**
 * 判断失败是不是"这个模型/这条协议明确不支持工具"。
 * 只认措辞明确的；其余一律 unknown（宁可漏标，不可错标）。
 */
export function classifyToolFailure(status, message) {
  const m = String(message || '').toLowerCase();
  if (/function tools? (with reasoning_effort )?(are|is) not supported/.test(m)) return TOOL.NO;
  if (/does not support (tools|function|tool use)/.test(m)) return TOOL.NO;
  if (/tools? (are|is) not supported/.test(m)) return TOOL.NO;
  if (/tool use is not supported/.test(m)) return TOOL.NO;
  if (/use \/v1\/responses instead/.test(m)) return TOOL.NO;
  if (/invalid.*(tools|tool_choice)/.test(m)) return TOOL.NO;
  if (/unsupported.*(tools|tool_choice)/.test(m)) return TOOL.NO;
  if (status === 400 && /tool/.test(m)) return TOOL.NO;
  return TOOL.UNKNOWN;
}

/**
 * 探测一个模型**能不能挂工具**。
 *
 * 返回 `{ tools: 'ok'|'no'|'unknown', status, message, ms }`。
 * - `ok`：真的回了一个工具调用（不是"文本里提到工具"）。
 * - `no`：上游明确说这条协议不支持工具。
 * - `unknown`：网络/未知错误/既没工具也没正文 —— 不下结论。
 */
export async function probeToolUse({ baseURL, api, apiKey, model, provider, timeoutMs = SLOW_MS + 10000 }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  if (api === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  if (provider && /opencode/.test(provider)) {
    headers['x-opencode-session'] = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  }
  // 推理模型会先花思考 token，给太小会"只思考不调工具" → 误判成不支持。
  //
  // 两种协议的请求体**结构不同**（真踩过）：
  //   openai-completions / anthropic-messages → { messages: […] }
  //   openai-responses                        → { input: … }（传 messages 会 500 "input is required"）
  const body = api === 'openai-responses'
    ? {
        model,
        input: PROBE_TOOL_PROMPT,
        max_output_tokens: 512,
        store: false,
        ...toolPayload(api),
      }
    : {
        model,
        max_tokens: api === 'anthropic-messages' ? 1024 : 512,
        messages: [{ role: 'user', content: PROBE_TOOL_PROMPT }],
        ...toolPayload(api),
      };

  const started = Date.now();
  let status = 0;
  let text = '';
  try {
    const res = await fetch(toolUrl(baseURL, api), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const msg = String(err?.message ?? err);
    return { tools: TOOL.UNKNOWN, status: 0, message: `请求失败: ${msg.slice(0, 120)}`, ms: Date.now() - started };
  }

  const { isError, message } = extractMessage(text);
  const ms = Date.now() - started;
  if (isError) {
    return { tools: classifyToolFailure(status, message), status, message: String(message).slice(0, 160), ms };
  }
  const { detected } = detectToolCall(text, api);
  if (detected) return { tools: TOOL.OK, status, message: '', ms };
  // 没有错误、也没有工具调用：可能是模型"没听话"而不是不支持 → 不下结论。
  return { tools: TOOL.UNKNOWN, status, message: '响应里没有工具调用（模型未使用工具，不能据此判断不支持）', ms };
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
export async function probeModel({ baseURL, api, apiKey, model, provider, timeoutMs = SLOW_MS + 10000 }) {
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
  // max_tokens 不能是 1：推理型模型（glyph-cluster / cat-jam）会先把额度花在
  // 内部推理上，给 1 个 token 的话**所有**这种模型都会"正文为空"，
  // 那是探测伪影、不是模型的问题。给 64 足以让正常模型回一句话。
  const body = { model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] };

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
    const ms = Date.now() - started;
    const msg = String(err?.message ?? err);
    // **超时 = 太慢 = 不能用**。实测限流中的 gemini-3.8 家族会一直挂到超时；
    // 如果归成 `unknown`，调用方会以为"没测出来"从而放宽保留，等于漏判。
    const timedOut = /aborted|timeout|timed out/i.test(msg) && /timeout|aborted/i.test(msg);
    return {
      kind: timedOut ? KIND.SLOW : KIND.UNKNOWN,
      status: 0,
      message: timedOut ? `超过 ${(timeoutMs / 1000).toFixed(0)}s 未响应（太慢，疑似上游限流）` : `请求失败: ${msg}`,
      ms,
    };
  }

  const elapsedMs = Date.now() - started;
  const { isError, message, type } = extractMessage(text);
  if (!isError && status === 200) {
    // ⚠️ **HTTP 200 不等于它能干活。**
    //
    // 实测（2026-10-16）`stealth/glyph-cluster:free` 返回 200，但
    // `completion_tokens_details.reasoning_tokens` 吃掉了全部额度、
    // 正文 **0 字符**、`finish_reason: "length"`。DSH 里跑起来就是
    // `The stealth model could not complete the request. PI_AI_ERROR`。
    //
    // 所以判"可用"必须看**有没有真的产出正文**，不能只看状态码。
    // 用 `max_tokens` 稍大 + 检查 content/reasoning 的比例来区分。
    const stats = analyzeBody(text);
    if (stats.hasError) {
      return { kind: classify(status, stats.message, stats.type), status, message: stats.message.slice(0, 160), ms: Date.now() - started };
    }
    if (stats.reasoningTokens > 0 && stats.contentChars === 0) {
      return {
        kind: KIND.REASONING_ONLY,
        status,
        message: `推理吃光 token（reasoning_tokens=${stats.reasoningTokens}，正文 0 字符）`,
        ms: Date.now() - started,
        reasoningTokens: stats.reasoningTokens,
        contentChars: 0,
      };
    }
    // ⚠️ **"能通"不等于"能用"**。实测 2026-10-20：`gemini-3.8-flash-tiered` 正常返回 200
    // 且正文正常，但**每次要 50–59 秒**（上游 `MODEL_CAPACITY_EXHAUSTED` 限流）。
    // 这种模型当默认模型会让每轮对话都卡将近一分钟，用户看到的就是"运行失败/超时"。
    // 所以设一个慢速阈值：超过就判 `slow`，不再算 `usable`。
    if (elapsedMs > SLOW_MS) {
      return {
        kind: KIND.SLOW,
        status,
        message: `能通但用了 ${(elapsedMs / 1000).toFixed(1)}s（阈值 ${(SLOW_MS / 1000).toFixed(0)}s，疑似上游限流）`,
        ms: elapsedMs,
        contentChars: stats.contentChars,
      };
    }
    return { kind: KIND.USABLE, status, message: '', ms: elapsedMs, contentChars: stats.contentChars };
  }
  const kind = classify(status, message, type);
  return { kind, status, message: String(message).slice(0, 160), ms: Date.now() - started };
}

/**
 * 分析响应体：有没有错误、正文产出多少、推理花掉多少 token。
 *
 * 之所以要这么细：commandcode 的桥接**恒返回 SSE**，而且 200 也可能是"空产出"。
 */
function analyzeBody(text) {
  let contentChars = 0;
  let reasoningTokens = 0;
  let hasContent = false;
  let finish = null;
  for (const line of text.split('\n')) {
    const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!raw || raw === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    if (obj?.error) {
      return { hasError: true, message: String(obj.error.message ?? obj.error.type ?? ''), type: obj.error.type, contentChars: 0, reasoningTokens: 0 };
    }
    // ── OpenAI 系（pi-ai 的 openai-completions）──
    for (const ch of obj?.choices ?? []) {
      const d = ch?.delta ?? ch?.message;
      if (typeof d?.content === 'string' && d.content.length > 0) { contentChars += d.content.length; hasContent = true; }
      if (ch?.finish_reason) finish = ch.finish_reason;
    }
    // ── Anthropic 系（antigravity / agentrouter 用 anthropic-messages）──
    // 格式完全不同：**不是 SSE 的 delta.content，而是一整个 message 对象**，
    // 正文在 `content: [{type:"text", text:"…"}]`。
    // 踩过：只认 OpenAI 格式时，antigravity 的正文数恒为 0 →
    // 好模型被误判成"只出推理不出正文"。
    if (obj?.type === 'message' && Array.isArray(obj.content)) {
      for (const blk of obj.content) {
        if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.length > 0) {
          contentChars += blk.text.length;
          hasContent = true;
        }
      }
      if (obj.stop_reason) finish = obj.stop_reason;
    }
    if (obj?.type === 'content_block_delta' && typeof obj?.delta?.text === 'string') {
      contentChars += obj.delta.text.length;
      if (obj.delta.text.length > 0) hasContent = true;
    }
    // 推理 token：OpenAI 在 usage.completion_tokens_details，Anthropic 的 thinking 另算
    const rt = obj?.usage?.completion_tokens_details?.reasoning_tokens
      ?? obj?.usage?.output_tokens_details?.reasoning_tokens;
    if (typeof rt === 'number') reasoningTokens = Math.max(reasoningTokens, rt);
    // Anthropic 的 thinking 块也算"推理吃掉的量"
    if (Array.isArray(obj?.content)) {
      for (const blk of obj.content) {
        if (blk?.type === 'thinking' && typeof blk.thinking === 'string') {
          reasoningTokens = Math.max(reasoningTokens, Math.ceil(blk.thinking.length / 4));
        }
      }
    }
  }
  return { hasError: false, message: '', type: undefined, contentChars, hasContent, reasoningTokens, finish };
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

/** 读缓存里的工具能力：`'ok' | 'no' | 'unknown'`；没探过返回 `undefined`。 */
export function cachedTools(cache, provider, model) {
  if (!cache?.fresh) return undefined;
  return cache.results?.[provider]?.[model]?.tools;
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

/** 并发探测一批模型的**工具能力**（同一套并发策略）。 */
export async function probeManyTools(items, { concurrency = 4, onResult } = {}) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const it = items[idx];
      const r = await probeToolUse(it);
      out[idx] = r;
      onResult?.(it, r);
    }
  });
  await Promise.all(workers);
  return out;
}
