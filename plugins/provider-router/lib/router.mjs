/**
 * dsh-provider-router — local routing proxy (standalone WSL process, zero deps).
 *
 * Listens on 127.0.0.1:8318. Routes by path prefix:
 *     /<provider>/<rest of path>
 * The `<provider>` selects a real upstream (see PROVIDERS). For each request it
 * re-reads `mode.json` (written by the Host plugin) and forwards either:
 *   - direct: straight to the upstream, or
 *   - ssr:    through the SSR proxy (HTTP CONNECT). 默认 127.0.0.1:2080，
 *             可用环境变量 DSH_SSR_PROXY / SSR_PROXY 覆盖（每台机器的代理端口
 *             可能不同，例如 127.0.0.1:2099）—— 多机部署的关键。
 *
 * Streaming (SSE) is passed through byte-for-byte in both directions.
 *
 * ## 环境变量（全部有默认值，不设就是老行为）
 *
 *   DSH_ROUTER_HOST / DSH_ROUTER_PORT   监听地址 / 端口（默认 127.0.0.1:8318）
 *   DSH_ROUTER_PROVIDERS                上游表覆盖文件（默认 <插件目录>/providers.json）
 *   DSH_SSR_PROXY / SSR_PROXY           SSR 代理（默认 http://127.0.0.1:2080）
 *   DSH_ROUTER_CAPTURE=1                排障抓包（默认关，产物含提示词明文）
 *   DSH_ROUTER_HEADER_TIMEOUT_MS        等上游响应头的上限（默认 120000）
 *   DSH_ROUTER_MAX_BODY_BYTES           请求体上限（默认 64MiB，超了 413）
 *
 * Security boundary: only opens 127.0.0.1 by default, never touches the system
 * proxy, the registry or Tailscale.
 */

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent as HttpsAgent } from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 监听地址/端口：DSH_ROUTER_HOST / DSH_ROUTER_PORT > 默认 127.0.0.1:8318
const LISTEN_HOST = process.env.DSH_ROUTER_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.DSH_ROUTER_PORT || 8318);
// SSR 代理地址：DSH_SSR_PROXY > SSR_PROXY > 默认 127.0.0.1:2080
const SSR_PROXY = process.env.DSH_SSR_PROXY || process.env.SSR_PROXY || 'http://127.0.0.1:2080';
const SSR_URL = new URL(SSR_PROXY);
const SSR_HOST = SSR_URL.hostname;
const SSR_PORT = Number(SSR_URL.port || (SSR_URL.protocol === 'https:' ? 443 : 80));
/** Give up on a CONNECT handshake that never answers, so a request cannot hang. */
const CONNECT_TIMEOUT_MS = 15000;

/**
 * SSR 出口的共享 Agent。
 *
 * 以前每个请求 `new SsrProxyAgent()`：意味着**每次**经 SSR 的调用都要重做
 * TCP 连接 + CONNECT 握手 + TLS 握手（实测每个请求多 ~100ms，还制造大量
 * TIME_WAIT）。这里复用一个开了 keepAlive 的实例，隧道连接会被池化复用。
 */
let ssrAgent;
function getSsrAgent() {
  ssrAgent ??= new SsrProxyAgent({ keepAlive: true, maxSockets: 32 });
  return ssrAgent;
}

/**
 * 上游**响应头**等待上限（只覆盖"还没收到响应头"这段，不是整段时长）。
 *
 * 为什么需要：`CONNECT_TIMEOUT_MS` 只管 SSR 的 CONNECT 握手那一跳。上游接受了 TCP
 * 却永不回包时，请求会永久挂起，只能靠 DSH 自己的 LLM 超时脱身。用"响应头超时"而不是
 * 整体超时，是因为长流式输出（SSE）本来就可能持续很久，不该被总时长掐断。
 */
const HEADER_TIMEOUT_MS = Number(process.env.DSH_ROUTER_HEADER_TIMEOUT_MS || 120000);
/** 请求体上限：超过就 413 并断开，避免超大 POST 把内存打爆（chunks + concat 是双份）。 */
const MAX_BODY_BYTES = Number(process.env.DSH_ROUTER_MAX_BODY_BYTES || 64 * 1024 * 1024);

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * mode.json 的位置。启动器统一导出 `DSH_ROUTER_MODE_FILE`：host 插件从 pack 加载、
 * router 从工作区启动，各读各的会让面板开关切换不生效（真踩过）。
 */
const MODE_FILE = process.env.DSH_ROUTER_MODE_FILE || join(HERE, 'mode.json');
/** 上游表覆盖文件：DSH_ROUTER_PROVIDERS > <插件目录>/providers.json。 */
const PROVIDERS_FILE = process.env.DSH_ROUTER_PROVIDERS || join(HERE, 'providers.json');

