/**
 * 路由自适应的**纯逻辑**（无 IO、无 Cordis、无网络）。
 *
 * 单独一个文件的原因：这些判断要能被自检直接钉住，而
 *   · `lib/router.mjs` 是独立进程，一 import 就会 listen；
 *   · `lib/index.js` 需要 Cordis context。
 * 把"决策"与"执行"拆开，两边都能引用同一份规则，测试也不用起服务。
 *
 * @module provider-router/auto-mode
 */

/** 路由模式三态：`auto` 表示"每次决策前实测，取更快的那个"。 */
export const MODES = Object.freeze(['direct', 'ssr', 'auto']);

/**
 * 内置兜底模式。
 *
 * 历史上这是"唯一来源"（一次性测量后写死）—— 那正是漂移的来源：新增供应商
 * 不会进面板、`auto` 静默回落 direct。现在它只是**兜底**：
 * 真正的一等公民是 `ctx.llm.listProviders()` 给出的 live 目录。
 *
 * 数值来自 2026-10-04 实测（direct vs SSR 首字节），保留是为了"离线也有合理默认"。
 */
export const DEFAULT_MODES = Object.freeze({
  'xiaomi-token-plan-cn': 'direct',
  'opencode-go': 'direct',
  'antigravity': 'direct',
  'agentrouter': 'ssr',
  'commandcode': 'direct',
});

/**
 * 哪些供应商的模式**不是**由本代理执行（面板要标灰/说明）。
 *
 * 这张表是"事实"而非"配置"：它描述的是某家上游的请求到底由谁发出。
 *   bridge   — 本地桥接（读同一份 mode.json，所以开关**是真生效**的）
 *   external — 第三方反代自己控制出口，本插件改不了
 * 其余（未列出的）= 默认按 `router` 处理（baseURL 指向 127.0.0.1:8318）。
 */
export const CONTROL_OVERRIDES = Object.freeze({
  antigravity: 'external',
  commandcode: 'bridge',
});

/** 容错：把任意输入收敛到合法模式；`auto` 保留原样。 */
export function normalizeMode(value, fallback = 'direct') {
  return MODES.includes(value) ? value : fallback;
}

/**
 * 解析"该供应商实际怎么走"。
 *
 * @param {string|undefined} mode - mode.json 里存的模式（可能是 auto/未知）
 * @param {string} provider
 * @param {Record<string, {mode: string}>} [measured] - 最近一次 auto 实测结论
 * @returns {{ requested: string, resolved: string, reason: 'explicit'|'measured'|'default' }}
 */
export function resolveMode(mode, provider, measured = {}) {
  if (mode === 'auto') {
    // auto：有实测结论就用它，否则先按内置默认（**不阻塞请求**）。
    // 真正的测量发生在 router 侧（`/_router/measure` 或懒测），而不是这里 ——
    // 面板要能在"还没测"时也渲染出一个合理值。
    const hit = measured?.[provider];
    if (hit && (hit.winner === 'direct' || hit.winner === 'ssr')) {
      return { requested: 'auto', resolved: hit.winner, reason: 'measured' };
    }
    return { requested: 'auto', resolved: DEFAULT_MODES[provider] || 'direct', reason: 'default' };
  }
  if (mode === 'direct' || mode === 'ssr') {
    return { requested: mode, resolved: mode, reason: 'explicit' };
  }
  // 未设置/非法值：**保持旧行为**（按内置默认，通常是 direct）。
  //
  // 为什么不把它当成 auto：auto 会触发实测，而"新供应商第一次请求"是最不该
  // 多等 3 秒的时刻。面板会把这类行标成"默认"，用户想自适应再点一下即可。
  return { requested: 'direct', resolved: DEFAULT_MODES[provider] || 'direct', reason: 'default' };
}

