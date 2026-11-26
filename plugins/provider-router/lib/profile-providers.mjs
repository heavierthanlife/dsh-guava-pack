/**
 * 从 profile 读"每家供应商的 baseURL"。
 *
 * ## 为什么需要它
 *
 * 面板要知道某家供应商**到底走不走本代理**。只看 id 猜是错的：
 *   · `opencode` 的 baseURL 是 `https://opencode.ai/zen/v1`（**直连**，不经过 8318）；
 *   · `agentrouter-responses` 的 baseURL 是 `127.0.0.1:8318/agentrouter/v1`
 *     （经过 8318，但前缀是 `agentrouter` 而不是它自己的 id）。
 * 猜错会让用户去拨一个根本不生效的开关 —— 比不显示更糟。
 *
 * ## 为什么直接读 profile 而不是问 `ctx.llm`
 *
 * `ctx.llm.listConfigurableProviders()` 给的是 `settingsNs` / `settingsPath`，
 * **不包含 baseURL**；`listProviders()` 只有 id/name。baseURL 只存在于 profile 的
 * `llm-pi-ai.config.providers.<id>.baseURL` 里，所以只能读文件。
 *
 * 解析用 DSH 自带的 `js-yaml`（经 pack 的统一解析层，四级回落）。拿不到 yaml 时
 * **返回 null**（调用方据此标 "未判定"），而不是抛错 —— 面板不能因为读不到配置就白屏。
 *
 * @module provider-router/profile-providers
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** profile patch 的默认位置。 */
export function profilePatchPath(dshHome) {
  return join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
}

/** 依次可能放着 js-yaml 的位置（pack 的统一解析层优先）。 */
const YAML_CANDIDATES = [
  // 真实位置：<pack>/tools/lib/yaml.mjs
  // （本文件在 <pack>/plugins/provider-router/lib/ 下，故回退三级到 pack 根）
  new URL('../../../tools/lib/yaml.mjs', import.meta.url).pathname,
];

/**
 * pi-ai 内置 catalog 的数据目录。
 *
 * profile 里没写 baseURL 的供应商（google / openrouter / nvidia …）并不是"没有 URL"，
 * 它们的默认端点一直记在 catalog 里。读这里才能给面板一个真实结论，
 * 而不是一句"未判定（读不到 baseURL）"。
 */
function catalogDataDir(dshHome) {
  return join(dshHome, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data');
}

/**
 * 从 pi-ai catalog 读该供应商的默认 `baseUrl` / `api`。
 *
 * 同一家供应商可能挂多套协议（例如 openrouter 同时有 `openai-completions` 与
 * `openrouter-images`），端点也未必唯一，所以取**出现次数最多的**那个；
 * 次数相同时取先遍历到的，保证结果稳定。
 *
 * @param {string} dshHome
 * @param {string} id 供应商 id
 * @returns {{baseURL:string, api?:string, source:'catalog'}|null}
 */
function catalogEndpoint(dshHome, id) {
  const file = join(catalogDataDir(dshHome), `${id}.json`);
  if (!existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const tally = new Map();
  for (const [api, models] of Object.entries(doc)) {
    if (!models || typeof models !== 'object') continue;
    for (const model of Object.values(models)) {
      const baseURL = model?.baseUrl;
      if (typeof baseURL !== 'string' || baseURL === '') continue;
      const hit = tally.get(baseURL) ?? { count: 0, api };
      hit.count += 1;
      tally.set(baseURL, hit);
    }
  }
  if (tally.size === 0) return null;
  const [baseURL, meta] = [...tally.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  return { baseURL, api: meta.api, source: 'catalog' };
}

async function loadYamlSafe() {
  for (const spec of YAML_CANDIDATES) {
    try {
      const mod = await import(spec);
      const yaml = await mod.loadYaml();
      if (yaml?.load) return yaml;
    } catch {
      /* 继续试下一个 */
    }
  }
  try {
    const mod = await import('js-yaml');
    const yaml = mod.default ?? mod;
    if (yaml?.load) return yaml;
  } catch {
    /* 没有就算了 */
  }
  return null;
}

/**
 * 读 profile 里 `llm-pi-ai.config.providers` 的 baseURL/api。
 *
 * profile 显式写了 baseURL → 以它为准（`source: 'profile'`）。
 * profile 没写 → 回落到 pi-ai catalog 的默认端点（`source: 'catalog'`）。
 * 两边都没有才留空，调用方据此标"未判定"。
 *
 * 为什么要回落：profile 只写 `apiKeyEnv` 不写 `baseURL` 是**正常写法**——端点由
 * pi-ai 的 catalog 提供。以前这里只看 profile，于是 google / openrouter / nvidia
 * 一律显示"未判定（读不到 baseURL）"，而 URL 其实好端端地存在 catalog 里。
 *
 * @param {string} dshHome
 * @returns {Promise<Record<string,{baseURL?:string,api?:string,source?:'profile'|'catalog'}>|null>}
 *          `null` = profile 本身读不到（调用方应标"未判定"，不要猜）
 */
export async function readProviderEndpoints(dshHome) {
  const file = profilePatchPath(dshHome);
  if (!existsSync(file)) return null;
  const yaml = await loadYamlSafe();
  if (!yaml) return null;
  let doc;
  try {
    doc = yaml.load(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(doc)) return null;
  const entry = doc.find((e) => e && e.id === 'llm-pi-ai');
  const providers = entry?.config?.providers;
  if (!providers || typeof providers !== 'object') return null;
  const out = {};
  for (const [id, cfg] of Object.entries(providers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const explicit = typeof cfg.baseURL === 'string' && cfg.baseURL !== '';
    const fallback = explicit ? null : catalogEndpoint(dshHome, id);
    out[id] = {
      ...(explicit ? { baseURL: cfg.baseURL, source: 'profile' } : fallback ?? {}),
      ...(typeof cfg.api === 'string' ? { api: cfg.api } : {}),
    };
  }
  return out;
}
