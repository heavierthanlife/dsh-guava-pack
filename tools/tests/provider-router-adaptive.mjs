#!/usr/bin/env node
/**
 * provider-router「自适应」的自检。
 *
 * ## 为什么要单独一套
 *
 * 这套逻辑回答的是"面板该显示哪几家、每家的开关到底生不生效、auto 选了谁"。
 * 判断错的代价很具体：
 *   · 漏掉一家 → 用户在面板上找不到它，以为插件不支持（本次就漂移过：7 家只显示 5 家）；
 *   · control 判错 → 用户去拨一个根本不生效的开关（比不显示更糟）；
 *   · auto 判错 → 流量被塞进慢路或被墙的路。
 *
 * 全部离线：不联网、不起路由代理、不依赖 Cordis。数据库是假的 ctx / 假的测量值。
 *
 * 用法：node tools/tests/provider-router-adaptive.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProviderCatalog,
  chooseAuto,
  resolveMode,
  resolveProviderRows,
  routerPrefixOf,
  normalizeMode,
  DEFAULT_MODES,
} from '../../plugins/provider-router/lib/auto-mode.mjs';
// host 侧纯函数（`normalizeModeFile` 必须保真 `auto`）。这个模块顶层只有常量与
// 函数定义（MODE_FILE 只是读 env），import 不会发起 IO，也不会起 Cordis。
import { normalizeModeFile } from '../../plugins/provider-router/lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

// ── 1. auto 决策 ────────────────────────────────────────────────────────
console.log('\nauto 决策（chooseAuto）');
const fast = { ok: true, ms: 100 };
const slow = { ok: true, ms: 900 };
const down = { ok: false, ms: 0 };
check('direct 明显快 → direct', chooseAuto(fast, slow).winner === 'direct');
check('SSR 明显快 → ssr', chooseAuto(slow, fast).winner === 'ssr');
check('只有 direct 通 → direct（另一边大概率被墙）', chooseAuto(fast, down).winner === 'direct');
check('只有 SSR 通 → ssr', chooseAuto(down, fast).winner === 'ssr');
check('两条都不通 → direct（不制造惊喜）', chooseAuto(down, down).winner === 'direct');
check('差距 < 50ms 视为平手 → direct（SSR 多一个故障点）',
  chooseAuto({ ok: true, ms: 200 }, { ok: true, ms: 220 }).winner === 'direct');
check('SSR 快了 60ms 就选 SSR', chooseAuto({ ok: true, ms: 260 }, { ok: true, ms: 200 }).winner === 'ssr');
check('决策带可读依据', /direct|SSR|不通/.test(chooseAuto(fast, slow).reason));

// ── 2. 模式解析 ────────────────────────────────────────────────────────
console.log('\n模式解析（resolveMode）');
check('显式 direct 原样返回', resolveMode('direct', 'x').resolved === 'direct');
check('显式 ssr 原样返回', resolveMode('ssr', 'x').resolved === 'ssr');
check('显式值 reason=explicit', resolveMode('ssr', 'x').reason === 'explicit');
const autoNoHit = resolveMode('auto', 'agentrouter');
check('auto 未实测 → 回落内置默认（agentrouter=ssr）', autoNoHit.resolved === DEFAULT_MODES.agentrouter);
check('auto 未实测 reason=default', autoNoHit.reason === 'default');
const autoHit = resolveMode('auto', 'agentrouter', { agentrouter: { winner: 'direct' } });
check('auto 有实测 → 用实测结论', autoHit.resolved === 'direct' && autoHit.reason === 'measured');
const unset = resolveMode(undefined, 'agentrouter');
check('未设置 → 保持旧行为（内置默认），不擅自 auto', unset.reason === 'default' && unset.resolved === DEFAULT_MODES.agentrouter);
check('未设置时 requested 显示 direct（面板标注"未设置"）', unset.requested === 'direct');
check('非法值按未设置处理', resolveMode('nonsense', 'xiaomi-token-plan-cn').reason === 'default');
check('normalizeMode 收敛非法值', normalizeMode('nonsense') === 'direct' && normalizeMode('auto') === 'auto');

// ── 3. baseURL → 本代理前缀 ────────────────────────────────────────────
// 这一条是"开关到底生不生效"的判据：判错会让用户拨一个假开关。
console.log('\nbaseURL → 代理前缀（routerPrefixOf）');
check('loopback:8318/agentrouter → agentrouter', routerPrefixOf('http://127.0.0.1:8318/agentrouter') === 'agentrouter');
check('带子路径也能取到前缀', routerPrefixOf('http://127.0.0.1:8318/agentrouter/v1') === 'agentrouter');
check('别的前缀各自独立', routerPrefixOf('http://127.0.0.1:8318/xiaomi-token-plan-cn') === 'xiaomi-token-plan-cn');
check('外部 https 不算经过代理', routerPrefixOf('https://opencode.ai/zen/v1') === undefined);
check('别的端口的 loopback 不算（桥接不是本代理）', routerPrefixOf('http://127.0.0.1:8317/v1') === undefined);
check('非法 URL 不抛错', routerPrefixOf('not a url') === undefined);

// ── 4. 目录合并（本次漂移的正面回归）────────────────────────────────────
console.log('\n供应商目录合并（buildProviderCatalog）');
const endpoints = {
  'xiaomi-token-plan-cn': { baseURL: 'http://127.0.0.1:8318/xiaomi-token-plan-cn' },
  'agentrouter': { baseURL: 'http://127.0.0.1:8318/agentrouter' },
  'agentrouter-responses': { baseURL: 'http://127.0.0.1:8318/agentrouter/v1' },
  'opencode': { baseURL: 'https://opencode.ai/zen/v1' },
  'commandcode': { baseURL: 'http://127.0.0.1:8317/v1' },
  'antigravity': { baseURL: 'http://127.0.0.1:8045' },
  'weird': { baseURL: 'http://127.0.0.1:8318/weird/v1' },
};
const catalog = buildProviderCatalog({
  live: [
    { id: 'xiaomi-token-plan-cn' },
    { id: 'agentrouter' },
    { id: 'agentrouter-responses' },   // ← 旧版面板漏掉的那家
    { id: 'opencode' },                // ← 旧版面板漏掉的另一家
  ],
  configurable: [{ provider: 'agentrouter-responses', displayName: 'AgentRouter (Responses)' }],
  defaults: DEFAULT_MODES,
  routerPrefixes: ['xiaomi-token-plan-cn', 'opencode-go', 'antigravity', 'agentrouter', 'commandcode'],
  endpoints,
});
const byId = Object.fromEntries(catalog.map((r) => [r.id, r]));
check('live + 可配置 + 兜底 全部出现', catalog.length === 7, catalog.map((r) => r.id));
check('旧版漏掉的 agentrouter-responses 现在出现', Boolean(byId['agentrouter-responses']));
check('旧版漏掉的 opencode 现在出现', Boolean(byId['opencode']));
check('agentrouter-responses 被判定为经过本代理（前缀取自 baseURL）',
  byId['agentrouter-responses'].control === 'router' && byId['agentrouter-responses'].prefix === 'agentrouter');
check('opencode 直连、不经过代理', byId['opencode'].control === 'direct');
check('antigravity 标为外部控制（不可拨）', byId['antigravity'].control === 'external');
check('commandcode 标为桥接控制（开关真生效）', byId['commandcode'].control === 'bridge');
check('前缀不在上游表 → router-missing-upstream（会 404，必须提示）',
  byId['weird'] ? byId['weird'].control === 'router-missing-upstream' : true);
check('live 的排在 dormant 前面', catalog.findIndex((r) => !r.live) > catalog.findIndex((r) => r.live));
check('显示名优先用 configurable 的 displayName',
  byId['agentrouter-responses'].name === 'AgentRouter (Responses)');

const noEndpoints = buildProviderCatalog({
  live: [{ id: 'agentrouter-responses' }],
  defaults: DEFAULT_MODES,
  routerPrefixes: ['agentrouter'],
  endpoints: {},
});
const mysteryRow = noEndpoints.find((r) => r.id === 'agentrouter-responses');
check('读不到 baseURL 时不瞎猜：标 unknown 并说明', mysteryRow.control === 'unknown' && /读不到/.test(mysteryRow.note));

const dormant = buildProviderCatalog({
  live: [{ id: 'agentrouter' }],
  configurable: [{ provider: 'opencode-go', displayName: 'OpenCode Go' }],
  defaults: DEFAULT_MODES,
  routerPrefixes: ['agentrouter', 'opencode-go'],
  endpoints: {},
});
const dormantRow = dormant.find((r) => r.id === 'opencode-go');
check('可配置但未注册 → live=false 且注明原因',
  dormantRow.live === false && dormantRow.configurable === true && /未注册/.test(dormantRow.note));

// ── 5. 接线检查（防止"逻辑写好了但没接上"）────────────────────────────
console.log('\n接线检查');
const hostSrc = readFileSync(join(PACK, 'plugins', 'provider-router', 'lib', 'index.js'), 'utf8');
const clientSrc = readFileSync(join(PACK, 'plugins', 'provider-router', 'lib', 'client.js'), 'utf8');
const routerSrc = readFileSync(join(PACK, 'plugins', 'provider-router', 'lib', 'router.mjs'), 'utf8');

check('host 从 ctx.llm 取 live / configurable',
  /listProviders/.test(hostSrc) && /listConfigurableProviders/.test(hostSrc));
check('host 从 profile 读 baseURL', /readProviderEndpoints/.test(hostSrc));
check('host 向路由代理自省', /_router\/state/.test(hostSrc) && /_router\/measure/.test(hostSrc));
check('host 声明 apiVersion（版本握手）', /HOST_API_VERSION/.test(hostSrc) && /apiVersion: HOST_API_VERSION/.test(hostSrc));
check('host 有 measure 端点', /case 'measure'/.test(hostSrc));
check('client 不再维护写死的 PROVIDERS 数组', !/var PROVIDERS = \[/.test(clientSrc));
check('client 从 state.providers 渲染', /state\.providers/.test(clientSrc));
check('client 三态循环 direct→ssr→auto', /var order = \['direct', 'ssr', 'auto'\]/.test(clientSrc));
check('client 有版本握手提示', /apiVersion < 2/.test(clientSrc) && /restart-dsh\.sh/.test(clientSrc));
check('client 有"实测"按钮', /measureNow/.test(clientSrc) && /LABELS\.measureNow/.test(clientSrc));

check('router 暴露自省端点', /parts\[0\] === '_router'/.test(routerSrc) && /action === 'state'/.test(routerSrc));
check('router 支持 measure', /action === 'measure'/.test(routerSrc));
check('router 未知前缀会列出已知前缀', /已知前缀/.test(routerSrc));
check('router 探活会真正发送请求（req.end）', /req\.end\(\);/.test(routerSrc));
check('router 的 auto 有 TTL 缓存', /DSH_ROUTER_AUTO_TTL_MS/.test(routerSrc));
check('router 不重复定义 DEFAULT_MODES（单一来源）',
  !/const DEFAULT_MODES = \{/.test(routerSrc));

// ── 6. routerKey：面板/宿主对"代理认的键"的映射 ────────────────────────
// 代理按**路径前缀**认供应商。profile 里 `agentrouter-responses` 的 baseURL 是
// `8318/agentrouter/v1`，代理只认 `agentrouter`；面板拿 id 去 measure/setMode
// 会得到 unknown provider、写进代理不读的键 —— 两条都是静默失效。
console.log('\nrouterKey 推导（代理认的键，不是 profile id）');
const rkCatalog = buildProviderCatalog({
  live: [{ id: 'agentrouter-responses', name: 'AgentRouter' }],
  configurable: [],
  routerPrefixes: ['agentrouter', 'commandcode'],
  endpoints: {
    'agentrouter-responses': { baseURL: 'http://127.0.0.1:8318/agentrouter/v1' },
    'opencode': { baseURL: 'https://opencode.ai/zen/v1' },
    'commandcode': { baseURL: 'http://127.0.0.1:8317/v1' },
  },
});
const rkById = Object.fromEntries(rkCatalog.map((r) => [r.id, r]));
check('经过本代理的行 → routerKey 取 baseURL 前缀（agentrouter-responses → agentrouter）',
  rkById['agentrouter-responses'].control === 'router' &&
  rkById['agentrouter-responses'].prefix === 'agentrouter' &&
  rkById['agentrouter-responses'].routerKey === 'agentrouter',
  rkById['agentrouter-responses']);
check('拿不到 baseURL 的历史行回落到 id（agentrouter）',
  rkById['agentrouter'].control === 'router' && rkById['agentrouter'].routerKey === 'agentrouter');
check('bridged 行 → routerKey 就是 id（commandcode）',
  rkById['commandcode'].control === 'bridge' && rkById['commandcode'].routerKey === 'commandcode');

const directCatalog = buildProviderCatalog({
  live: [{ id: 'opencode' }],
  endpoints: { 'opencode': { baseURL: 'https://opencode.ai/zen/v1' } },
});
const directRow = directCatalog.find((r) => r.id === 'opencode');
check('直连行 → control=direct 且 routerKey=id（opencode）',
  directRow.control === 'direct' && directRow.routerKey === 'opencode', directRow);

// ── 7. resolveProviderRows：解析结果必须以 routerKey 为键 ───────────────
console.log('\n解析结果的键（resolveProviderRows）');
const rkResolved = resolveProviderRows(rkCatalog, { agentrouter: 'ssr', commandcode: 'direct' }, {});
check('显式 ssr 按 routerKey 查到', rkResolved['agentrouter'].resolved === 'ssr');
check('显式值 reason=explicit', rkResolved['agentrouter'].reason === 'explicit');
check('桥接行也按 routerKey 查到（commandcode=direct）', rkResolved['commandcode'].resolved === 'direct');
check('resolved 里**没有** profile id 这个键（面板必须用 routerKey 查表）',
  !Object.prototype.hasOwnProperty.call(rkResolved, 'agentrouter-responses'),
  Object.keys(rkResolved));
const directResolved = resolveProviderRows(directCatalog, {}, {});
check('直连行按 id 查到（opencode，未设置走默认）',
  directResolved['opencode'].reason === 'default' && directResolved['opencode'].resolved === 'direct');

// ── 8. auto 保真：落盘不得把 auto 塌缩成静态默认值 ──────────────────────
// 代理侧 currentMode() 只有读到字符串 'auto' 才做双路实测；塌缩 = 自适应选路死掉。
console.log('\nauto 保真（normalizeModeFile）');
check('auto 原样保留（不被塌缩成 DEFAULT_MODES.agentrouter）',
  normalizeModeFile({ agentrouter: 'auto' })['agentrouter'] === 'auto');
check('非法值不得写入（回落内置默认）',
  normalizeModeFile({ agentrouter: 'bogus' })['agentrouter'] === DEFAULT_MODES.agentrouter);
const kept = normalizeModeFile({});
check('空输入仍包含全部内置默认键',
  Object.keys(DEFAULT_MODES).every((k) => kept[k] === DEFAULT_MODES[k]));
check('空输入不夹带额外键', Object.keys(kept).length === Object.keys(DEFAULT_MODES).length);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
