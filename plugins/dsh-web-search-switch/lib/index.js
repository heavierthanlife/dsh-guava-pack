/**
 * dsh-web-search-switch — host 半边。
 *
 * ## 为什么需要它
 *
 * DSH 的搜索是可插拔的：`ctx.web` 是一层 capability seam，官方只发布了
 * **deepseek / exa / perplexity** 三个 provider（`@deepseek-ai/dsh-web-search-*`），
 * **没有 Tavily**。而 seam 的选择策略是：
 *
 *   · 配了 `searchProvider: <id>` → 必须用这个 id（没注册/不可用就报错）；
 *   · 没配 → 恰好一个可用 provider 才自动选中，两个可用就 `WEB_PROVIDER_AMBIGUOUS`。
 *
 * 这意味着"官方 + Tavily 都挂上、随便切"**没法靠配置实现** —— 两个都可用时
 * seam 直接报歧义，而 `searchProvider` 是**插件构造时读的**，改了要重启。
 *
 * 所以这里只注册**一个** provider（id = `switch`），把 `web.searchProvider`
 * 钉在它上面，再由它按运行时的偏好转发到某个真实后端：
 *
 *   · `official` → 直接复用官方包的 `DeepSeekSearchProvider`（同一个类，零复制）
 *   · `tavily`   → 直接 POST `https://api.tavily.com/search`
 *
 * 偏好存在 `<DSH_HOME>/storages/web-search-switch.json`，**每次搜索热读**，
 * 所以切换是"立即生效"，不需要重启 DSH、不需要改 profile。
 *
 * ## 为什么复用官方 provider 而不是自己实现 DeepSeek 搜索
 *
 * 官方那份是"用一次 Messages 调用 + 原生 `web_search_20250305` server tool"
 * 实现的，涉及响应块解析、citation 拼接、鉴权优先级（账号 token > API key）。
 * 自己抄一遍 = 复制一份会随上游漂移的协议代码。`DeepSeekSearchProvider` 是
 * **公开导出**的类，构造它只要一个 options thunk，所以直接实例化即可。
 *
 * 取舍（如实记录）：账号 token（`deepseek-account` 登录态）那条路径依赖官方
 * 插件内部的 initiator 判断，这里没有复刻，因此官方后端走 **API key**。
 * 需要账号态的搜索时把 `searchProvider` 切回 `deepseek-official` 即可。
 *
 * @module dsh-web-search-switch
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Cordis 插件名（loader 诊断用）。 */
const name = 'web-search-switch';

/** 我们注册进 `ctx.web` 的 provider id —— `web.searchProvider` 要钉成它。 */
const PROVIDER_ID = 'switch';

/** 面板 / 命令与 host 的通道路径。 */
const ROUTE_PATH = '/web-search-switch';

/** 偏好文件：`{ backend: 'official' | 'tavily' }`。 */
const STATE_FILE_NAME = 'web-search-switch.json';

const BACKENDS = ['official', 'tavily'];

const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');

/** 偏好文件绝对路径。 */
function stateFile() {
  return join(DSH_HOME, 'storages', STATE_FILE_NAME);
}

/* ------------------------------------------------------------------ *
 * 偏好读写（热读，带 1 次 stat 的缓存）
 * ------------------------------------------------------------------ */

let cached = { key: '', backend: 'official' };

/**
 * 读当前偏好的后端。
 *
 * 每次搜索都会调用，所以只 stat 一次；文件没变就直接用缓存值。
 *
 * 缓存键必须同时包含 **mtime 与 size**：只比 mtime 时，"同一毫秒内写入两个不同
 * 内容"（自检里连续写就会发生）会被当成"没变"，于是改了偏好却读回旧值 —— 这是
 * 自检抓到过的真实 bug，不是理论问题。
 *
 * 文件缺失/损坏/取值非法时回落 `official`：默认后端永远是"能用的那个"，
 * 偏好文件坏掉不该把搜索功能一起弄坏。
 */
function readBackend() {
  const file = stateFile();
  try {
    const st = statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    if (key === cached.key) return cached.backend;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const backend = BACKENDS.includes(parsed?.backend) ? parsed.backend : 'official';
    cached = { key, backend };
    return backend;
  } catch {
    cached = { key: '', backend: 'official' };
    return 'official';
  }
}

