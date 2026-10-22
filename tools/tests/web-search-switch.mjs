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

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
