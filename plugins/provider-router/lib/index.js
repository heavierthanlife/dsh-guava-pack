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
import {
  buildProviderCatalog,
  DEFAULT_MODES as BUILTIN_DEFAULT_MODES,
  resolveProviderRows,
} from './auto-mode.mjs';
import { readProviderEndpoints } from './profile-providers.mjs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * mode.json 的位置。
 *
 * 必须可配：插件从 `dsh-guava-pack` 加载，而路由代理由启动器从工作区拉起，
 * 两边的相对路径不同 —— 各读各的 mode.json 会让面板开关**切换不生效**（真踩过）。
 * 启动器统一导出 `DSH_ROUTER_MODE_FILE`，host 插件 / router / commandcode 桥接
 * 三方都用同一个值。
 */
const MODE_FILE = process.env.DSH_ROUTER_MODE_FILE || join(ROOT, 'mode.json');
const ROUTE_PATH = '/provider-router';
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 内置兜底默认模式（**不再是一等公民**）。
 *
 * 以前这张表是唯一来源 —— 于是新增供应商不会出现在面板、`auto` 静默回落 direct
 * （实测漂移：profile 里 7 家、面板只认 5 家）。现在真正的目录来自
 * `ctx.llm.listProviders()` ∪ `listConfigurableProviders()`，这张表只在
 * llm 服务不可用时兜底。数值本身来自 2026-10-04 的实测。
 */
export const DEFAULT_MODES = BUILTIN_DEFAULT_MODES;

const VALID_MODES = new Set(['direct', 'ssr', 'auto']);

/** 宿主能力版本：客户端据此判断自己是不是在跟旧宿主说话（避免"点了没反应"）。 */
const HOST_API_VERSION = 2;

/** 路由代理自省端点的地址（只在 loopback）。 */
const ROUTER_STATE_URL = process.env.DSH_ROUTER_STATE_URL || 'http://127.0.0.1:8318/_router/state';
const ROUTER_MEASURE_URL = process.env.DSH_ROUTER_MEASURE_URL || 'http://127.0.0.1:8318/_router/measure';

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

/**
 * 归一化一份待落盘的 mode 表：内置兜底打底，只接受合法模式。
 *
 * **绝不把 `auto` 塌缩成静态默认值** —— 代理侧的 `currentMode()` 只有读到字符串
 * `'auto'` 才会做双路实测；以前这里当场换成 `DEFAULT_MODES[provider]`，于是面板的
 * 「自动」永远写不进去、启动时的 seed 还会把手工写的 `auto` 冲掉，自适应选路等于死的。
 */
function normalizeModeFile(modes) {
  const normalized = { ...DEFAULT_MODES };
  for (const [provider, mode] of Object.entries(modes ?? {})) {
    if (VALID_MODES.has(mode)) normalized[provider] = mode;
  }
  return normalized;
}

