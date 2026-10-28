/**
 * Smoke tests for dsh-opencode-session-header (no network beyond localhost,
 * no DSH required).
 *
 * Covers:
 *   1. header injected with the ALS session id inside llm/stream context
 *   2. fallback id outside any llm/stream context
 *   3. host allowlist: non-matching hosts pass through untouched
 *   4. runtime switch file: {"enabled":false} disables, deleting re-enables
 *   5. concurrent conversations keep distinct session ids
 *   6. llm/stream listener propagates the sessionId into iteration context
 */

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(new URL('../lib/index.js', import.meta.url))

let passed = 0
let failed = 0
function check(label, condition, detail) {
	if (condition) {
		passed++
		console.log(`  ok  ${label}`)
	} else {
		failed++
		console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
	}
}

// fake DSH_HOME so the runtime-switch file lands in a temp dir
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-osh-test-'))
mkdirSync(join(fakeHome, 'plugins'), { recursive: true })
process.env.DSH_HOME = fakeHome

// echo server: reports the x-opencode-session header it received
const seen = []
const server = createServer((req, res) => {
	seen.push({ path: req.url, session: req.headers['x-opencode-session'] ?? null })
	res.setHeader('content-type', 'application/json')
	res.end(JSON.stringify({ ok: true }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

try {
	// --- cases 1, 2: allowlist matches 127.0.0.1 for the test ---
	mod.registerFetchMiddleware({
		name: 'test-inject',
		priority: 7,
		middleware: mod.createSessionHeaderMiddleware({
			hosts: ['127.0.0.1'],
			fallbackSession: 'fb-fallback',
			isEnabled: () => mod.readEnabledSwitch(true),
		}),
	})

	seen.length = 0
	await mod.requestSessionContext.run('session-abc', () => fetch(`${base}/case1`))
	check('1. ALS session id injected', seen.at(-1)?.session === 'session-abc', seen.at(-1))

	seen.length = 0
	await fetch(`${base}/case2`)
	check('2. fallback id outside context', seen.at(-1)?.session === 'fb-fallback', seen.at(-1))

	// --- case 3: host allowlist excludes 127.0.0.1 ---
	mod.registerFetchMiddleware({
		name: 'test-inject',
		priority: 7,
		middleware: mod.createSessionHeaderMiddleware({
			hosts: ['opencode.ai'],
			fallbackSession: 'fb-fallback',
			isEnabled: () => mod.readEnabledSwitch(true),
		}),
	})
	seen.length = 0
	await mod.requestSessionContext.run('session-abc', () => fetch(`${base}/case3`))
	check('3. non-matching host untouched', seen.at(-1)?.session === null, seen.at(-1))

	// --- case 4: runtime switch file ---
	mod.registerFetchMiddleware({
		name: 'test-inject',
		priority: 7,
		middleware: mod.createSessionHeaderMiddleware({
			hosts: ['127.0.0.1'],
			fallbackSession: 'fb-fallback',
			isEnabled: () => mod.readEnabledSwitch(true),
		}),
	})
	const switchFile = mod.switchFilePath()
	check('4a. switch file path under DSH_HOME', switchFile === join(fakeHome, 'plugins', 'dsh-opencode-session-header.json'), switchFile)

	writeFileSync(switchFile, JSON.stringify({ enabled: false }))
	seen.length = 0
	await mod.requestSessionContext.run('session-abc', () => fetch(`${base}/case4-off`))
	check('4b. {"enabled":false} disables injection', seen.at(-1)?.session === null, seen.at(-1))

	rmSync(switchFile)
	seen.length = 0
	await mod.requestSessionContext.run('session-abc', () => fetch(`${base}/case4-on`))
	check('4c. missing switch file re-enables', seen.at(-1)?.session === 'session-abc', seen.at(-1))

	writeFileSync(switchFile, JSON.stringify({ enabled: true }))
	seen.length = 0
	await fetch(`${base}/case4-true`)
	check('4d. {"enabled":true} stays enabled (fallback id)', seen.at(-1)?.session === 'fb-fallback', seen.at(-1))

	// --- case 5: concurrent conversations keep distinct ids ---
	seen.length = 0
	await Promise.all([
		mod.requestSessionContext.run('session-aaa', () => fetch(`${base}/case5-a`)),
		mod.requestSessionContext.run('session-bbb', () => fetch(`${base}/case5-b`)),
	])
	const byPath = Object.fromEntries(seen.map((s) => [s.path, s.session]))
	check(
		'5. concurrent sessions do not leak ids',
		byPath['/case5-a'] === 'session-aaa' && byPath['/case5-b'] === 'session-bbb',
		byPath,
	)

	// --- case 6: llm/stream listener propagates sessionId into iteration ---
	const listener = mod.createLlmStreamListener(mod.requestSessionContext)
	async function* inner() {
		yield mod.requestSessionContext.getStore()
		yield mod.requestSessionContext.getStore()
	}
	const wrapped = listener({ sessionId: 'session-xyz' }, () => inner())
	const collected = []
	for await (const value of wrapped) collected.push(value)
	check('6. listener wraps iteration in session context', collected.every((v) => v === 'session-xyz'), collected)

	// --- case 7: subdomain matching ---
	check('7a. subdomain matches', mod.hostMatches('api.opencode.ai', ['opencode.ai']))
	check('7b. exact host matches', mod.hostMatches('opencode.ai', ['opencode.ai']))
	check('7c. different host rejected', !mod.hostMatches('example.com', ['opencode.ai']))
	check('7d. lookalike host rejected', !mod.hostMatches('notopencode.ai', ['opencode.ai']))

	// --- case 8: 本副本新增的 loopback + 路径首段匹配 ---
	// 背景：profile 把 opencode-go 的 baseURL 指到本机路由代理，hostname 恒为
	// 127.0.0.1，上游只认 hostname 的规则永远不命中（插件对主用路由空转）。
	mod.registerFetchMiddleware({
		name: 'test-inject',
		priority: 7,
		middleware: mod.createSessionHeaderMiddleware({
			hosts: ['opencode.ai'],
			loopbackPrefixes: ['opencode-go'],
			fallbackSession: 'fb-fallback',
			isEnabled: () => true,
		}),
	})
	seen.length = 0
	await mod.requestSessionContext.run('session-lo', () =>
		fetch(`${base}/opencode-go/v1/chat/completions`, { method: 'POST', body: '{}' }))
	check('8a. loopback /opencode-go 打头', seen.at(-1)?.session === 'session-lo', seen.at(-1))

	seen.length = 0
	await mod.requestSessionContext.run('session-lo', () =>
		fetch(`${base}/agentrouter/v1/chat/completions`, { method: 'POST', body: '{}' }))
	check('8b. 其它本地前缀不打头', seen.at(-1)?.session === null, seen.at(-1))

	seen.length = 0
	await mod.requestSessionContext.run('session-lo', () =>
		fetch(`${base}/opencode-goo/v1/chat/completions`, { method: 'POST', body: '{}' }))
	check('8c. 路径首段必须整段相等（opencode-goo 不算）', seen.at(-1)?.session === null, seen.at(-1))

	check('8d. 真实 opencode 主机仍命中',
		mod.matchesSessionHeaderTarget(new URL('https://api.opencode.ai/v1/messages'), ['opencode.ai'], ['opencode-go']))
	check('8e. 回环 + 前缀命中',
		mod.matchesSessionHeaderTarget(new URL('http://127.0.0.1:8318/opencode-go/v1'), ['opencode.ai'], ['opencode-go']))
	check('8f. IPv6 回环与 localhost 同等处理',
		mod.matchesSessionHeaderTarget(new URL('http://[::1]:8318/opencode-go/v1'), ['opencode.ai'], ['opencode-go']) &&
		mod.matchesSessionHeaderTarget(new URL('http://localhost:8318/opencode-go/v1'), ['opencode.ai'], ['opencode-go']))
	check('8g. 显式空数组关闭回环规则',
		!mod.matchesSessionHeaderTarget(new URL('http://127.0.0.1:8318/opencode-go/v1'), ['opencode.ai'], []))
	check('8h. 非回环主机即使路径相同也不命中（白名单没被放宽）',
		!mod.matchesSessionHeaderTarget(new URL('https://example.com/opencode-go/v1'), ['opencode.ai'], ['opencode-go']))
	check('8i. 根路径不打头',
		!mod.matchesSessionHeaderTarget(new URL('http://127.0.0.1:8318/'), ['opencode.ai'], ['opencode-go']))
} finally {
	mod.unregisterFetchMiddleware('test-inject')
	await new Promise((resolve) => server.close(resolve))
	rmSync(fakeHome, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