/** 写偏好。`0600` —— 里面目前只有偏好，但将来可能放 key 引用。 */
function writeBackend(backend) {
  if (!BACKENDS.includes(backend)) throw new Error(`未知搜索后端：${backend}`);
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ backend, updatedAt: new Date().toISOString() }, null, 2) + '\n', {
    mode: 0o600,
  });
  cached = { key: '', backend };
  return backend;
}

/* ------------------------------------------------------------------ *
 * 凭证解析
 * ------------------------------------------------------------------ */

/**
 * 解析一个凭据引用（`*_API_KEY`）：先问 credentials 服务，再回落进程环境。
 *
 * 与官方 provider 同一套顺序。**注意不要把值写进日志/错误文案**。
 */
async function resolveSecret(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref);
      if (resolved?.value) return resolved.value;
    } catch {
      /* 回落 */
    }
  }
  const ambient = process.env[ref];
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined;
}

/* ------------------------------------------------------------------ *
 * Tavily 后端
 * ------------------------------------------------------------------ */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

/** Tavily 的 key 引用名（与官方各 provider 的 `apiKeyEnv` 风格一致）。 */
const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY';

/**
 * 把 Tavily 的响应体映射成 seam 的 `WebSearchResult`。
 *
 * 纯函数，导出是为了自检能直接钉死映射规则（不联网）。
 *
 * Tavily 的字段与 seam 的差异：
 *   · `answer`（可选）→ `content`；Tavily 没开 `include_answer` 时没有
 *   · `results[].content` 是**正文摘录**→ `snippet`
 *   · `results[].published_date` → `publishedAt`（Tavily 只在 news 主题给）
 *   · `truncated` 恒 false：截断由 seam 统一做（provider 不该自己撒谎）
 */
export function mapTavilyResponse(json, request) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const limit = Number.isFinite(request?.maxResults) && request.maxResults > 0
    ? Math.floor(request.maxResults)
    : results.length;
  const sources = [];
  const seen = new Set();
  for (const item of results) {
    if (!item || typeof item.url !== 'string' || item.url.length === 0) continue;
    if (seen.has(item.url)) continue; // Tavily 偶发同 url 多条
    seen.add(item.url);
    sources.push({
      url: item.url,
      ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
      ...(typeof item.content === 'string' && item.content.length > 0 ? { snippet: item.content } : {}),
      ...(typeof item.published_date === 'string' && item.published_date.length > 0
        ? { publishedAt: item.published_date }
        : {}),
    });
    if (sources.length >= limit) break;
  }
  // answer 要去掉首尾空白：它会原样进模型上下文，前后空白只是噪音。
  const answerRaw = typeof json?.answer === 'string' ? json.answer.trim() : '';
  const answer = answerRaw.length > 0 ? answerRaw : undefined;
  return {
    ...(answer === undefined ? {} : { content: answer }),
    sources,
    truncated: false,
  };
}

/** 组装 Tavily 的请求体（导出给自检用）。 */
export function buildTavilyRequest(query, request) {
  const limit = Number.isFinite(request?.maxResults) && request.maxResults > 0
    ? Math.min(Math.floor(request.maxResults), 20)
    : 8;
  return {
    query,
    max_results: limit,
    search_depth: 'basic',
    include_answer: 'basic',
    /* Tavily 允许把它放在 body 里；新版也接受 Authorization: Bearer。两个都给，兼容期更稳。 */
    topic: 'general',
  };
}

/**
 * 调 Tavily。
 *
 * 失败语义要和 seam 的约定一致：**能给出结构化错误就抛带 `code` 的 Error**，
 * 让上层（工具）把它路由成 `WEB_PROVIDER_ERROR`。文案要能直接告诉用户去配什么。
 */