async function writeModeFile(modes) {
  await mkdir(ROOT, { recursive: true });
  const normalized = normalizeModeFile(modes);
  await writeFile(MODE_FILE, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return normalized;
}

/**
 * 问路由代理"你认识哪些前缀、当前什么模式、auto 测出了什么"。
 *
 * 只用 loopback HTTP，超时 1.2s；拿不到就返回 null（面板降级显示"未判定"），
 * **不能因为代理没起来就让面板白屏**。
 */
async function routerState() {
  try {
    const res = await fetch(ROUTER_STATE_URL, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 让路由代理**当场实测**某一个供应商（direct vs SSR）。
 *
 * 注意这是"用户点一下才测"的重操作：两次探活最多各 3s。不在请求路径上自动跑。
 */
async function measureViaRouter(provider) {
  const url = new URL(ROUTER_MEASURE_URL);
  url.searchParams.set('provider', provider);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json?.error ?? `HTTP ${res.status}`, known: json?.known };
    return { ok: true, ...json };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 自适应状态：供应商目录 + 模式 + 实测。
 *
 * 目录三源合并（live / configurable / 内置兜底），control 由 **profile 里的真实
 * baseURL** 决定（见 auto-mode.buildProviderCatalog），而不是靠 id 猜。
 *
 * @param {object} [ctx] - Cordis context；拿得到就向 llm 服务要 live 目录
 */
async function getState(ctx) {
  const modes = await readModeFile();
  const router = await routerState();
  const dshHome = process.env.DSH_HOME || `${process.env.HOME || ''}/dsh`;

  let live = [];
  let configurable = [];
  try {
    live = ctx?.get?.('llm')?.listProviders?.() ?? [];
  } catch {
    live = [];
  }
  try {
    configurable = ctx?.get?.('llm')?.listConfigurableProviders?.() ?? [];
  } catch {
    configurable = [];
  }
  const endpoints = await readProviderEndpoints(dshHome);

  const providers = buildProviderCatalog({
    live,
    configurable,
    defaults: DEFAULT_MODES,
    routerPrefixes: router?.prefixes ?? [],
    endpoints: endpoints ?? {},
  });

  const measurements = router?.measurements ?? {};
  // 键是 routerKey（代理认识的前缀），不是 profile 里的 id —— 见
  // auto-mode.buildProviderCatalog / resolveProviderRows。
  const resolved = resolveProviderRows(providers, modes, measurements);

  return {
    apiVersion: HOST_API_VERSION,
    providers,
    modes,
    resolved,
    defaults: { ...DEFAULT_MODES },
    measurements,
    router: router === null
      ? { reachable: false, note: '路由代理没响应（8318）—— 下面这些开关可能不会生效' }
      : { reachable: true, prefixes: router.prefixes, upstreams: router.upstreams, ssr: router.ssr },
    endpointsKnown: endpoints !== null,
  };
}

async function setMode(provider, mode) {
  if (typeof provider !== 'string' || provider === '') throw new Error('provider is required');
  if (!VALID_MODES.has(mode)) throw new Error('mode must be direct | ssr | auto');
  const modes = await readModeFile();
  modes[provider] = mode;
  await writeModeFile(modes);
  return { provider, mode };
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
 * 从请求本身推导它的 origin：优先浏览器给的 `Origin` 头，否则按 `Host` +
 * socket 是否加密拼。拿不到就返回 null。
 */
function requestOrigin(req) {
  const raw = req.headers.origin;
  if (typeof raw === 'string' && raw !== '' && raw !== 'null') {
    try {
      return new URL(raw).origin;
    } catch {
      /* 非法 Origin 头：退回 Host */
    }
  }
  const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host;
  if (typeof host === 'string' && host !== '') return `${scheme}://${host}`;
  return null;
}

/**
 * 只比较 authority（hostname:port），**不比较 scheme**。
 * 反代终止 TLS 时 `req.socket.encrypted` 是 false，scheme 推不准；而 Host 已经被
 * `requestRejection` 的围栏校验过，按 authority 比较才是可靠的判据。
 */
function sameAuthority(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
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

/** 导出以便自检直接驱动（不需要起 Cordis / 起浏览器）。 */
export { getState, measureViaRouter, HOST_API_VERSION, normalizeModeFile };

export function apply(ctx) {
  // 挂在 effect 上：`webServer.register()` 返回 disposer，不登记的话插件重挂
  // （Plugin Manager 禁用再启用、配置变更 re-apply）会留下旧路由 —— 再注册直接抛
  // `duplicate prefix route`，而真正生效的是旧 handler 的闭包（旧 settings/旧 ctx）。
  ctx.effect(() => ctx.webServer.register({
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
            result = { ok: true, value: await getState(ctx) };
            break;
          case 'measure': {
            const provider = body.payload && body.payload.provider;
            if (typeof provider !== 'string' || provider === '') {
              result = failure('provider-router/bad-request', 'provider is required');
              break;
            }
            result = { ok: true, value: await measureViaRouter(provider) };
            break;
          }
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
            // 页面把自己的 origin 传上来，好让 scheme 保留（loopback 上是 http、
            // tailnet 上是 https）。但**只采信与请求同 authority 的 origin** ——
            // 以前直接采信 payload.origin，于是任何同源脚本（含任何客户端插件）
            // 都能铸造 `https://evil.com/?token=<真 token>`；而进程 token 比
            // SameSite=Strict 的 cookie 更强（可跨 origin 用，直到重启）。
            const own = requestOrigin(req);
            const asked =
              body.payload && typeof body.payload.origin === 'string' && body.payload.origin
                ? body.payload.origin
                : null;
            let origin = own ?? 'http://127.0.0.1:3080';
            if (asked !== null && own !== null && sameAuthority(asked, own)) {
              origin = asked;
            } else if (asked !== null && own !== null) {
              console.log(
                `[dsh-provider-router] getToken：忽略不同源的 origin=${asked}（请求自身是 ${own}）`,
              );
            }
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
  }), 'dsh-provider-router: route');

  // Seed mode.json so the routing proxy and the Client agree from the start.
  // 只补**缺失**的键：用户显式选过 auto/direct/ssr 的不能被启动时覆盖
  // （以前是整表重写，理论上会把 auto 冲掉）。
  ctx.effect(() => {
    readModeFile()
      .then((modes) => writeModeFile(modes))
      .catch(() => {});
  }, 'dsh-provider-router: seed mode.json');
}
