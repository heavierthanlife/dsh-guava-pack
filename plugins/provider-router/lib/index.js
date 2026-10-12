/**
 * dsh-provider-router — Host half.
 *
 * Owns the provider → routing-mode map, persists it to `mode.json` (read by the
 * standalone routing proxy `lib/router.mjs`), and exposes it to the Client.
 *
 * ## Why a self-registered `webServer` route and not `connection.rpc.handle`
 *
 * `ctx.provide(name, value)` only makes a Host-local service (`ctx.name`); it
 * does not reach the browser. The Client's `ctx.remote` namespace is fed by the
 * connection RPC bridge, whose generic registry is
 * `ctx.connection.rpc.handle(channel, handler)`.
 *
 * That registry is unusable from another plugin, though: its getter captures
 * `const owner = this.ctx` — the CONNECTION plugin's own context — and then calls
 * `owner.webServer.register(...)`. `dsh-client-connection` declares only
 * `inject = ["credentials"]` and reaches `webServer` through a soft
 * `ctx.inject(["webServer"], (webCtx) => ...)`, so `owner.webServer` always
 * throws:
 *     cannot get property "webServer" without inject
 * Injecting `webServer` into THIS plugin cannot fix that.
 *
 * So this plugin registers the route itself with the documented
 * `ctx.webServer.register(route)` (`kind: "prefix"`), speaks the same RPC
 * envelope protocol on the wire, and the page reaches it with the connection
 * handle's own caller:
 *     ctx.remote.$host.rpc.call('/provider-router', endpoint, payload)
 * which POSTs to `<origin>/provider-router/<endpoint>` and unwraps
 *     { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
 * (`ConnectionRpcResult<T>` in dsh-client-connection's types).
 *
 * Because this route bypasses the connection's Host/Origin fence, the handler
 * performs its own same-origin check below.
 *
 * Security boundary: never touches the Windows system proxy, the registry or
 * Tailscale. Writes exactly one JSON file inside its own directory.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE_FILE = join(ROOT, 'mode.json');
const ROUTE_PATH = '/provider-router';
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Provider → default routing mode.
 *
 * Derived from the 2026-10-04 measurement of each real upstream, direct vs via
 * the SSR proxy (`docs` in router.mjs repeats the numbers): only agentrouter is
 * blocked on this network (12s timeout direct, 1.70s via SSR). Every other
 * upstream is faster — or no slower — going direct, so SSR is opt-in per
 * provider rather than the blanket default it started as.
 */
export const DEFAULT_MODES = Object.freeze({
  'xiaomi-token-plan-cn': 'direct',
  'opencode-go': 'direct',
  'antigravity': 'direct',
  'agentrouter': 'ssr',
  'commandcode': 'direct',
});

const VALID_MODES = new Set(['direct', 'ssr', 'auto']);

/** Resolve "auto" to the provider default. */
function resolveMode(provider, mode) {
  if (mode === 'auto' || mode === undefined || mode === null) {
    return DEFAULT_MODES[provider] || 'direct';
  }
  return mode;
}

/** Read the merged mode map (defaults + persisted overrides). */
export async function readModeFile() {
  const out = { ...DEFAULT_MODES };
  try {
    const parsed = JSON.parse(await readFile(MODE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [provider, mode] of Object.entries(parsed)) {
        if (VALID_MODES.has(mode)) out[provider] = mode;
      }
    }
  } catch {
    // missing or unreadable → defaults are fine
  }
  return out;
}

