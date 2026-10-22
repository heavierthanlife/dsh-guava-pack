#!/usr/bin/env node
/**
 * dsh-web-search-switch 的自检。
 *
 * 这个插件干的事很容易"看起来对、实际错"：
 *   · 把一个搜索 provider 钉给 seam，按偏好转发 —— 转发错了就是"永远走官方"，
 *     而表现只是"Tavily 好像没用"；
 *   · 把 Tavily 的响应映射成 seam 的 vocabulary —— 字段错位会让模型看到空来源；
 *   · 偏好文件读写出错 —— 用户切了但下次又变回去。
 *
 * 所以这里把三条都钉成断言。全程**不联网**：official/tavily 都注入假实现。
 *
 * 用法：node tools/tests/web-search-switch.mjs
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// DSH_HOME 必须在 import 之前设好：模块在加载时就把偏好文件路径定下来了。
const scratch = mkdtempSync(join(tmpdir(), 'wsw-'));
process.env.DSH_HOME = scratch;
mkdirSync(join(scratch, 'storages'), { recursive: true });

const mod = await import('../../plugins/dsh-web-search-switch/lib/index.js');

// ── 1. Tavily 响应映射 ──────────────────────────────────────────────────
console.log('\nTavily 响应映射');
const tavilyJson = {
  answer: '  DeepSeek released a new model.  ',
  results: [
    { url: 'https://a.example/1', title: 'A1', content: 'snippet a1', published_date: '2026-10-01T00:00:00Z' },
    { url: 'https://a.example/1', title: 'A1 dup', content: 'duplicate url' },
    { url: 'https://b.example/2', title: 'B2', content: 'snippet b2' },
    { title: 'no url', content: 'should be skipped' },
    { url: '', content: 'empty url' },
  ],
};
const mapped = mod.mapTavilyResponse(tavilyJson, { query: 'x', maxResults: 10 });
check('answer → content', mapped.content === 'DeepSeek released a new model.', mapped.content);
check('只保留有 url 的条目', mapped.sources.length === 2, mapped.sources.length);
check('同 url 去重', mapped.sources.filter((s) => s.url === 'https://a.example/1').length === 1);
check('title 保留', mapped.sources[0].title === 'A1');
check('content → snippet', mapped.sources[0].snippet === 'snippet a1');
check('published_date → publishedAt', mapped.sources[0].publishedAt === '2026-10-01T00:00:00Z');
check('truncated 恒 false（截断归 seam）', mapped.truncated === false);

const capped = mod.mapTavilyResponse(tavilyJson, { query: 'x', maxResults: 1 });
check('按 maxResults 截断', capped.sources.length === 1, capped.sources.length);

const none = mod.mapTavilyResponse({ results: [] }, { query: 'x' });
check('空结果不抛错且没有 content', none.sources.length === 0 && none.content === undefined);

const noAnswer = mod.mapTavilyResponse({ results: [{ url: 'https://c/1' }] }, { query: 'x' });
check('缺 title/snippet/publishedAt 时字段被省略（不编造）',
  noAnswer.sources[0].title === undefined && noAnswer.sources[0].snippet === undefined);

// ── 2. Tavily 请求体 ────────────────────────────────────────────────────
console.log('\nTavily 请求体');
const body1 = mod.buildTavilyRequest('hello', { query: 'hello', maxResults: 3 });
check('query 透传', body1.query === 'hello');
check('max_results 取 maxResults', body1.max_results === 3, body1.max_results);
check('max_results 有上限 20', mod.buildTavilyRequest('q', { query: 'q', maxResults: 999 }).max_results === 20);
check('没给 maxResults 时给默认 8', mod.buildTavilyRequest('q', { query: 'q' }).max_results === 8);
check('请求体里不含 api_key（key 由调用处单独注入，避免误打印）', body1.api_key === undefined);

// ── 3. 按偏好转发 ───────────────────────────────────────────────────────
console.log('\n按偏好转发');
const calls = [];
const fakeOfficial = { async search(req) { calls.push(['official', req.query]); return { sources: [{ url: 'https://official' }], truncated: false }; } };
const fakeTavily = async (req) => { calls.push(['tavily', req.query]); return { sources: [{ url: 'https://tavily' }], truncated: false }; };

const providerOfficial = mod.createSwitchProvider({ official: fakeOfficial, tavily: fakeTavily, getBackend: () => 'official' });
const providerTavily = mod.createSwitchProvider({ official: fakeOfficial, tavily: fakeTavily, getBackend: () => 'tavily' });

const providerId = providerOfficial.id;
check('provider id 是 switch（profile 要钉这个）', providerId === 'switch', providerId);
check('available() 恒 true（不可用要在 search 里报结构化错误）', providerOfficial.available() === true);

const r1 = await providerOfficial.search({ query: 'q1' });
check('official 偏好走官方', r1.sources[0].url === 'https://official' && calls.at(-1)[0] === 'official');
const r2 = await providerTavily.search({ query: 'q2' });
check('tavily 偏好走 Tavily', r2.sources[0].url === 'https://tavily' && calls.at(-1)[0] === 'tavily');
check('未知/缺失偏好回落官方（切错不会把搜索弄坏）',
  (await mod.createSwitchProvider({ official: fakeOfficial, tavily: fakeTavily, getBackend: () => 'nonsense' }).search({ query: 'q3' })).sources[0].url === 'https://official');

// ── 4. 偏好读写 ─────────────────────────────────────────────────────────
console.log('\n偏好读写');
check('默认官方（文件不存在时）', mod.readBackend() === 'official');
mod.writeBackend('tavily');
check('写入后读到 tavily', mod.readBackend() === 'tavily');
const statePath = mod.stateFile();
check('偏好文件落在 <DSH_HOME>/storages/', statePath === join(scratch, 'storages', 'web-search-switch.json'), statePath);
check('文件权限 0600', (statSync(statePath).mode & 0o777) === 0o600, (statSync(statePath).mode & 0o777).toString(8));

writeFileSync(statePath, '{ not json');
check('文件损坏时回落官方（不崩）', mod.readBackend() === 'official');
writeFileSync(statePath, JSON.stringify({ backend: 'weird' }));
check('非法 backend 值回落官方', mod.readBackend() === 'official');
let threw = false;
try { mod.writeBackend('nope'); } catch { threw = true; }
check('writeBackend 拒绝非法值', threw);

// ── 5. 与 pack / profile 的接线（防止"插件写好了但没挂上"）──────────────
console.log('\n接线检查');
const packPatch = readFileSync(join(PACK, 'cordis.patch.yml'), 'utf8');
check('pack patch 里挂了 web-search-switch',
  /- id: web-search-switch[\s\S]{0,80}plugins\/dsh-web-search-switch\/lib\/index\.js/.test(packPatch));
const pluginPatch = readFileSync(join(PACK, 'plugins', 'dsh-web-search-switch', 'cordis.patch.yml'), 'utf8');
check('子插件 patch 声明了 name', /name:\s*'dsh-web-search-switch'/.test(pluginPatch));
const installSrc = readFileSync(join(PACK, 'install.mjs'), 'utf8');
check('install.mjs 把插件文件纳入 REQUIRED', /dsh-web-search-switch\/lib\/index\.js/.test(installSrc));
const exampleSrc = readFileSync(join(PACK, 'config', 'cordis.patch.example.yml'), 'utf8');
check('分发模板把 web.searchProvider 钉成 switch',
  /- id: web[\s\S]{0,120}searchProvider: switch/.test(exampleSrc));
const clientSrc = readFileSync(join(PACK, 'plugins', 'dsh-web-search-switch', 'lib', 'client.js'), 'utf8');
check('client 半边走 window.__ModuleLoader__（不是 ESM import）',
  /__ModuleLoader__\.load/.test(clientSrc) && !/^\s*import\s/m.test(clientSrc));
check('client 注册 settings.section 槽', /slots\.register\(\{[\s\S]{0,120}settings\.section/.test(clientSrc));

// ── 6. searchProvider 钉住（pin.mjs）────────────────────────────────────
// 踩过的两个真实坑：
//   · profile patch 里"删除"一条覆盖不会可靠热回滚 → 回滚必须写目标值；
//   · 插件还没挂载就钉 switch → seam 立刻报 configured provider not registered。
console.log('\nsearchProvider 钉住');
const pinMod = await import('../../plugins/dsh-web-search-switch/lib/pin.mjs');

const t1 = pinMod.pinText('- id: agent-default-model\n  config:\n    provider: x\n', 'switch');
check('没有 web 块时追加', t1.how === 'appended' && /- id: web/.test(t1.text));
check('追加时带上 searchProvider 与 fetchProvider',
  /searchProvider: switch/.test(t1.text) && /fetchProvider: http/.test(t1.text));
check('追加后能读回 switch', pinMod.readSearchProvider(t1.text).value === 'switch');

const t2 = pinMod.pinText('- id: web\n  config:\n    searchProvider: deepseek-official\n    fetchProvider: http\n', 'switch');
check('已有块时只改值（rewritten）', t2.how === 'rewritten');
check('fetchProvider 保持不变', /fetchProvider: http/.test(t2.text));
check('改完读回 switch', pinMod.readSearchProvider(t2.text).value === 'switch');
check('目标值已满足时 no-op', pinMod.pinText(t2.text, 'switch').changed === false);

const t3 = pinMod.pinText('- id: web\n  config:\n    fetchProvider: http\n', 'switch');
check('有 web 块但缺 searchProvider 时补上', pinMod.readSearchProvider(t3.text).value === 'switch', t3.text);

// 真实文件操作（临时 DSH_HOME）
const fakeHome = mkdtempSync(join(tmpdir(), 'wsw-home-'));
mkdirSync(join(fakeHome, 'profiles', 'web'), { recursive: true });
const profileFile = join(fakeHome, 'profiles', 'web', 'cordis.patch.yml');
writeFileSync(profileFile, '- id: agent-default-model\n  config:\n    provider: x\n');
const pinResult = pinMod.pinSearchProvider(fakeHome, 'switch');
check('写入返回 changed + 备份', pinResult.changed === true && typeof pinResult.backup === 'string');
check('备份文件真实存在', existsSync(pinResult.backup));
check('写后文件能读回 switch', pinMod.currentSearchProvider(fakeHome).value === 'switch');
const again = pinMod.pinSearchProvider(fakeHome, 'switch');
check('第二次调用是幂等的（不重复备份）', again.changed === false);
const back = pinMod.pinSearchProvider(fakeHome, pinMod.OFFICIAL_PROVIDER_ID);
check('可以写回 deepseek-official（回滚靠写值，不靠删块）',
  back.changed === true && pinMod.currentSearchProvider(fakeHome).value === 'deepseek-official');
check('OFFICIAL/SWITCH 常量正确',
  pinMod.OFFICIAL_PROVIDER_ID === 'deepseek-official' && pinMod.SWITCH_PROVIDER_ID === 'switch');
rmSync(fakeHome, { recursive: true, force: true });

// ── 6b. 面板里填的 Tavily key（本机 0600 状态文件）──────────────────────
// 为什么要支持这条路径：环境变量只在进程启动时读一次，改 .bashrc 必须重启；
// 而"填个 key"这种小事不该逼用户重启 DSH。
console.log('\n面板 Tavily key');
check('导出了 writeStateFile / readStateFile',
  typeof mod.writeStateFile === 'function' && typeof mod.readStateFile === 'function');
mod.writeStateFile({ tavilyApiKey: 'tvly-test-123' });
check('key 写进状态文件后能读回', mod.readStateFile().tavilyApiKey === 'tvly-test-123');
mod.writeBackend('tavily');
check('切后端不会丢掉已保存的 key', mod.readStateFile().tavilyApiKey === 'tvly-test-123');
check('切后端后 backend 正确', mod.readBackend() === 'tavily');
mod.writeStateFile({ tavilyApiKey: undefined });
check('可以清除 key', mod.readStateFile().tavilyApiKey === undefined);
check('清除 key 后 backend 保持不变', mod.readBackend() === 'tavily');
mod.writeBackend('official');

const stateFileBody = readFileSync(join(scratch, 'storages', 'web-search-switch.json'), 'utf8');
check('key 不会出现在 backend 切换前的残留里（当前已清空）', !stateFileBody.includes('tvly-test-123'));

// ── 6b2. 可用性回落（缺 key 时不要整挂搜索）──────────────────────────────
// 原则：**只回落"配置缺失"，不吞真实故障**。后者静默换后端会让人以为 Tavily 有效。
console.log('\n可用性回落');
const okOfficial = { async search() { return { sources: [{ url: 'https://official' }], truncated: false }; } };
const failMissing = async () => { throw Object.assign(new Error('no key'), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }); };
const failUpstream = async () => { throw Object.assign(new Error('502'), { code: 'WEB_PROVIDER_ERROR' }); };

const notes = [];
const fbProvider = mod.createSwitchProvider({
  official: okOfficial,
  tavily: failMissing,
  getBackend: () => 'tavily',
  canFallback: async () => true,
  onFallback: (info) => notes.push(info),
});
const fbResult = await fbProvider.search({ query: 'q' });
check('缺 key 且官方可用 → 回落官方并返回结果', fbResult.sources[0].url === 'https://official');
check('回落被记账（面板可见）', notes.length === 1 && notes[0].from === 'tavily' && notes[0].to === 'official');
check('回落原因里带原始提示', /no key/.test(notes[0].reason));

const noFb = mod.createSwitchProvider({
  official: okOfficial, tavily: failMissing, getBackend: () => 'tavily', canFallback: async () => false,
});
let threwMissing = false;
try { await noFb.search({ query: 'q' }); } catch { threwMissing = true; }
check('官方也不可用时不回落，照实报错', threwMissing);

const upProvider = mod.createSwitchProvider({
  official: okOfficial, tavily: failUpstream, getBackend: () => 'tavily', canFallback: async () => true,
});
let threwUpstream = false;
try { await upProvider.search({ query: 'q' }); } catch (e) { threwUpstream = e.code === 'WEB_PROVIDER_ERROR'; }
check('上游故障**不**回落（不能假装 Tavily 成功）', threwUpstream);

// ── 6c. 挂载标记（CLI 靠它判断"运行中的 DSH 是否真的加载了插件"）──────────
// 踩过：bundles 列表里有插件 ≠ 进程已加载它。在"装好没重启"的窗口里钉 switch，
// 搜索会立刻 configured provider not registered。
console.log('\n挂载标记与 CLI 守卫');
const hostForMarker = readFileSync(join(PACK, 'plugins', 'dsh-web-search-switch', 'lib', 'index.js'), 'utf8');
check('插件 apply 会写 mounted 标记（含 pid）',
  /web-search-switch\.mounted\.json/.test(hostForMarker) && /pid: process\.pid/.test(hostForMarker));
const cliForMounted = readFileSync(join(PACK, 'tools', 'set-search-provider.mjs'), 'utf8');
check('CLI 用 mounted 标记 + 监听端口 pid 双重确认',
  /pluginMounted/.test(cliForMounted) && /listeningPid\(3080\)/.test(cliForMounted));
check('未挂载时 CLI 拒绝钉 switch（return 1）',
  /现在把 pin 钉成 switch 会让搜索立刻报错/.test(cliForMounted) && /return 1;/.test(cliForMounted));
check('未挂载时切后端只记偏好、不动 pin',
  /pin 先保持不动/.test(cliForMounted));

// ── 6d. 客户端/宿主版本握手 ─────────────────────────────────────────────
// 踩过的真实体验：client 走软链+HMR，改文件刷新就是新版；host 必须重启才换。
// 于是"面板上有输入框、点了毫无反应"——旧宿主静默忽略 tavilyApiKey。
// 现在宿主报 apiVersion，客户端低于它就直接说"要重启"，不再假装成功。
console.log('\n客户端/宿主版本握手');
check('宿主声明 apiVersion', typeof mod.HOST_API_VERSION === 'number' && mod.HOST_API_VERSION >= 2);
const clientSrc2 = readFileSync(join(PACK, 'plugins', 'dsh-web-search-switch', 'lib', 'client.js'), 'utf8');
check('客户端声明期望的宿主版本', /EXPECTED_HOST_API\s*=\s*2/.test(clientSrc2));
check('客户端在版本不足时给出"重启 DSH"的明确提示', /宿主端插件是旧版本/.test(clientSrc2) && /restart-dsh\.sh/.test(clientSrc2));
check('客户端在版本不足时禁用输入与保存按钮',
  /disabled: busy \|\| hostStale/.test(clientSrc2) && /hostStale \|\| !keyDraft\.trim\(\)/.test(clientSrc2));
check('保存逻辑里也有拦截（不只靠 disabled）',
  /state\.apiVersion < EXPECTED_HOST_API/.test(clientSrc2));

// ── 7. CLI 与接线 ───────────────────────────────────────────────────────
console.log('\nCLI 与接线');
const cliSrc = readFileSync(join(PACK, 'tools', 'set-search-provider.mjs'), 'utf8');
check('CLI 支持 status / official / tavily / switch / bypass',
  ['status', 'official', 'tavily', 'switch', 'bypass'].every((c) => cliSrc.includes(c)));
check('CLI 在插件未挂载时会拒绝直接钉 switch（防把搜索弄坏）',
  /插件还没挂载到运行中的 DSH/.test(cliSrc));
check('CLI 复用 pin.mjs（不重复实现）', /from '\.\.\/plugins\/dsh-web-search-switch\/lib\/pin\.mjs'/.test(cliSrc));
const hostSrc = readFileSync(join(PACK, 'plugins', 'dsh-web-search-switch', 'lib', 'index.js'), 'utf8');
check('面板 set 会顺手钉住 pin', /ensurePinnedToSwitch\(cctx\)/.test(hostSrc));
check('apply 时对已有的 tavily 偏好自愈 pin',
  /readBackend\(\) === 'tavily' && currentSearchProvider/.test(hostSrc));
check('provider id 与 pin 常量同源', /import \{[^}]*SWITCH_PROVIDER_ID/.test(hostSrc));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
