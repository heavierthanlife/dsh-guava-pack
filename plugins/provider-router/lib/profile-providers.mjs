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
  new URL('../../../tools/lib/yaml.mjs', import.meta.url).pathname,
];

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
 * @param {string} dshHome
 * @returns {Promise<Record<string,{baseURL?:string,api?:string}>|null>}
 *          `null` = 读不到（调用方应标"未判定"，不要猜）
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
    out[id] = {
      ...(typeof cfg.baseURL === 'string' ? { baseURL: cfg.baseURL } : {}),
      ...(typeof cfg.api === 'string' ? { api: cfg.api } : {}),
    };
  }
  return out;
}