async function writeModeFile(modes) {
  await mkdir(ROOT, { recursive: true });
  const normalized = { ...DEFAULT_MODES };
  for (const [provider, mode] of Object.entries(modes)) {
    if (VALID_MODES.has(mode)) normalized[provider] = resolveMode(provider, mode);
  }
  await writeFile(MODE_FILE, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return normalized;
}

async function getState() {
  const modes = await readModeFile();
  const resolved = {};
  for (const provider of Object.keys(DEFAULT_MODES)) {
    resolved[provider] = resolveMode(provider, modes[provider]);
  }
  return { modes, resolved, defaults: { ...DEFAULT_MODES } };
}

async function setMode(provider, mode) {
  if (typeof provider !== 'string' || provider === '') throw new Error('provider is required');
  if (!VALID_MODES.has(mode)) throw new Error('mode must be direct | ssr | auto');
  const modes = await readModeFile();
  modes[provider] = mode;
  await writeModeFile(modes);
  return { provider, mode, resolved: resolveMode(provider, mode) };
}

async function resetModes() {
  await writeModeFile({});
  return { defaults: { ...DEFAULT_MODES } };
}

function failure(code, message) {
  return { ok: false, error: { code, message, details: { issues: [] } } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The MagicDNS authority the launcher adds to `--trusted-host`, e.g.
 * `ygy12.tailef4f13.ts.net`: `<hostname>.<resolv.conf search domain>`.
 * Returns null when no search domain is configured.
 */
function tailnetHost() {
  try {
    const match = readFileSync('/etc/resolv.conf', 'utf8').match(/^search\s+(\S+)/m);
    if (match && match[1]) return hostname().toLowerCase() + '.' + match[1];
  } catch {
    // no resolv.conf / no search domain
  }
  return null;
}

/**
 * Required Host services.
 *   webServer  — the HTTP route surface this plugin mounts on.
 *   connection — `authenticatedUrl()` (the fresh process token) and
 *                `requestRejection()` (Connection's own Host/Origin fence plus
 *                browser authentication). The latter replaces a hand-rolled
 *                same-origin check and matters more now that this route can
 *                hand back the login token.
 */
export const inject = ['webServer', 'connection'];

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      let rpcId = 'invalid-request';
      try {
        // Connection's own fence (Host/Origin trust + browser authentication),
        // so this route is guarded exactly like `/api` instead of by a local
        // same-origin approximation.
        const rejection = ctx.connection.requestRejection({ headers: req.headers });
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain' });
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('method not allowed');
          return;
        }

        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        const endpoint = pathname.startsWith(ROUTE_PATH + '/')
          ? pathname.slice(ROUTE_PATH.length + 1)
          : '';

        const body = await readBody(req);
        if (body && typeof body.rpcId === 'string') rpcId = body.rpcId;

        if (!endpoint || !body || body.type !== 'client-request' || body.method !== endpoint) {
          sendJson(res, 200, {
            type: 'server-response',
            rpcId,
            result: failure('gateway/bad-request', 'invalid client-request envelope'),
          });
          return;
        }

        let result;
        switch (endpoint) {
          case 'getState':
            result = { ok: true, value: await getState() };
            break;
          case 'setMode':
            result = {
              ok: true,
              value: await setMode(body.payload && body.payload.provider, body.payload && body.payload.mode),
            };
            break;
          case 'reset':
            result = { ok: true, value: await resetModes() };
            break;
          case 'getToken': {
            // The page passes its own origin so the scheme (http on loopback,
            // https on the tailnet) is preserved; falling back to the request's
            // Host keeps a plain curl usable.
            const origin =
              body.payload && typeof body.payload.origin === 'string' && body.payload.origin
                ? body.payload.origin
                : 'http://' + (req.headers.host || '127.0.0.1:3080');
            let tokenizedUrl = null;
            try {
              tokenizedUrl = ctx.connection.authenticatedUrl(origin.replace(/\/+$/, '') + '/');
            } catch {
              // connection refused to mint one
            }
            let token = null;
            try {
              token = new URL(tokenizedUrl).searchParams.get('token');
            } catch {
              // leave null; the Client renders an explanation
            }
            result = { ok: true, value: { token, tokenizedUrl, tailnetHost: tailnetHost() } };
            break;
          }
          default:
            result = failure('provider-router/unknown-method', 'unknown endpoint ' + JSON.stringify(endpoint));
        }
        sendJson(res, 200, { type: 'server-response', rpcId, result });
      } catch (err) {
        try {
          sendJson(res, 200, {
            type: 'server-response',
            rpcId,
            result: failure('provider-router/handler-failed', String((err && err.message) || err)),
          });
        } catch {
          // response already sent
        }
      }
    },
  });

  // Seed mode.json so the routing proxy and the Client agree from the start.
  ctx.effect(() => {
    getState().then((state) => writeModeFile(state.modes)).catch(() => {});
  }, 'dsh-provider-router: seed mode.json');
}
