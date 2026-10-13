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
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 8318;
// SSR 代理地址：DSH_SSR_PROXY > SSR_PROXY > 默认 127.0.0.1:2080
const SSR_PROXY = process.env.DSH_SSR_PROXY || process.env.SSR_PROXY || 'http://127.0.0.1:2080';
const SSR_URL = new URL(SSR_PROXY);
const SSR_HOST = SSR_URL.hostname;
const SSR_PORT = Number(SSR_URL.port || (SSR_URL.protocol === 'https:' ? 443 : 80));
/** Give up on a CONNECT handshake that never answers, so a request cannot hang. */
const CONNECT_TIMEOUT_MS = 15000;

const MODE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mode.json');

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
const PROVIDERS = {
  'xiaomi-token-plan-cn': { baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' },
  'opencode-go': { baseURL: 'https://opencode.ai/zen/go/v1' },
  'antigravity': { baseURL: 'http://127.0.0.1:8045' },
  // AgentRouter 有客户端白名单：只放行特定 User-Agent（实测 'pi (win32 ...)' 通过，
  // 其余一律 401 unauthorized client）。DSH 自身强制自带 UA 且会过滤配置里的 user-agent，
  // 所以必须由本代理在这一跳改写 UA。
  'agentrouter': { baseURL: 'https://agentrouter.org', headers: { 'user-agent': 'pi (win32 10.0.26300; x64)' } },
  'commandcode': { baseURL: 'http://127.0.0.1:8317/v1' },
};

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
      if (captureBase !== null) {
        const responseText = `status=${upRes.statusCode} at=${new Date().toISOString()}\n`;
        writeFile(captureBase + '.status', responseText).catch(() => {});
      }
    });

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end('upstream error: ' + describeUpstreamError(err) + '\n');
    });

    // ⚠️ 排障抓包，**默认关闭**（要显式 DSH_ROUTER_CAPTURE=1 才开）。
    // 开启后会把 agentrouter 的完整请求体（含提示词与整段对话）明文写入 captures/，
    // 最多保留最近 8 份。只在排障时临时开，用完删掉 captures/。
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let captureBase = null;
    if (provider === 'agentrouter' && req.method === 'POST' && process.env.DSH_ROUTER_CAPTURE === '1') {
      const capDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
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
  console.log(`[dsh-provider-router] SSR proxy: ${SSR_HOST}:${SSR_PORT}  (${SSR_PROXY})`);
});