/**
 * 从一次双路测量里挑赢家。
 *
 * 规则（刻意保守）：
 *   1. 只有一边成功 → 就它（另一边大概率被墙/被拒）；
 *   2. 两边都成功 → 取更快的；差距 < 50ms 视为平手，**选 direct**
 *      （SSR 多一跳、多一个故障点，没有收益就不引入）；
 *   3. 两边都失败 → direct（保持旧行为，不制造惊喜）。
 *
 * @param {{ok: boolean, ms?: number}|undefined} direct
 * @param {{ok: boolean, ms?: number}|undefined} ssr
 * @returns {{ winner: 'direct'|'ssr', reason: string }}
 */
export function chooseAuto(direct, ssr) {
  const d = direct && direct.ok === true && Number.isFinite(direct.ms) ? direct : undefined;
  const s = ssr && ssr.ok === true && Number.isFinite(ssr.ms) ? ssr : undefined;
  if (d && !s) return { winner: 'direct', reason: 'ssr 不可用' };
  if (s && !d) return { winner: 'ssr', reason: 'direct 不可用' };
  if (!d && !s) return { winner: 'direct', reason: '两条路都不通（回落 direct）' };
  if (s.ms < d.ms - 50) return { winner: 'ssr', reason: `SSR ${Math.round(s.ms)}ms 快于 direct ${Math.round(d.ms)}ms` };
  return { winner: 'direct', reason: `direct ${Math.round(d.ms)}ms 不慢于 SSR ${Math.round(s.ms)}ms` };
}

/**
 * 把三个来源合成面板的一等公民目录（去重、稳定排序）。
 *
 * 为什么必须"三源合并"：
 *   · live            —— 现在真的注册着的（用户马上能用）；
 *   · configurable    —— 可配置但休眠的（配了 key 才会变 live，面板也要能看见）；
 *   · defaults        —— 内置兜底（llm 服务缺失时的最后一道）。
 *
 * @param {object} input
 * @param {Array<{id:string,name?:string}>} [input.live]
 * @param {Array<{provider:string,displayName?:string}>} [input.configurable]
 * @param {Record<string,string>} [input.defaults]
 * @param {string[]} [input.routerPrefixes] - 路由代理承认的前缀（来自 /_router/state）
 * @param {Record<string, {baseURL?: string}>} [input.endpoints] - profile 里各家的 baseURL
 *        （决定"到底走不走本代理"，见 §control 推导）
 * @returns {Array<{id:string,name:string,live:boolean,configurable:boolean,control:string,prefix:string,routerKey:string,note:string}>}
 *   `routerKey` 是**路由代理与 mode.json 认的那个键**：经过本代理的行用 baseURL 里的
 *   前缀（例如 profile 的 `agentrouter-responses` 走 `8318/agentrouter/v1`，代理只认
 *   `agentrouter`），其余行就是 `id`。面板/宿主凡是要发 setMode/measure 或查
 *   mode/measurements，都必须用 `routerKey` —— 用 `id` 会让开关与实测静默失效。
 */