async function tavilySearch(ctx, request, signal) {
  const apiKey = await resolveSecret(ctx, TAVILY_API_KEY_ENV);
  if (!apiKey) {
    throw Object.assign(
      new Error(
        `Tavily 后端没有 key：请导出 ${TAVILY_API_KEY_ENV}（~/.bashrc 或 DSH 凭证库），` +
        `或在设置 → 搜索后端里切回「官方」。`,
      ),
      { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' },
    );
  }
  const body = { ...buildTavilyRequest(request.query, request), api_key: apiKey };
  let res;
  try {
    res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw Object.assign(new Error(`Tavily 请求失败：${String(err?.message ?? err)}`), {
      code: 'WEB_PROVIDER_ERROR',
    });
  }
  const text = await res.text();
  if (!res.ok) {
    // 不要把 key 或整个 body 回显出去；只留状态码 + 上游的短错误消息。
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      detail = String(parsed?.detail ?? parsed?.error ?? parsed?.message ?? '').slice(0, 200);
    } catch {
      detail = text.slice(0, 120);
    }
    throw Object.assign(
      new Error(`Tavily HTTP ${res.status}${detail ? `：${detail}` : ''}`),
      { code: res.status === 401 || res.status === 403 ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR' },
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Tavily 返回了非 JSON 响应'), { code: 'WEB_PROVIDER_ERROR' });
  }
  return mapTavilyResponse(json, request);
}

/* ------------------------------------------------------------------ *
 * 官方后端：直接复用官方包的类
 * ------------------------------------------------------------------ */

const DEEPSEEK_SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL';

/**
 * 造一个官方 DeepSeek provider 实例。
 *
 * 与官方 `apply()` 里的 `resolveOptions` 同一套默认值与优先级，只是省掉了
 * 账号 token 与 session 事件记录（见模块注释里的取舍说明）。
 */
async function createOfficialBackend(ctx) {
  const mod = await import('@deepseek-ai/dsh-web-search-deepseek');
  const DeepSeekSearchProvider = mod.DeepSeekSearchProvider;
  if (typeof DeepSeekSearchProvider !== 'function') {
    throw new Error('@deepseek-ai/dsh-web-search-deepseek 没有导出 DeepSeekSearchProvider');
  }
  const apiKeyEnv = 'DEEPSEEK_API_KEY';
  return new DeepSeekSearchProvider(() => ({
    resolveApiKey: () => resolveSecret(ctx, apiKeyEnv),
    apiKeyEnv,
    baseURL: process.env[DEEPSEEK_SEARCH_BASE_URL_ENV]
      ?? mod.DEEPSEEK_DEFAULT_BASE_URL
      ?? 'https://api.deepseek.com/anthropic/v1',
    model: mod.DEEPSEEK_DEFAULT_MODEL ?? 'deepseek-v4-flash',
    apiVersion: mod.DEEPSEEK_DEFAULT_API_VERSION ?? '2023-06-01',
    maxTokens: mod.DEEPSEEK_DEFAULT_MAX_TOKENS ?? 4096,
    maxUses: mod.DEEPSEEK_DEFAULT_MAX_USES ?? 5,
  }));
}

/* ------------------------------------------------------------------ *
 * provider 本体
 * ------------------------------------------------------------------ */

/**
 * 造 `ctx.web` 的 search provider。导出是为了自检能在不挂载 Cordis 的情况下
 * 验证"按偏好转发"这条核心行为。
 */
export function createSwitchProvider({ official, tavily, getBackend = readBackend }) {
  return {
    id: PROVIDER_ID,
    /* 自身永远"可用"：真正不可用的情况由后端在 search() 里报结构化错误，
       否则 seam 会在选择阶段就把调用拒掉，用户看不到"该怎么配"的提示。 */
    available: () => true,
    async search(request, signal) {
      const backend = getBackend();
      if (backend === 'tavily') return tavily(request, signal);
      return official.search(request, signal);
    },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP 路由（面板用）
 * ------------------------------------------------------------------ */

function sendRpc(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
}

async function readJsonBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 当前状态：偏好 + 两个后端是否配好（只报有无，绝不回显 key）。 */
async function readState(ctx) {
  const credentialsAvailable = ctx.get('credentials') !== undefined;
  const officialKey = await resolveSecret(ctx, 'DEEPSEEK_API_KEY');
  const tavilyKey = await resolveSecret(ctx, TAVILY_API_KEY_ENV);
  return {
    backend: readBackend(),
    backends: [
      {
        id: 'official',
        label: '官方 DeepSeek',
        configured: officialKey !== undefined,
        hint: officialKey !== undefined ? '' : '未找到 DEEPSEEK_API_KEY',
      },
      {
        id: 'tavily',
        label: 'Tavily',
        configured: tavilyKey !== undefined,
        hint: tavilyKey !== undefined ? '' : `未找到 ${TAVILY_API_KEY_ENV}`,
      },
    ],
    credentialsAvailable,
    providerId: PROVIDER_ID,
    // `searchProviderId` 在官方 d.ts 里是 private，但 JS 运行时是普通字段。
    // 读不到（未来版本改名/加密）时给 `undefined` 而不是 `false` —— 免得面板
    // 误报"没钉住"。只有确定读到且不等于 switch 才判 false。
    pinned: (() => {
      const pinnedId = ctx.get('web')?.searchProviderId;
      return typeof pinnedId === 'string' ? pinnedId === PROVIDER_ID : undefined;
    })(),
  };
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/** 只依赖 web seam；commands / webServer 用 `ctx.inject` 按需拿。 */
const inject = ['web'];

async function apply(ctx) {
  const official = await createOfficialBackend(ctx).catch((err) => {
    // 官方包缺失也不该把整个插件弄挂：把错误留到真正用官方后端时再报。
    return {
      search: async () => {
        throw Object.assign(
          new Error(`官方搜索后端不可用：${String(err?.message ?? err)}`),
          { code: 'WEB_PROVIDER_UNAVAILABLE' },
        );
      },
    };
  });
  const provider = createSwitchProvider({
    official,
    tavily: (request, signal) => tavilySearch(ctx, request, signal),
  });

  ctx.effect(() => ctx.web.registerSearchProvider(provider), 'web-search-switch provider');

  // ── `/search-backend` 命令：不打开设置页也能切 ──────────────────────
  ctx.inject(['commands'], (cctx) => {
    let definitionId = 'web-search-switch';
    cctx.effect(function* () {
      let id = definitionId;
      try {
        const brand = yield import('@deepseek-ai/dsh-commands/brand');
        id = brand.CommandDefinitionId('web-search-switch');
      } catch {
        /* 用字符串兜底 */
      }
      yield cctx.commands.register({
        definitionId: id,
        name: 'search-backend',
        description: '查看或切换联网搜索后端（official / tavily）',
        handler: async (invocation) => {
          const arg = String(invocation?.rawInput ?? '').trim().toLowerCase();
          if (arg === '' || arg === 'status') {
            const state = await readState(cctx);
            return {
              kind: 'success',
              text: [
                `当前搜索后端：**${state.backend}**`,
                ...state.backends.map((b) => `· ${b.label}：${b.configured ? '已配置' : `未配置（${b.hint}）`}`),
                '',
                '切换：`/search-backend official` 或 `/search-backend tavily`',
              ].join('\n'),
            };
          }
          if (!BACKENDS.includes(arg)) {
            return { kind: 'error', text: `未知后端「${arg}」。可选：official / tavily` };
          }
          writeBackend(arg);
          return { kind: 'success', text: `已切换到 **${arg}**（下一次搜索立即生效，无需重启）` };
        },
      });
    }, 'web-search-switch command');
  });

  // ── 设置面板用的路由 ────────────────────────────────────────────────
  ctx.inject(['webServer', 'connection'], (cctx) => {
    // 必须挂 effect：`webServer.register()` 返回的 disposer 不登记的话，插件重挂
    // （Plugin Manager 禁用再启用）会抛 `duplicate prefix route`。
    cctx.effect(() => cctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        let rpcId = 'invalid-request';
        try {
          const rejection = cctx.connection.requestRejection({ headers: req.headers });
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
          const endpoint = pathname.startsWith(`${ROUTE_PATH}/`) ? pathname.slice(ROUTE_PATH.length + 1) : '';
          const body = await readJsonBody(req);
          if (body && typeof body.rpcId === 'string') rpcId = body.rpcId;
          if (!endpoint || !body || body.type !== 'client-request' || body.method !== endpoint) {
            sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request envelope' } });
            return;
          }
          if (endpoint === 'state') {
            sendRpc(res, rpcId, { ok: true, value: await readState(cctx) });
            return;
          }
          if (endpoint === 'set') {
            const backend = body.payload?.backend;
            if (!BACKENDS.includes(backend)) {
              sendRpc(res, rpcId, { ok: false, error: { code: 'switch/bad-backend', message: `未知后端：${String(backend)}` } });
              return;
            }
            writeBackend(backend);
            sendRpc(res, rpcId, { ok: true, value: await readState(cctx) });
            return;
          }
          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/not-found', message: `no such method: ${endpoint}` } });
        } catch (error) {
          sendRpc(res, rpcId, { ok: false, error: { code: 'switch/failed', message: String(error?.message ?? error) } });
        }
      },
    }), 'web-search-switch route');
  });
}

export { apply, inject, name, PROVIDER_ID, ROUTE_PATH, BACKENDS, readBackend, writeBackend, stateFile };
export default { apply, inject, name };
