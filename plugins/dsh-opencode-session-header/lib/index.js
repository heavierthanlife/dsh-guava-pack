/**
 * dsh-opencode-session-header — per-conversation `x-opencode-session`
 * injection for OpenCode Go, scoped strictly to opencode.ai hosts.
 *
 * Why: OpenCode Go rejects inference requests without `x-opencode-session`
 * (400 MissingSessionID) and uses a stable per-conversation id for routing
 * and prompt-cache optimization. DSH 0.1.2-rc.1 sends no such header on any
 * adapter path, so this plugin stamps it at the fetch transport layer:
 *
 *   - `llm/stream` waterfall observer wraps every adapter stream iteration in
 *     AsyncLocalStorage carrying `GenerateOptions.sessionId` (stable per DSH
 *     conversation; fresh per conversation / fork / subagent).
 *   - a fetch middleware stamps `x-opencode-session` ONLY when the request
 *     host matches the allowlist (default: opencode.ai + subdomains); every
 *     other host passes through byte-for-byte untouched.
 *   - runtime switch: `$DSH_HOME/plugins/dsh-opencode-session-header.json`
 *     `{"enabled": false}` disables injection. The file is re-read per LLM
 *     request (no restart needed); a missing file means enabled.
 *
 * Fetch-pipeline mechanics vendored from @aizigao/pi-fetch-pipeline v1.0.1
 * (MIT, via dsh-custom-header), re-keyed under this plugin's own symbol so
 * coexisting plugins never clobber each other's middleware chains.
 *
 * ## 本副本的改动（dsh-guava-pack，2026-10-28；上游 v0.1.0 + 本地补丁）
 *
 * 上游只认 **hostname**（opencode.ai），但这套 profile 把 `opencode-go` 的
 * baseURL 指到本机路由代理 `http://127.0.0.1:8318/opencode-go`，于是出站请求的
 * hostname 永远是 127.0.0.1 —— 上游规则**永远匹配不上**，插件对主用路由完全空转，
 * 而 profile 里只能靠一条硬编码的静态 UUID 顶着（所有会话共用一个 id，丢掉
 * 上游按会话做的路由亲和与前缀缓存）。
 *
 * 所以这里加一条**只对 loopback 生效**的补充规则：hostname 是本机回环地址时，
 * 再按**路径首段**匹配（默认只认 `opencode-go`，与 profile 的 baseURL 前缀同名）。
 * 其它本地前缀（agentrouter / xiaomi-token-plan-cn / 8317 桥接）一律不打头；
 * 路径首段必须整段相等，`/opencode-goo` 这种lookalike 不匹配。
 * 需要关掉这条补充规则时，挂载配置传 `loopbackPrefixes: []` 即可。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name (the Loader entry). */
export const name = 'dsh-opencode-session-header'

/** Services required before load: none — llm/stream is an optional observer. */
export const inject = []

/** Carries the DSH session id across one llm/stream call. */
export const requestSessionContext = new AsyncLocalStorage()

const HEADER_NAME = 'x-opencode-session'
const DEFAULT_HOSTS = ['opencode.ai']
const DEFAULT_FALLBACK = 'dsh-default'

/**
 * 本副本新增：经本机路由代理转发时仍要打头（见文件头「本副本的改动」）。
 *
 * 只按**路径首段**匹配，不做字符串前缀匹配 —— `/opencode-goo/...` 不是
 * `/opencode-go/...`，后者打头会让代理把请求路由到不存在的上游前缀。
 */
const DEFAULT_LOOPBACK_PREFIXES = ['opencode-go']

// ---------------------------------------------------------------------------
// fetch pipeline (mechanics vendored from @aizigao/pi-fetch-pipeline v1.0.1,
// MIT, via dsh-custom-header; re-keyed so coexisting plugins never clobber)
// ---------------------------------------------------------------------------

const FETCH_PIPELINE_KEY = Symbol.for('dsh-opencode-session-header.fetch.pipeline.v1')

function ensureFetchPipeline() {
	const g = globalThis
	if (g[FETCH_PIPELINE_KEY]) return g[FETCH_PIPELINE_KEY]
	let underlyingFetch = globalThis.fetch
	const state = {
		getUnderlyingFetch: () => underlyingFetch,
		setUnderlyingFetch: (nextFetch) => {
			underlyingFetch = nextFetch
		},
		middlewares: [],
		installed: false,
		patchedFetch: undefined,
	}
	g[FETCH_PIPELINE_KEY] = state
	return state
}

