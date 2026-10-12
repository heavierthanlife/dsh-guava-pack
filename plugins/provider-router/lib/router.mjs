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
 * Security boundary: only opens 127.0.0.1, never touches the system proxy,
 * the registry or Tailscale.
 */

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent as HttpsAgent } from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 可配置项 ────────────────────────────────────────────────────────────
// 多机/云端部署的关键：下面每一项都能用环境变量覆盖，**不需要改代码**。
//   DSH_ROUTER_HOST / DSH_ROUTER_PORT   监听地址与端口（默认 127.0.0.1:8318）
//   DSH_SSR_PROXY / SSR_PROXY           翻墙代理地址（默认 http://127.0.0.1:2080）
//   DSH_ROUTER_PROVIDERS                上游表 JSON 的路径（默认 <包>/providers.json）
//   DSH_ROUTER_CAPTURE=1                排障抓包，**默认关闭**（见文件末尾警告）
const LISTEN_HOST = process.env.DSH_ROUTER_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.DSH_ROUTER_PORT || 8318);
const SSR_PROXY = process.env.DSH_SSR_PROXY || process.env.SSR_PROXY || 'http://127.0.0.1:2080';
const SSR_URL = new URL(SSR_PROXY);
const SSR_HOST = SSR_URL.hostname;
const SSR_PORT = Number(SSR_URL.port || (SSR_URL.protocol === 'https:' ? 443 : 80));
/** Give up on a CONNECT handshake that never answers, so a request cannot hang. */
const CONNECT_TIMEOUT_MS = 15000;

const ROUTER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE_FILE = join(ROUTER_DIR, 'mode.json');
const CAPTURE_ENABLED = process.env.DSH_ROUTER_CAPTURE === '1';
const CAPTURE_FILE = process.env.DSH_ROUTER_CAPTURE_FILE || join(ROUTER_DIR, 'capture-last-request.json');

/**
 * 内置上游表（默认值）。可以用同目录的 `providers.json` 增补/覆盖，
 * 路径也能用 DSH_ROUTER_PROVIDERS 指到别处 —— 云端换上游不必改代码。
 *
 * 每条形如：
 *   "<provider>": { "baseURL": "https://…/v1", "headers": { "user-agent": "…" } }
 *
 * 本地条目（`127.0.0.1:…`）是桥接或第三方反代，它们自己负责对外请求；
 * loopback 目标恒直连，因为把本机一跳塞进 SSR 没有意义。
 *
 * 2026-10-04 实测（直连 vs 经 SSR）：
 *   xiaomi      401 0.15s vs 401 0.33s   → 直连更快
 *   opencode-go 200 0.82s vs 200 0.79s   → 持平
 *   agentrouter 000 TIMEOUT vs 401 1.70s → **只有它必须走 SSR**
 *   commandcode 200 0.81s vs 200 2.09s   → 直连更快
 */
const BUILTIN_PROVIDERS = {
  'xiaomi-token-plan-cn': { baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' },
  'opencode-go': { baseURL: 'https://opencode.ai/zen/go/v1' },
  'antigravity': { baseURL: 'http://127.0.0.1:8045' },
  // AgentRouter 有客户端白名单：只放行特定 User-Agent（实测 'pi (win32 ...)' 通过，
  // 其余一律 401 unauthorized client）。DSH 自身强制自带 UA 且会过滤配置里的 user-agent，
  // 所以必须由本代理在这一跳改写 UA。
  // 注意 baseURL 不带 /v1：该站点路径自己带，加了会 404。
  'agentrouter': { baseURL: 'https://agentrouter.org', headers: { 'user-agent': 'pi (win32 10.0.26300; x64)' } },
  'commandcode': { baseURL: 'http://127.0.0.1:8317/v1' },
};

/**
 * 合并 `providers.json` 到内置表之上。启动时读一次（改完重启生效），
 * 这样云端部署只要写个 JSON，不用碰这个文件。
 */
function loadProviders() {
  const file = process.env.DSH_ROUTER_PROVIDERS || join(ROUTER_DIR, 'providers.json');
  let overrides = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed;
  } catch (err) {
    // 文件不存在是正常情况（用内置表）；其余错误值得报出来
    if (err && err.code !== 'ENOENT') {
      console.log(`[dsh-provider-router] ${file} 读取失败，改用内置上游表：${err.message}`);
    }
  }
  const merged = {};
  for (const [name, def] of Object.entries({ ...BUILTIN_PROVIDERS, ...overrides })) {
    if (!def || typeof def.baseURL !== 'string' || def.baseURL === '') {
      console.log(`[dsh-provider-router] 跳过无效 provider "${name}"：缺 baseURL`);
      continue;
    }
    merged[name] = def;
  }
  return merged;
}

const PROVIDERS = loadProviders();

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

    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    headers.host = target.host;
    // 每个 provider 可声明必须改写的头（如 AgentRouter 的 UA 白名单）。
    if (entry.headers) for (const [k, v] of Object.entries(entry.headers)) headers[k] = v;

    const isHttps = target.protocol === 'https:';
    // A loopback upstream already sits on this machine: SSR only adds a pointless
    // detour, so the mode is honoured for remote HTTPS targets only.
    const useSsr = mode === 'ssr' && isHttps && !isLoopbackHost(target.hostname);
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const upstream = doRequest(target, {
      method: req.method,
      headers,
      agent: useSsr ? new SsrProxyAgent() : undefined,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
      if (CAPTURE_ENABLED && provider === 'agentrouter' && req.method === 'POST') {
        writeFile(CAPTURE_FILE + '.status', `status=${upRes.statusCode} at=${new Date().toISOString()}\n`).catch(() => {});
      }
    });

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end('upstream error: ' + describeUpstreamError(err) + '\n');
    });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // ⚠️ 排障抓包，**默认关闭**（要显式 DSH_ROUTER_CAPTURE=1 才开）。
    // 开启后会把 agentrouter 的完整请求体 —— 包含你的提示词与整段对话 —— 明文写入
    // CAPTURE_FILE。只在排障时临时开，用完删掉文件；不要随包分发抓到的内容。
    if (CAPTURE_ENABLED && provider === 'agentrouter' && req.method === 'POST') {
      try {
        await writeFile(CAPTURE_FILE, body);
        console.log('[dsh-provider-router] captured request body → ' + CAPTURE_FILE);
      } catch (err) {
        console.log('[dsh-provider-router] capture failed: ' + err.message);
      }
    }
    headers['content-length'] = String(body.length);
    delete headers['transfer-encoding'];
    upstream.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('router error: ' + err.message + '\n');
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[dsh-provider-router] listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`[dsh-provider-router] providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log(`[dsh-provider-router] providers file: ${process.env.DSH_ROUTER_PROVIDERS || join(ROUTER_DIR, 'providers.json')}`);
  console.log(`[dsh-provider-router] SSR proxy: ${SSR_HOST}:${SSR_PORT}  (${SSR_PROXY})`);
  console.log(`[dsh-provider-router] capture: ${CAPTURE_ENABLED ? 'ON → ' + CAPTURE_FILE : 'off (DSH_ROUTER_CAPTURE=1 可开)'}`);
});
