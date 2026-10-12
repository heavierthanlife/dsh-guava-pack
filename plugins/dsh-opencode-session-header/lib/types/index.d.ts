import type { Context } from '@deepseek-ai/cordis'

export interface SessionHeaderConfig {
	/** Host allowlist (exact or subdomain match). Default: ["opencode.ai"]. */
	hosts?: string[]
	/** Session id used when no llm/stream context is present. Default "dsh-default". */
	fallbackSession?: string
	/** Boot-time seed for the runtime switch; the switch file wins. Default true. */
	enabled?: boolean
}

export declare const name: string
export declare const inject: string[]
export declare const requestSessionContext: AsyncLocalStorage<string>
export declare function apply(ctx: Context, config?: SessionHeaderConfig): void
export declare function createSessionHeaderMiddleware(options?: {
	hosts?: string[]
	fallbackSession?: string
	isEnabled?: () => boolean
}): (args: { input: unknown; init?: RequestInit; next: (input: unknown, init?: RequestInit) => Promise<Response> }) => Promise<Response>
export declare function createLlmStreamListener(
	sessionContext: AsyncLocalStorage<string>,
): (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
export declare function switchFilePath(): string
export declare function readEnabledSwitch(seed?: boolean): boolean
export declare function hostMatches(hostname: string | undefined | null, hosts: string[]): boolean
export declare function registerFetchMiddleware(registration: {
	name: string
	priority: number
	middleware: (args: { input: unknown; init?: RequestInit; next: (input: unknown, init?: RequestInit) => Promise<Response> }) => Promise<Response>
}): void
export declare function unregisterFetchMiddleware(name: string): void
export default apply