function compose(state) {
	const ordered = [...state.middlewares].sort((a, b) => a.priority - b.priority)
	const callAt = (index, input, init) => {
		if (index >= ordered.length) return state.getUnderlyingFetch()(input, init)
		const current = ordered[index]
		return current.middleware({
			input,
			init,
			next: (nextInput, nextInit) => callAt(index + 1, nextInput, nextInit),
		})
	}
	return (input, init) => callAt(0, input, init)
}

function installFetchPipeline() {
	const state = ensureFetchPipeline()
	if (state.installed) {
		state.patchedFetch = compose(state)
		return
	}
	const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
	state.patchedFetch = compose(state)
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		enumerable: prevDesc?.enumerable ?? true,
		get() {
			return state.patchedFetch
		},
		set(newFetch) {
			if (newFetch === state.patchedFetch) return
			prevDesc?.set?.call(globalThis, newFetch)
			state.setUnderlyingFetch(newFetch)
			state.patchedFetch = compose(state)
		},
	})
	state.installed = true
}

export function registerFetchMiddleware(registration) {
	const state = ensureFetchPipeline()
	const existingIndex = state.middlewares.findIndex((m) => m.name === registration.name)
	if (existingIndex >= 0) state.middlewares.splice(existingIndex, 1, registration)
	else state.middlewares.push(registration)
	installFetchPipeline()
}

