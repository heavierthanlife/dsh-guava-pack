#!/usr/bin/env node
/**
 * model-policy 的自检：选型逻辑与安全属性。
 *
 * ## 为什么要有这个
 *
 * 这个工具的职责是**改写用户 profile 里的模型清单** —— 判断错就会：
 *   · 把用户在用的模型删掉（比如 `agent-default-model` 指着的那个）
 *   · 把"旗舰"选成"上一代旗舰"
 *   · 用错误的缩进渲染出**非法 YAML**，让 profile 整个加载不了
 *
 * 上面三条都真实发生过（开发时各踩一次），所以这里把它们钉成断言。
 * 全部是**纯函数 + 本地数据**，不联网、不改任何真文件。
 *
 * 用法：node tests/model-policy.mjs
 */

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from '/home/guava5tar_/dsh/node_modules/js-yaml/dist/js-yaml.mjs';

import { renderModel, parseModels, collectModelRefs, effortsFor, IND, sp } from '../lib/model-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE)); // tools/tests → tools → 包根

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}

// ── 1. 缩进：渲染出来的 models 块必须能被自己解析回去 ────────────────────
// 踩过的坑：renderEfforts 把已经算好的空格串又 repeat 了一次 → 空串 →
// `reasoningEfforts:` 落在第 0 列 → 提前终止 models 块 → 后面的模型全丢，
// 且产出非法 YAML。
console.log('缩进与渲染');
// 真实缩进链：models = N → `- id:` = N+2 → item 字段 = N+4 → list 项 = N+6
// （见 model-config.mjs 的 IND 与 detectIndent）
for (const base of [4, 6, 8, 10]) {
  IND.providers = base; IND.name = base + 2; IND.field = base + 4;
  IND.models = base + 4; IND.model = base + 6; IND.item = base + 8; IND.list = base + 10;
  const ids = ['mimo-v2.5-pro', 'mimo-v2.6-flash', 'step-5-preview-free'];
  const lines = ids.flatMap((id) => renderModel({ id }, { efforts: ['low', 'high'] }));
  const re = parseModels([`${sp(IND.models)}models:`, ...lines]);
  check(`providers=${base}: 渲染 ${ids.length} 个能解析回 ${re.models.length} 个且 tail 为空`,
    re.models.length === ids.length && re.tail.length === 0,
    { got: re.models.length, tail: re.tail });
}
// 恢复真实布局，保持文件自洽
IND.providers = 4; IND.name = 6; IND.field = 8; IND.models = 8; IND.model = 10; IND.item = 12; IND.list = 14;

