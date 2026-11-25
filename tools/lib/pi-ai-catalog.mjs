/**
 * pi-ai 内置目录里的 provider 默认 baseURL。
 *
 * ## 为什么需要这一层
 *
 * 有些供应商**在 profile 里不写 `baseURL`** —— 因为 `@deepseek-ai/dsh-llm-pi-ai`
 * 运行时本来就会回落到 `@earendil-works/pi-ai` 内置目录里的默认地址：
 *
 *     const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl
 *     （dsh-llm-pi-ai/lib/index.js，resolveRouteModels）
 *
 * 于是 profile 里只有 `openrouter:` / `nvidia:` 这些**光秃秃的 provider 名**，
 * 却照样连得上 —— 地址藏在 pi-ai 的 `dist/providers/*.js` 里。
 *
 * 问题出在工具侧：`sync-model-policy` / `sync-models` 只看 profile 的 `baseURL`，
 * 没有就打印「没声明 baseURL，只能用现有清单」然后**跳过探测**。
 * 结果这两家的模型清单永远靠"现有清单"推断，端点早换了也不知道。
 * 而且这句提示会让人以为"系统里根本没有这个地址"。
 *
 * ## 解析顺序（与运行时一致）
 *
 *   1. `<DSH_HOME>/node_modules/@earendil-works/pi-ai/dist/providers/all.js`
 *   2. `<HOME>/dsh/node_modules/...`（DSH_HOME 未设时的默认家）
 *
 * 用绝对文件路径 import，绕开 `exports` 映射（该子路径没在 exports 里）。
 * 拿不到就返回 `undefined`，调用方按"没声明"处理 —— 这里是**增强**，
 * 不能让一次目录重构把整个工具打成崩。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const homes = () => {
  const list = []
  if (process.env.DSH_HOME) list.push(process.env.DSH_HOME)
  if (process.env.HOME) list.push(join(process.env.HOME, 'dsh'))
  return [...new Set(list)]
}

/** provider 目录只加载一次：里面是 40 个模块，重复 import 会白白多花上百毫秒。 */
let cache

/** 返回 `Map<providerId, provider>`，拿不到就是空 Map。 */
export async function piAiProviders() {
  if (cache !== undefined) return cache
  cache = new Map()
  for (const home of homes()) {
    const file = join(home, 'node_modules/@earendil-works/pi-ai/dist/providers/all.js')
    if (!existsSync(file)) continue
    try {
      const mod = await import(pathToFileURL(file).href)
      for (const provider of mod.builtinProviders()) cache.set(provider.id, provider)
    } catch {
      // 上游改了目录结构 → 当作"没有目录"，调用方照旧跳过探测。
    }
    break
  }
  return cache
}

/**
 * 某家 provider 在 pi-ai 目录里的默认 baseURL。
 * @param providerName - profile 里 `llm-pi-ai.providers` 的键
 * @returns 默认地址；不在目录里（自定义网关）或读不到目录时 `undefined`
 */
export async function catalogBaseUrl(providerName) {
  const providers = await piAiProviders()
  return providers.get(providerName)?.baseUrl
}
