/**
 * commandcode-bridge — 把 DSH 的 OpenAI 兼容请求翻译成 Command Code 的
 * CLI 内部端点 POST /alpha/generate，让 $1/月 的 Go 套餐也能在 DSH 里用。
 *
 * 为什么需要它：
 *   /provider/v1/chat/completions  → 需要 Provider $15+ 套餐（Go 会 403）
 *   /alpha/generate               → 任意套餐都能用（cmd CLI 自己走的就是它）
 *
 * 形态差异：
 *   请求：OpenAI Chat Completions → {config, memory, taste, skills, permissionMode, params}
 *   响应：NDJSON（每行一个事件） → SSE（data: {...}\n\n）
 *
 * 零依赖，只用 Node 内置模块。
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 8317);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const UPSTREAM = "https://api.commandcode.ai";
const GENERATE = `${UPSTREAM}/alpha/generate`;
const MODELS = `${UPSTREAM}/provider/v1/models`;

// 出口模式由 provider-router 插件的 mode.json 决定（热读，无需重启）：
//   direct → 直连上游（实测 0.81s，当前最优）
//   ssr    → 经 ShadowsocksR(127.0.0.1:2080) 出去（上游变慢/被墙时可切）
//
// 路径按布局自动找，**四种真实布局都要覆盖**（以前只覆盖前两种，于是 pack 布局
// 下 MODE_FILE 永远不存在，异常被 catch 吞掉后**静默永远直连** —— direct/ssr
// 开关对桥接完全失效，而且没有任何日志能看出来）：
//   1. 源码布局   themes/{commandcode-bridge,provider-router}      → ../provider-router
//   2. pack 布局  dsh-guava-pack/services/commandcode-bridge
//                  + dsh-guava-pack/plugins/provider-router        → ../../plugins/provider-router
//   3. 混合布局   pack/services/... + themes/provider-router       → ../../../provider-router
//   4. 工作区     themes/commandcode-bridge + pack/plugins/...     → ../dsh-guava-pack/plugins/provider-router
// 另外永远优先用启动器导出的 `DSH_ROUTER_MODE_FILE`（三方共用的那份）。
const MODE_FILE_CANDIDATES = [
  process.env.DSH_ROUTER_MODE_FILE,
  join(HERE, "..", "provider-router", "mode.json"),
  join(HERE, "..", "..", "plugins", "provider-router", "mode.json"),
  join(HERE, "..", "..", "..", "provider-router", "mode.json"),
  join(HERE, "..", "dsh-guava-pack", "plugins", "provider-router", "mode.json"),
].filter((p) => typeof p === "string" && p !== "");
const SSR_PROXY = process.env.DSH_SSR_PROXY || process.env.SSR_PROXY || "http://127.0.0.1:2080";
let ssrDispatcher = null;

/** 第一个真实存在的候选路径；都不存在时返回第一个（读取失败仍走 direct 兜底）。 */
function modeFile() {
  for (const candidate of MODE_FILE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return MODE_FILE_CANDIDATES[0] ?? join(HERE, "..", "provider-router", "mode.json");
}

async function commandcodeMode() {
  try {
    const parsed = JSON.parse(readFileSync(modeFile(), "utf8"));
    if (parsed && typeof parsed.commandcode === "string") return parsed.commandcode;
  } catch {}
  return "direct";
}

const API_KEY = process.env.COMMANDCODE_API_KEY || "";
// x-command-code-version 必须跟随已安装的 CLI，否则会被拒。
const CLI_VERSION = process.env.CC_CLI_VERSION || "1.72.4";
const LOG_FILE = process.env.BRIDGE_LOG || join(HERE, "bridge.log");

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  if (process.env.BRIDGE_VERBOSE) process.stderr.write(line);
}

/**
 * 实测发现：长时间空闲后的「第一发」请求偶发解析/连接冷启动失败
 * （fetch 直接被 reject，说明请求根本没发出去），所以重试是安全的，
 * 不会造成上游重复计费。
 */