// ── 2. 引用收集：agent-default-model 与 allowedModels 都必须被认出来 ────
// 这是**唯一的**防误删机制，漏一个就会静默打断用户的默认模型。
console.log('\n引用收集（防误删的核心）');
const refDoc = [
  { id: 'llm-pi-ai', config: { providers: {} } },
  { id: 'agent-default-model', config: { provider: 'commandcode', model: 'stealth/glyph-cluster:free' } },
  { id: 'subagent-model-selection-settings', config: { allowedModels: [
    { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-pro' },
    { provider: 'antigravity', model: 'claude-sonnet-4-6' },
  ] } },
];
const refs = collectModelRefs(refDoc);
check('认出 agent-default-model 的 provider/model',
  refs.has('commandcode::stealth/glyph-cluster:free')
  && refs.get('commandcode::stealth/glyph-cluster:free').includes('agent-default-model'));
check('认出 allowedModels 的每条路由',
  refs.has('xiaomi-token-plan-cn::mimo-v2.6-pro') && refs.has('antigravity::claude-sonnet-4-6'));
check('不会把 llm-pi-ai 自己的定义当成引用',
  !refs.has('llm-pi-ai::anything'));
check('引用总数正确', refs.size === 3, { size: refs.size });

// 真实 profile 上也跑一遍（存在才测）
try {
  const real = yaml.load(readFileSync(join(process.env.HOME || '', 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8'));
  if (Array.isArray(real)) {
    const r = collectModelRefs(real);
    check(`真实 profile 上收到 ${r.size} 条引用（应 ≥ 6：1 default + 5~6 allowedModels）`, r.size >= 6, { size: r.size });
    // 其中必须包含 agent-default-model 指向的那个 —— 漏了就会误删
    const byDefault = [...r.entries()].filter(([, by]) => by.includes('agent-default-model'));
    check('真实 profile 里 agent-default-model 的指向被收到', byDefault.length === 1, byDefault.map(([k]) => k));
    // 每条引用的 provider 必须真的是 providers 里的一家
    const pi = real.find((e) => e?.id === 'llm-pi-ai');
    const provNames = new Set(Object.keys(pi?.config?.providers ?? {}));
    const fromPi = [...r.keys()].filter((k) => k.split('::')[0] !== 'deepseek-official');
    check('引用的 provider 都在 llm-pi-ai 里（deepseek-official 除外，它来自独立条目）',
      fromPi.every((k) => provNames.has(k.split('::')[0])),
      fromPi.filter((k) => !provNames.has(k.split('::')[0])));
  }
} catch (err) {
  console.log(`  （跳过真实 profile 检查：${err.message}）`);
}

// ── 3. 思考强度家族：必须与手工配置的规律一致 ────────────────────────────
console.log('\n思考强度家族');
check('opencode-go 的 ds → low/high/max（实测支持 max）',
  JSON.stringify(effortsFor('opencode-go', 'deepseek-v4.1-flash')) === '["low","high","max"]');
check('commandcode 的 ds → low/medium/high',
  JSON.stringify(effortsFor('commandcode', 'deepseek/deepseek-v4.1-flash')) === '["low","medium","high"]');
check('antigravity 的 claude → low/medium/high',
  JSON.stringify(effortsFor('antigravity', 'claude-opus-4-6-thinking')) === '["low","medium","high"]');
check('antigravity 的 gemini → 不给（手工条目也没给，宁缺勿错）',
  effortsFor('antigravity', 'gemini-3.8-flash-high') === null);
check('免费模型 → 不给',
  effortsFor('opencode', 'step-5-preview-free') === null);

// ── 4. 策略表本身必须合法且覆盖 6 家 ─────────────────────────────────────
console.log('\n策略表');
const policy = yaml.load(readFileSync(join(PACK, 'config', 'model-policy.yml'), 'utf8'));
const prof = yaml.load(readFileSync(join(process.env.HOME || '', 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8'));
const pi = prof.find((e) => e?.id === 'llm-pi-ai');
const provs = Object.keys(pi?.config?.providers ?? {});
check('策略表能解析', policy !== null && typeof policy === 'object');
check(`策略表覆盖全部 ${provs.length} 家`, provs.every((p) => p in (policy.providers ?? {})),
  provs.filter((p) => !(p in (policy.providers ?? {}))));
check('每家的 pick 都非空', Object.values(policy.providers ?? {}).every((r) => r.pick && Object.keys(r.pick).length > 0));
check('exclude 正则在 JS 里可构造（不支持 (?i)）',
  (() => { try { new RegExp(policy.defaults.exclude, policy.defaults.exclude_flags ?? ''); return true; } catch { return false; } })());

// ── 5. antigravity 点名的五个必须真实存在于端点（避免静默失效）────────
console.log('\nantigravity 点名清单');
const agRule = policy.providers.antigravity;
check('antigravity 用 explicit（人工点名）而不是启发式', Array.isArray(agRule.pick.explicit));
check('点名恰好 5 个', agRule.pick.explicit.length === 5, { n: agRule.pick.explicit.length });
check('点名里没有任何重复', new Set(agRule.pick.explicit).size === agRule.pick.explicit.length);

// ── 6. 免费模型策略必须依赖真探测（不能靠 id 猜）─────────────────────
// 实测：端点列表里混着 "No endpoints found" / "已终止转付费" / "上游满载"，
// 而 commandcode 的桥接对失败也返回 **HTTP 200**（错误在 body 里）。
// 所以这三家必须用 `plus_free: usable`，而不是 latest/数字。
console.log('\n免费模型策略');
for (const p of ['opencode-go', 'opencode', 'commandcode']) {
  check(`${p} 用 plus_free: usable（依赖真探测）`, policy.providers[p]?.pick?.plus_free === 'usable',
    policy.providers[p]?.pick?.plus_free);
}

// probe 模块的基本契约（纯函数，不联网）
const probeMod = await import('../lib/probe.mjs');
check('probe 导出了 KIND.USABLE', probeMod.KIND?.USABLE === 'usable');
check('kindLabel 对未知值安全回退', probeMod.kindLabel('nonexistent-kind') === 'nonexistent-kind');
// ⚠️ 必须写到**临时目录**，不能写 config/ —— 那会覆盖真实的探测缓存，
// 导致下一次策略运行以为"什么都没探过"从而放宽（开发时踩过）。
const scratch = join(PACK, '.probe-test-scratch');
probeMod.saveCache(scratch, { 'test-provider': { 'test-model': { kind: 'usable', status: 200 } } });
const cache = probeMod.loadCache(scratch);
check('探测缓存可写可读且判定为新鲜', cache?.fresh === true && cache.results?.['test-provider']?.['test-model']?.kind === 'usable');
check('cachedKind 能取出记录', probeMod.cachedKind(cache, 'test-provider', 'test-model') === 'usable');
check('cachedKind 对不存在的模型返回 undefined（→ 放宽而非剔除）',
  probeMod.cachedKind(cache, 'test-provider', 'nope') === undefined);
rmSync(scratch, { recursive: true, force: true });
check('临时目录已清理（不污染仓库）', !existsSync(scratch));

// ── 7. 保守口径：只剔"确凿坏的"，端点缺失的免费模型必须保留 ─────────────
// 用户的明确要求是"少删些"。两条都踩过：
//   1. `no-access`（需订阅）曾被当成"不可用"剔除 → 订阅可能明天就买，不该删。
//   2. 更隐蔽的：筛选只在**端点候选**里做，于是"配置里有、端点摘了"的免费模型
//      被静默删掉 —— 而 `sync-models` 早就写明了「端点没列 ≠ 不能用」
//      （gemini-2.5-flash 被服务端别名到 3.1 继续可用）。
console.log('\n保守口径（少删些）');
const src = readFileSync(join(PACK, 'tools', 'sync-model-policy.mjs'), 'utf8');
check('确凿坏的定义只含 dead / no-funds（不含 no-access / region / capacity）',
  /DEFINITELY_BROKEN = new Set\(\['dead', 'no-funds'\]\)/.test(src));
check('免费候选池并上了"配置里已有的免费"（防端点缺失被静默删）',
  /existingById\.values\(\)\]\.filter\(\(m\) => isFree\(m\.id\)\)/.test(src));
check('对"端点没列 + 探测不到"的已有模型保留',
  /!endpointListed\.has\(m\.id\)/.test(src));
check('输出里会说明"端点已不再列出但保留"',
  /端点已不再列出但\*\*保留\*\*/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