/**
 * Every provider the router can carry, mapped to its REAL upstream.
 *
 * Local entries (`127.0.0.1:…`) are bridges or third-party reverse proxies that
 * already perform their own outward request; a loopback target is always sent
 * direct, because tunnelling a local hop through the SSR proxy is meaningless.
 *
 * Measured 2026-10-04 on the then-current network (direct vs via SSR):
 *   xiaomi      401 0.15s vs 401 0.33s   → direct wins
 *   opencode-go 200 0.82s vs 200 0.79s   → tie
 *   agentrouter 000 TIMEOUT vs 401 1.70s → **only this one needs SSR**
 *   commandcode 200 0.81s vs 200 2.09s   → direct wins
 */
const BUILT_IN_PROVIDERS = {
  'xiaomi-token-plan-cn': { baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' },
  'opencode-go': { baseURL: 'https://opencode.ai/zen/go/v1' },
  'antigravity': { baseURL: 'http://127.0.0.1:8045' },
  // AgentRouter 有客户端白名单：只放行特定 User-Agent（实测 'pi (win32 ...)' 通过，
  // 其余一律 401 unauthorized client）。DSH 自身强制自带 UA 且会过滤配置里的 user-agent，
  // 所以必须由本代理在这一跳改写 UA。
  'agentrouter': { baseURL: 'https://agentrouter.org', headers: { 'user-agent': 'pi (win32 10.0.26300; x64)' } },
  'commandcode': { baseURL: 'http://127.0.0.1:8317/v1' },
};

/**
 * 生效的上游表 = 内置表 + 可选的 `providers.json` 覆盖/增补。
 *
 * README 与 `providers.example.json` 一直承诺"复制为 providers.json 即可覆盖/增补
 * 内置上游表"，但以前没有任何代码读它。进程启动时读一次（改完重启路由代理生效，
 * 与 README 的说法一致）。
 */
let PROVIDERS = { ...BUILT_IN_PROVIDERS };

/** 读 providers.json 并合并进 PROVIDERS；文件不存在就静默沿用内置表。 */
async function loadProviders() {
  let raw;
  try {
    raw = await readFile(PROVIDERS_FILE, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.log('[dsh-provider-router] providers.json 读取失败，沿用内置表：' + err.message);
    }
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.log('[dsh-provider-router] providers.json 不是合法 JSON，沿用内置表：' + err.message);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.log('[dsh-provider-router] providers.json 顶层必须是对象，沿用内置表');
    return;
  }
  let added = 0;
  let updated = 0;
  for (const [name, def] of Object.entries(parsed)) {
    if (name.startsWith('_')) continue; // `_comment` 之类的说明键
    if (def === null || typeof def !== 'object' || typeof def.baseURL !== 'string' || def.baseURL === '') {
      console.log(`[dsh-provider-router] providers.json 里 ${name} 缺少 baseURL，跳过`);
      continue;
    }
    try {
      new URL(def.baseURL);
    } catch {
      console.log(`[dsh-provider-router] providers.json 里 ${name} 的 baseURL 不是合法 URL，跳过`);
      continue;
    }
    const base = BUILT_IN_PROVIDERS[name];
    const merged = { ...base, ...def };
    // headers 要**合并**而不是整体替换，否则只覆盖 UA 会把内置的其它头丢掉。
    const headers = { ...(base?.headers ?? {}), ...(def.headers ?? {}) };
    if (Object.keys(headers).length > 0) merged.headers = headers;
    else delete merged.headers;
    PROVIDERS[name] = merged;
    if (base) updated += 1;
    else added += 1;
  }
  console.log(
    `[dsh-provider-router] providers.json：+${added} 增补 ~${updated} 覆盖（共 ${Object.keys(PROVIDERS).length} 个）`,
  );
}

/**
 * RFC 7230 §6.1 的逐跳头：只对"当前这一跳"有意义，不能原样透传给客户端。
 * 以前把上游响应头整体 `writeHead`，客户端会收到上游的 `connection: keep-alive`
 * 与 `keep-alive: timeout=5` —— 那是"我和上游之间"的连接语义，外泄是错的。
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function filterHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

const DEFAULT_MODES = {
  'xiaomi-token-plan-cn': 'direct',
  'opencode-go': 'direct',
  'antigravity': 'direct',
  'agentrouter': 'ssr',
  'commandcode': 'direct',
};

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

async function currentMode(provider) {
  try {
    const raw = await readFile(MODE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed[provider] === 'string') return parsed[provider];
  } catch {}
  return DEFAULT_MODES[provider] || 'direct';
}

/**
 * https.Agent that tunnels the TCP connection through the SSR HTTP proxy.
 *
 * IMPORTANT: `https.Agent.createConnection` is responsible for the TLS
 * handshake — overriding it means we must perform the TLS wrap ourselves.
 * Returning the raw tunnel socket sends PLAIN HTTP to the upstream's HTTPS
 * port, which the edge answers with
 * `400 The plain HTTP request was sent to HTTPS port`.
 */
class SsrProxyAgent extends HttpsAgent {
  createConnection(options, cb) {
    const host = options.hostname || options.host;
    const port = options.port || 443;
    const sock = net.connect(SSR_PORT, SSR_HOST);
    let buf = Buffer.alloc(0);
    let finished = false;
    let timer = null;

    const done = (err, socket) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      cb(err, socket);
    };

    // A proxy that accepts the socket and then goes silent would otherwise leave
    // the callback unfired forever, hanging the request.
    timer = setTimeout(() => {
      try { sock.destroy(); } catch {}
      done(new Error('SSR CONNECT timeout after ' + CONNECT_TIMEOUT_MS + 'ms'));
    }, CONNECT_TIMEOUT_MS);

    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.removeListener('data', onData);
      const statusLine = buf.subarray(0, idx).toString('latin1').split('\r\n')[0] || '';
      if (!statusLine.includes(' 200')) {
        sock.destroy();
        done(new Error('SSR CONNECT failed: ' + statusLine));
        return;
      }
      const rest = buf.subarray(idx + 4);
      if (rest.length) sock.unshift(rest);
      const secure = tls.connect({
        socket: sock,
        servername: options.servername || host,
      });
      secure.once('secureConnect', () => done(null, secure));
      secure.once('error', (err) => {
        try { secure.destroy(); } catch {}
        done(err);
      });
    };

    sock.on('data', onData);
    sock.on('error', (err) => done(err));
    // A silent drop before the handshake finishes must also settle the callback.
    sock.on('close', () => done(new Error('SSR CONNECT closed before handshake completed')));
    sock.on('end', () => done(new Error('SSR CONNECT ended before handshake completed')));
    sock.on('connect', () => {
      sock.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n\r\n`,
      );
    });
  }
}

/**
 * Render an upstream failure into something diagnosable.
 *
 * Why this exists: when EVERY resolved address fails, Node throws an
 * `AggregateError` whose `message` is the EMPTY STRING. A bare `err.message`
 * therefore logged exactly `upstream error: ` — no code, no address, nothing to
 * act on. Observed on this machine as `agentrouter.org` resolving (via poisoned
 * DNS) to `2a03:2880:f10f:83:face:b00c:0:25de` and timing out, surfacing as that
 * empty message. So report the code, the cause, and each aggregated failure.
 */
function describeUpstreamError(err) {
  const parts = [];
  if (err) {
    if (err.code) parts.push(err.code);
    if (err.message) parts.push(err.message);
  }
  const nested = err && Array.isArray(err.errors) ? err.errors : err && err.cause ? [err.cause] : [];
  for (const sub of nested) {
    if (!sub || sub === err) continue;
    const address = sub.address ? `${sub.address}:${sub.port || ''}` : '';
    parts.push([sub.code, address, sub.message].filter(Boolean).join(' '));
  }
  return parts.filter(Boolean).join(' | ') || '(no error detail)';
}

const server = createServer(async (req, res) => {
  try {
    const parts = (req.url || '/').split('/').filter(Boolean);

    if (parts.length === 0 || parts[0] === 'health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    const provider = parts[0];
    const entry = PROVIDERS[provider];
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown provider: ' + provider + '\n');
      return;
    }

    const mode = await currentMode(provider);
    const upstreamPath = '/' + parts.slice(1).join('/');
    const target = new URL(entry.baseURL.replace(/\/$/, '') + upstreamPath);

    // ── 先把请求体读完，再构造上游请求 ──────────────────────────────────
    // 顺序是关键：headers 一旦交给 http(s).request() 就被拷进 ClientRequest，
    // 之后再改同一个对象**不生效**。以前 content-length / transfer-encoding 的修正
    // 写在 request() 之后，是彻底的死代码 —— 今天 body 原样转发所以凑巧正确，
    // 将来一旦重写 body 就会给上游一个错误的长度，导致挂起或请求走私。
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 不再累积 —— 这才是防 OOM 的关键。但**继续排空** body，不要中途 destroy：
        // destroy 会 RST 连接，413 可能根本送不到客户端，而且会毒化客户端的
        // keep-alive 连接池（下一个请求复用到这条已死的连接，收到 ECONNRESET）。
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (tooLarge) {
      res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
      res.end('request body too large\n');
      return;
    }
    const body = Buffer.concat(chunks);

    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    delete headers['transfer-encoding'];
    // 空 body 时**不要**凭空加 content-length:0（旧行为实际也没发它），保持一致。
    if (body.length > 0) headers['content-length'] = String(body.length);
    else delete headers['content-length'];
    headers.host = target.host;
    // 每个 provider 可声明必须改写的头（如 AgentRouter 的 UA 白名单）。
    if (entry.headers) for (const [k, v] of Object.entries(entry.headers)) headers[k] = v;

    // ⚠️ 排障抓包，**默认关闭**（要显式 DSH_ROUTER_CAPTURE=1 才开）。
    // 开启后会把 agentrouter 的完整请求体（含提示词与整段对话）明文写入 captures/，
    // 最多保留最近 8 份。只在排障时临时开，用完删掉 captures/。
    let captureBase = null;
    if (provider === 'agentrouter' && req.method === 'POST' && process.env.DSH_ROUTER_CAPTURE === '1') {
      const capDir = join(HERE, 'captures');
      try {
        await mkdir(capDir, { recursive: true });
        captureBase = join(capDir, 'req-' + Date.now());
        await writeFile(captureBase + '.json', body);
        const existing = (await readdir(capDir)).filter((n) => n.endsWith('.json')).sort();
        for (const name of existing.slice(0, Math.max(0, existing.length - 8))) {
          await rm(join(capDir, name.replace(/\.json$/, '.status')), { force: true });
          await rm(join(capDir, name), { force: true });
        }
      } catch (err) {
        console.log('[dsh-provider-router] capture failed: ' + err.message);
      }
    }

    const isHttps = target.protocol === 'https:';
    // A loopback upstream already sits on this machine: SSR only adds a pointless
    // detour, so the mode is honoured for remote HTTPS targets only.
    const useSsr = mode === 'ssr' && isHttps && !isLoopbackHost(target.hostname);
    const doRequest = isHttps ? httpsRequest : httpRequest;

    // `captureBase` / `headerTimer` 都必须在 doRequest **之前**声明：响应回调可能在
    // 任何 await 之后立刻执行，引用还没初始化的 `let` 会抛 ReferenceError，而它发生在
    // EventEmitter 回调里、没人 catch，会直接把 router 进程带走。
    let settled = false;
    let headerTimer = null;

    const upstream = doRequest(target, {
      method: req.method,
      headers,
      agent: useSsr ? getSsrAgent() : undefined,
    }, (upRes) => {
      settled = true;
      if (headerTimer !== null) clearTimeout(headerTimer);
      res.writeHead(upRes.statusCode || 502, filterHopByHop(upRes.headers));
      upRes.pipe(res);
      if (captureBase !== null) {
        const responseText = `status=${upRes.statusCode} at=${new Date().toISOString()}\n`;
        writeFile(captureBase + '.status', responseText).catch(() => {});
      }
      upRes.on('error', (err) => {
        console.log('[dsh-provider-router] upstream response error: ' + describeUpstreamError(err));
        res.destroy();
      });
    });

    // 上游接了 TCP 却一直不回响应头 → 别让请求永久挂着。
    headerTimer = setTimeout(() => {
      if (settled) return;
      upstream.destroy(new Error(`upstream did not respond within ${HEADER_TIMEOUT_MS}ms`));
    }, HEADER_TIMEOUT_MS);

    upstream.on('error', (err) => {
      settled = true;
      if (headerTimer !== null) clearTimeout(headerTimer);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream error: ' + describeUpstreamError(err) + '\n');
        return;
      }
      // 已经进入流式响应：往里追加一行纯文本会污染 SSE/JSON 流，直接断开更诚实。
      res.destroy();
    });

    // 客户端断开（用户取消 / 关标签页）→ 立刻掐掉上游，别让它继续跑、继续烧 token。
    res.on('close', () => {
      if (headerTimer !== null) clearTimeout(headerTimer);
      upstream.destroy();
    });

    upstream.end(body);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('router error: ' + err.message + '\n');
  }
});

server.on('error', (err) => {
  console.log('[dsh-provider-router] server error: ' + describeUpstreamError(err));
});

async function start() {
  // 先读 providers.json 再监听：上游表必须在接第一个请求之前就位。
  await loadProviders();
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`[dsh-provider-router] listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
    console.log(`[dsh-provider-router] providers: ${Object.keys(PROVIDERS).join(', ')}`);
    console.log(`[dsh-provider-router] SSR proxy: ${SSR_HOST}:${SSR_PORT}  (${SSR_PROXY})`);
    console.log(`[dsh-provider-router] providers 覆盖文件: ${PROVIDERS_FILE}`);
  });
}

start();