export function unregisterFetchMiddleware(name) {
	const state = ensureFetchPipeline()
	const index = state.middlewares.findIndex((m) => m.name === name)
	if (index >= 0) state.middlewares.splice(index, 1)
	if (state.installed) state.patchedFetch = compose(state)
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

function requestUrlOf(input) {
	try {
		if (typeof input === 'string') return new URL(input)
		if (input && typeof input === 'object' && typeof input.url === 'string') return new URL(input.url)
	} catch {}
	return undefined
}

export function hostMatches(hostname, hosts) {
	const h = String(hostname ?? '').toLowerCase()
	return hosts.some((entry) => {
		const target = String(entry).toLowerCase().trim()
		if (!target) return false
		return h === target || h.endsWith(`.${target}`)
	})
}

/** 本机回环地址？URL.hostname 对 IPv6 会带方括号（`[::1]`），这里统一剥掉。 */
export function isLoopbackHostname(hostname) {
	const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
	return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

/** 路径首段（`/opencode-go/v1/x` → `opencode-go`；`/` 或空 → ''）。 */
export function firstPathSegment(pathname) {
	const match = /^\/([^/?#]+)/.exec(String(pathname ?? ''))
	return match ? match[1] : ''
}

/**
 * 这条 URL 该不该打 `x-opencode-session`？
 *
 * 两条独立规则，任一命中即可：
 *   1. hostname 在上游白名单里（上游行为，未改）；
 *   2. 本副本新增：hostname 是本机回环，且**路径首段**在 `loopbackPrefixes` 里。
 *
 * 规则 2 只解决"请求经本机代理转发、真实上游是 opencode.ai"这一种形态；
 * 它不是白名单的放宽 —— 非回环主机即使路径相同也不会命中（见 8h 用例）。
 *
 * @param {URL|undefined} url
 * @param {string[]} hosts 上游 hostname 白名单
 * @param {string[]} loopbackPrefixes 回环路径首段白名单（空数组 = 关闭规则 2）
 */
export function matchesSessionHeaderTarget(url, hosts, loopbackPrefixes) {
	if (!url || typeof url.hostname !== 'string') return false
	if (hostMatches(url.hostname, hosts)) return true
	if (!isLoopbackHostname(url.hostname)) return false
	const segment = firstPathSegment(url.pathname)
	return segment !== '' && Array.isArray(loopbackPrefixes) && loopbackPrefixes.includes(segment)
}

// ---------------------------------------------------------------------------
// middleware + llm/stream listener factories (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Build the fetch middleware. Options:
 *   - hosts: allowlist of hostnames (exact or subdomain match); default opencode.ai
 *   - fallbackSession: id used when no llm/stream context is present
 *   - isEnabled: () => boolean, consulted per matching request
 *   - loopbackPrefixes: 本副本新增；回环地址上按路径首段补充匹配
 *     （缺省 `['opencode-go']`；显式 `[]` 关闭这条规则）
 */
export function createSessionHeaderMiddleware(options) {
	const hosts = options?.hosts?.length ? options.hosts : DEFAULT_HOSTS
	const loopbackPrefixes = Array.isArray(options?.loopbackPrefixes)
		? options.loopbackPrefixes.map((value) => String(value).trim()).filter((value) => value !== '')
		: DEFAULT_LOOPBACK_PREFIXES
	const fallbackSession = options?.fallbackSession || DEFAULT_FALLBACK
	const isEnabled = options?.isEnabled || (() => true)
	return async function sessionHeaderMiddleware({ input, init, next }) {
		const url = requestUrlOf(input)
		if (!matchesSessionHeaderTarget(url, hosts, loopbackPrefixes)) return next(input, init)
		if (!isEnabled()) return next(input, init)
		const store = requestSessionContext.getStore()
		const value = typeof store === 'string' && store.length > 0 ? store : fallbackSession
		// Per fetch spec: init.headers (when present) replaces the Request's own
		// headers, so merge whichever source would actually reach the wire.
		const source =
			init && init.headers !== undefined
				? init.headers
				: input && typeof input === 'object' && input.headers
					? input.headers
					: undefined
		const headers = new Headers(source ?? undefined)
		headers.set(HEADER_NAME, value)
		return next(input, { ...init, headers })
	}
}

/**
 * Build the `llm/stream` waterfall listener: re-emits the downstream stream
 * with every iterator step executed inside AsyncLocalStorage carrying the
 * call's sessionId, so fetches issued while iterating inherit the context.
 */
export function createLlmStreamListener(sessionContext) {
	return function llmStreamObserver(options, next) {
		const sessionKey = String(options?.sessionId ?? '')
		const inner = next()
		const iterator = inner[Symbol.asyncIterator]()
		const doneResult = () => ({ done: true, value: undefined })
		const runNext = () => sessionContext.run(sessionKey, () => iterator.next())
		const runReturn = () =>
			sessionContext.run(sessionKey, () => (iterator.return ? iterator.return() : Promise.resolve(doneResult())))
		const runThrow = (err) =>
			sessionContext.run(sessionKey, () => (iterator.throw ? iterator.throw(err) : Promise.resolve(doneResult())))
		return {
			[Symbol.asyncIterator]() {
				return {
					next: () => runNext(),
					return: () => runReturn(),
					throw: (err) => runThrow(err),
				}
			},
		}
	}
}

// ---------------------------------------------------------------------------
// runtime switch (re-read per request; no restart needed)
// ---------------------------------------------------------------------------

export function switchFilePath() {
	const envHome = process.env.DSH_HOME?.trim()
	const home = envHome ? envHome : join(homedir(), '.dsh')
	return join(home, 'plugins', 'dsh-opencode-session-header.json')
}

/** Missing/unreadable file or non-boolean `enabled` → seed (default true). */
export function readEnabledSwitch(seed = true) {
	try {
		const parsed = JSON.parse(readFileSync(switchFilePath(), 'utf8'))
		if (parsed && typeof parsed.enabled === 'boolean') return parsed.enabled
	} catch {}
	return seed
}

// ---------------------------------------------------------------------------
// cordis plugin surface
// ---------------------------------------------------------------------------

/**
 * Mount the plugin.
 * @param ctx - host cordis context.
 * @param config - optional deployment config:
 *   { hosts?, loopbackPrefixes?, fallbackSession?, enabled? }.
 */
export function apply(ctx, config) {
	const cfg = config ?? {}
	const hosts = Array.isArray(cfg.hosts) && cfg.hosts.length ? cfg.hosts.map(String) : DEFAULT_HOSTS
	const loopbackPrefixes = Array.isArray(cfg.loopbackPrefixes)
		? cfg.loopbackPrefixes.map((value) => String(value).trim()).filter((value) => value !== '')
		: DEFAULT_LOOPBACK_PREFIXES
	const fallbackSession =
		typeof cfg.fallbackSession === 'string' && cfg.fallbackSession ? cfg.fallbackSession : DEFAULT_FALLBACK
	const seedEnabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : true
	const isEnabled = () => readEnabledSwitch(seedEnabled)

	const log = (level, message) => {
		try {
			ctx.logger?.[level]?.(message)
		} catch {}
	}

	ctx.effect(() => {
		registerFetchMiddleware({
			name: 'dsh-opencode-session-header-inject',
			priority: 7,
			middleware: createSessionHeaderMiddleware({ hosts, loopbackPrefixes, fallbackSession, isEnabled }),
		})
		return () => {
			unregisterFetchMiddleware('dsh-opencode-session-header-inject')
		}
	}, 'dsh-opencode-session-header: fetch middleware')

	ctx.on('llm/stream', createLlmStreamListener(requestSessionContext))

	log('info', `[dsh-opencode-session-header] loaded: header=${HEADER_NAME} hosts=${hosts.join(', ')} loopbackPrefixes=${loopbackPrefixes.join(', ') || '(off)'} fallback=${fallbackSession}`)
	log('info', `[dsh-opencode-session-header] runtime switch: ${switchFilePath()} ({"enabled":false} disables; missing file = enabled)`)
}

export default apply