export function buildProviderCatalog({
  live = [],
  configurable = [],
  defaults = DEFAULT_MODES,
  routerPrefixes = [],
  endpoints = {},
}) {
  const byId = new Map();

  const ensure = (id) => {
    if (typeof id !== 'string' || id === '') return undefined;
    let row = byId.get(id);
    if (!row) {
      row = { id, name: id, live: false, configurable: false, control: 'router', prefix: '', note: '' };
      byId.set(id, row);
    }
    return row;
  };

  for (const item of configurable) {
    const row = ensure(item?.provider ?? item?.id);
    if (!row) continue;
    row.configurable = true;
    if (typeof item?.displayName === 'string' && item.displayName !== '') row.name = item.displayName;
  }
  for (const item of live) {
    const row = ensure(item?.id ?? item?.provider);
    if (!row) continue;
    row.live = true;
    if (typeof item?.name === 'string' && item.name !== '' && row.name === row.id) row.name = item.name;
  }
  for (const id of Object.keys(defaults ?? {})) ensure(id);

  const prefixes = new Set(routerPrefixes);
  for (const row of byId.values()) {
    const override = CONTROL_OVERRIDES[row.id];
    const baseURL = endpoints?.[row.id]?.baseURL;

    if (override === 'external') {
      row.control = 'external';
      row.note = '第三方反代控制出口，本插件改不了';
    } else if (override === 'bridge') {
      row.control = 'bridge';
      row.note = '本地桥接读同一份 mode.json，开关真生效';
    } else if (typeof baseURL !== 'string' || baseURL === '') {
      // 拿不到 baseURL（没有 profile 访问权限等）：老实标注"未判定"，
      // 不要凭 id 猜 —— 猜错会让用户去拨一个根本不生效的开关。
      if (prefixes.has(row.id)) {
        row.control = 'router';
      } else {
        row.control = 'unknown';
        row.note = '读不到该家的 baseURL，无法判定是否经过本代理';
      }
    } else {
      const prefix = routerPrefixOf(baseURL);
      if (prefix !== undefined) {
        row.prefix = prefix;
        if (prefixes.has(prefix)) {
          row.control = 'router';
        } else {
          // baseURL 指向本代理，但代理的上游表里没有这个前缀 → 请求会 404。
          // 这是**可诊断的真实故障**，必须让人看见修复动作。
          row.control = 'router-missing-upstream';
          row.note = `baseURL 指向本代理的前缀 /${prefix}，但上游表里没有它 → 请求会 404；` +
            '请在 plugins/provider-router/providers.json 补真实上游';
        }
      } else {
        row.control = 'direct';
        row.note = 'baseURL 不经过本代理（直连上游）';
      }
    }

    if (!row.live && row.configurable) {
      row.note = (row.note ? row.note + '；' : '') + '已配置但当前未注册（多半缺 key/未登录）';
    }

    // 路由代理只按**路径前缀**认供应商，mode.json / measurements 也用前缀做键。
    // 经过本代理的行：键就是 baseURL 里的前缀；拿不到 baseURL 时 prefix 为空串，
    // 必须回落到 id（历史行 `agentrouter` 就是这种）。其余行代理根本不读，键 = id。
    row.routerKey = row.control === 'router' || row.control === 'router-missing-upstream'
      ? (row.prefix || row.id)
      : row.id;
  }

  // 稳定排序：先 live，再按 id；避免面板顺序每次刷新都变。
  return [...byId.values()].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * 把目录里的每一行解析成"实际怎么走"，**以 routerKey 为键**。
 *
 * 为什么键必须是 routerKey 而不是 id：路由代理按路径前缀认供应商（mode.json 与
 * `/_router/state` 的 measurements 都用前缀作键）。`agentrouter-responses` 这种
 * 指向 `8318/agentrouter/v1` 的条目，用 id 去查永远是空 → 面板显示"未设置"、
 * 切 auto 看起来没反应。集中在这里算，host 与测试共用同一份规则。
 *
 * @param {Array<{id?:string, routerKey?:string}>} [providers] - buildProviderCatalog 的输出
 * @param {Record<string,string>} [modes] - mode.json（键是代理前缀）
 * @param {Record<string, {winner?: string}>} [measurements] - 代理侧的 auto 实测结论
 * @returns {Record<string, {requested:string, resolved:string, reason:string}>}
 */
export function resolveProviderRows(providers = [], modes = {}, measurements = {}) {
  const resolved = {};
  for (const row of providers) {
    const key = typeof row?.routerKey === 'string' && row.routerKey !== '' ? row.routerKey : row?.id;
    if (typeof key !== 'string' || key === '') continue;
    resolved[key] = resolveMode(modes[key], key, measurements);
  }
  return resolved;
}

/**
 * 从 baseURL 里抽出"本代理前缀"。
 *
 * 只有 `127.0.0.1:8318/<prefix>` 这种形状才算经过本代理；其余一律返回 undefined
 * （直连上游、或别的端口上的桥接）。
 *
 * @param {string} baseURL
 * @returns {string|undefined}
 */
export function routerPrefixOf(baseURL) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]';
  if (!loopback) return undefined;
  if (url.port !== '8318') return undefined;
  const first = url.pathname.split('/').filter(Boolean)[0];
  return first;
}