async function fetchWithRetry(url, opts, attempts = 4) {
  // 出口模式每请求热读 mode.json：插件的开关改了立刻生效，不用重启桥接。
  //
  // SSR 路径必须成对使用 npm 那份 undici 的 fetch + ProxyAgent：Node 内置的
  // 全局 fetch 用的是它内部的 undici 副本，两边 dispatcher 不兼容，混用会直接
  // 抛 UND_ERR_INVALID_ARG。
  const mode = await commandcodeMode();
  const viaSsr = mode === "ssr";
  if (viaSsr) ssrDispatcher ??= new ProxyAgent(SSR_PROXY);
  const doFetch = viaSsr ? undiciFetch : fetch;
  const finalOpts = viaSsr ? { ...opts, dispatcher: ssrDispatcher } : opts;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await doFetch(url, finalOpts);
    } catch (e) {
      last = e;
      log(`! fetch failed (${i}/${attempts}, ${mode}): ${e.message} cause=${e.cause?.code || e.cause?.message || "-"}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 150 * i));
    }
  }
  throw last;
}

/** 定期解析上游域名，避免空闲后首次解析失败。 */
function keepDnsWarm() {
  try { dns.lookup(new URL(GENERATE).hostname).catch(() => {}); } catch {}
}

/** 稳定的会话 id：让上游的路由/前缀缓存有亲和性（文件持久化，重启不变）。 */
const SID_FILE = join(HERE, ".session-id");
function sessionId() {
  try {
    if (existsSync(SID_FILE)) return readFileSync(SID_FILE, "utf8").trim();
    const id = randomUUID();
    writeFileSync(SID_FILE, id);
    return id;
  } catch { return randomUUID(); }
}
const SESSION = sessionId();

/* ------------------------------------------------------------------ *
 * OpenAI → /alpha/generate
 * ------------------------------------------------------------------ */

/** config 是 schema-strict 的，这 9 个字段全部必填（缺一个就 400）。 */
function buildConfig() {
  return {
    workingDir: process.env.CC_WORKING_DIR || "/tmp",
    date: new Date().toISOString().slice(0, 10),
    environment: process.env.CC_ENVIRONMENT || "linux",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

/** OpenAI content（string 或 parts 数组）→ 纯文本。 */
function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "image_url") return "[image omitted]";
        return p?.text ?? "";
      })
      .join("");
  }
  return String(content);
}

function safeParse(s) {
  if (s == null) return {};
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * 过滤模型内部控制 token（例如 <|start|>, <|end|>, <|channel|>, <|constrain|>, </rfl:parameter> 等）。
 * 这些是 Beam / Reflection 等模型在思考流或正文中偶发泄漏的内部模板标记。
 * 如果直接在历史消息中回传给上游，jinja / tokenizer 会因非法控制字符崩溃，报错：
 * "The request could not be rendered into a prompt for this model."
 */
function sanitizeControlTokens(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/<\|[a-zA-Z0-9_:.\- ]+?\|>/g, " ")
    .replace(/<\/?rfl:[a-zA-Z0-9_:.\- ]+?>/g, " ");
}

/** OpenAI messages → Vercel-AI-SDK 形态的 ModelMessage[]（上游要的形状）。 */
function toWireMessages(messages, model) {
  const isBeam = /beam/i.test(model || "");
  const out = [];
  for (const m of messages || []) {
    if (m.role === "system" || m.role === "developer") continue; // 已并入 system
    if (m.role === "user") {
      out.push({ role: "user", content: sanitizeControlTokens(textOf(m.content)) });
    } else if (m.role === "assistant") {
      const parts = [];

      // 提取已有的思考/推理内容
      let reasoningText = "";
      if (typeof m.reasoning_content === "string") {
        reasoningText = m.reasoning_content;
      } else if (typeof m.reasoning === "string") {
        reasoningText = m.reasoning;
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p?.type === "thinking" && typeof p.thinking === "string") {
            reasoningText += p.thinking;
          } else if (p?.type === "reasoning" && typeof p.text === "string") {
            reasoningText += p.text;
          }
        }
      }

      // 清除泄漏的控制标记（防止上游 jinja 模板渲染失败）
      reasoningText = sanitizeControlTokens(reasoningText).trim();

      // Beam 等推理模型强制要求每一条 assistant 历史消息都带有 reasoning_content。
      // 若已有推理内容则原样转入；若为其它模型产生的历史消息（无推理内容），则兜底填一个空格 " "
      // （不能填空字符串 ""，上游序列化时会把空字符串判为 false 并丢弃，导致后端报 400）。
      if (reasoningText.length > 0 || isBeam) {
        parts.push({
          type: "reasoning",
          text: reasoningText.length > 0 ? reasoningText : " ",
        });
      }

      const t = sanitizeControlTokens(textOf(m.content)).trim();
      if (t) parts.push({ type: "text", text: t });
      for (const tc of m.tool_calls || []) {
        parts.push({
          type: "tool-call",
          toolCallId: tc.id || randomUUID(),
          toolName: tc.function?.name ?? tc.name ?? "",
          input: safeParse(tc.function?.arguments ?? tc.arguments),
        });
      }
      out.push({ role: "assistant", content: parts });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || m.id || "",
          toolName: m.name || "",
          output: { type: "text", value: textOf(m.content) },
        }],
      });
    }
  }
  return out;
}

/** OpenAI tools → 上游的 {name, description, input_schema}。 */
function toWireTools(tools) {
  return (tools || []).map((t) => {
    const f = t.function || t;
    return {
      name: f.name,
      description: f.description ?? "",
      input_schema: f.parameters ?? { type: "object", properties: {} },
    };
  });
}

function buildEnvelope(body) {
  const rawSystem = (body.messages || [])
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n\n");
  const system = sanitizeControlTokens(rawSystem);
  const params = {
    model: body.model,
    system,
    messages: toWireMessages(body.messages, body.model),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192,
    stream: true, // 上游强制要求 stream:true
  };
  const tools = toWireTools(body.tools);
  if (tools.length) params.tools = tools;
  // DSH 的思考档位：上游接受 effort（实测对多数模型是 no-op，但仍透传）
  const effort = body.reasoning_effort || body.effort;
  if (effort && effort !== "none") params.effort = effort;
  return {
    config: buildConfig(),
    memory: "",
    taste: null,
    skills: null,
    permissionMode: "standard",
    params,
  };
}

/* ------------------------------------------------------------------ *
 * NDJSON → OpenAI SSE
 * ------------------------------------------------------------------ */

const FINISH = {
  stop: "stop",
  length: "length",
  "tool-calls": "tool_calls",
  "content-filter": "content_filter",
  error: "stop",
};

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(model, delta, finish = null) {
  return {
    id: "chatcmpl-" + randomUUID(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** 一个 OpenAI 请求 → 上游 NDJSON → 客户端 SSE / JSON。 */
async function handleChat(req, res, body) {
  if (!API_KEY) {
    res.writeHead(500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "bridge misconfigured: COMMANDCODE_API_KEY missing" } }));
  }
  const wantsStream = body.stream !== false;
  const envelope = buildEnvelope(body);
  const model = body.model;

  log("→", model, "tools=", (envelope.params.tools || []).length,
      "msgs=", envelope.params.messages.length, "stream=", wantsStream);

  let upstream;
  try {
    upstream = await fetchWithRetry(GENERATE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "application/x-ndjson",
        "x-cli-environment": "production",
        "x-command-code-version": CLI_VERSION,
        "x-session-id": SESSION,
      },
      body: JSON.stringify(envelope),
    });
  } catch (e) {
    log("! upstream unreachable after retries:", e.cause?.code || e.message);
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `bridge upstream unreachable: ${e.cause?.code || e.message}` } }));
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    log("! upstream", upstream.status, text.slice(0, 300));
    let msg = text.slice(0, 600);
    try { msg = JSON.parse(text)?.error?.message ?? msg; } catch {}
    res.writeHead(upstream.status, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: msg, type: "upstream_error", code: upstream.status } }));
  }

  if (wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  }

  // 累积状态（非流式要用，流式也要用于最终 usage）
  let text = "", reasoning = "";
  const toolCalls = []; // {id, name, args}
  const byId = new Map();
  let finishReason = "stop";
  let usage = null;
  let errored = null;

  const ensureTool = (id, name) => {
    let tc = byId.get(id);
    if (!tc) {
      tc = { id, name: name || "", args: "", index: toolCalls.length };
      byId.set(id, tc);
      toolCalls.push(tc);
    }
    if (name) tc.name = name;
    return tc;
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = (line) => {
    const s = line.trim();
    if (!s) return;
    let ev;
    try { ev = JSON.parse(s); } catch { return; }
    switch (ev.type) {
      case "reasoning-delta": {
        const clean = sanitizeControlTokens(ev.text || "");
        reasoning += clean;
        if (wantsStream && clean) sse(res, chunk(model, { reasoning_content: clean }));
        break;
      }
      case "text-delta": {
        const clean = sanitizeControlTokens(ev.text || "");
        text += clean;
        if (wantsStream && clean) sse(res, chunk(model, { content: clean }));
        break;
      }
      case "tool-input-start": {
        const tc = ensureTool(ev.id, ev.toolName);
        if (wantsStream) {
          sse(res, chunk(model, {
            tool_calls: [{ index: tc.index, id: tc.id, type: "function",
                           function: { name: tc.name, arguments: "" } }],
          }));
        }
        break;
      }
      case "tool-input-delta": {
        const tc = ensureTool(ev.id);
        tc.args += ev.delta || "";
        if (wantsStream) {
          sse(res, chunk(model, {
            tool_calls: [{ index: tc.index, function: { arguments: ev.delta || "" } }],
          }));
        }
        break;
      }
      case "tool-call": {
        // 完整调用（权威值）：若之前没发过 tool-input-start 就补发
        const tc = ensureTool(ev.toolCallId, ev.toolName);
        const args = typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input ?? {});
        if (!tc.args) {
          tc.args = args;
          if (wantsStream) {
            sse(res, chunk(model, {
              tool_calls: [{ index: tc.index, id: tc.id, type: "function",
                             function: { name: tc.name, arguments: args } }],
            }));
          }
        }
        break;
      }
      case "finish-step":
        usage = ev.usage || usage;
        finishReason = FINISH[ev.finishReason] ?? "stop";
        break;
      case "finish":
        if (ev.totalUsage) usage = ev.totalUsage;
        if (ev.finishReason) finishReason = FINISH[ev.finishReason] ?? finishReason;
        break;
      case "error":
        errored = ev.error?.message || "upstream error";
        log("! upstream error event:", errored);
        break;
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handleLine(line);
    }
  }
  if (buf.trim()) handleLine(buf);

  const usageOut = {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage?.outputTokenDetails?.reasoningTokens ?? 0 },
  };

  if (!wantsStream) {
    if (errored && !text && !toolCalls.length) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: errored } }));
    }
    const message = { role: "assistant", content: text || null };
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((t) => ({
        id: t.id, type: "function", function: { name: t.name, arguments: t.args || "{}" },
      }));
      message.content = text || null;
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      id: "chatcmpl-" + randomUUID(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : finishReason,
      }],
      usage: usageOut,
    }));
  }

  // 流式收尾
  if (errored && !text && !reasoning && !toolCalls.length) {
    sse(res, { error: { message: errored, type: "upstream_error" } });
  } else {
    sse(res, chunk(model, {}, toolCalls.length ? "tool_calls" : finishReason));
  }
  sse(res, {
    id: "chatcmpl-" + randomUUID(), object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, choices: [], usage: usageOut,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, upstream: GENERATE, cliVersion: CLI_VERSION, session: SESSION }));
  }

  // DSH 可能来拉模型列表：直接透传上游（该端点不受套餐限制）
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    try {
      const r = await fetchWithRetry(MODELS, {
        headers: { authorization: `Bearer ${API_KEY}`, accept: "application/json" },
      });
      const t = await r.text();
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(t);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.writeHead(400, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: { message: "invalid JSON body" } })); }
    try {
      await handleChat(req, res, body);
    } catch (e) {
      log("! handler threw:", e.stack || e.message);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: e.message } }));
      } else res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  cli=${CLI_VERSION}  session=${SESSION}`);
  console.log(`commandcode-bridge listening on http://${HOST}:${PORT}`);
  console.log(`  OpenAI base_url → http://${HOST}:${PORT}/v1`);
  console.log(`  health          → http://${HOST}:${PORT}/health`);

  // 预热上游连接 + 定时保活解析，规避空闲后首次请求失败
  keepDnsWarm();
  fetchWithRetry(MODELS, { headers: { authorization: `Bearer ${API_KEY}`, accept: "application/json" } }, 3)
    .then((r) => log(`warm-up ok (HTTP ${r.status})`))
    .catch((e) => log("warm-up failed:", e.cause?.code || e.message));
  setInterval(keepDnsWarm, 30000).unref?.();
});
