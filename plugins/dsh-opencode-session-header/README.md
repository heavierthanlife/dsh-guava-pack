# dsh-opencode-session-header

[![npm version](https://img.shields.io/npm/v/dsh-opencode-session-header)](https://www.npmjs.com/package/dsh-opencode-session-header)
[![license](https://img.shields.io/npm/l/dsh-opencode-session-header)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-opencode-session-header)](./package.json)

Per-conversation `x-opencode-session` header injection for **DeepSeek Harness (DSH)** → **OpenCode Go**.

It fixes the `400 MissingSessionID` rejection **and** keeps OpenCode's per-conversation routing / prompt-cache optimization working — scoped strictly to `opencode.ai`, runtime-switchable without restart, zero dependencies.

[中文文档](./README.zh-CN.md)

## The problem

Since 2026-09-05, [OpenCode Go](https://opencode.ai/docs/go/) requires a stable `x-opencode-session` header on every inference request (used for routing and prompt caching). DeepSeek Harness ≤ `0.1.2-rc.1` sends no such header on any adapter path, so **every opencode-go model call fails**:

```
400: {"type":"MissingSessionID","message":"Error from provider (Console Go): Request is missing x-opencode-session ..."}
```

Upstream fix is tracked in [deepseek-harness discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495) but has not shipped yet. This plugin fills the gap locally.

## Why not the common workarounds?

| | Static `headers` in settings.yaml | Global `opencode_zen` profile (dsh-custom-header) | **This plugin** |
|---|---|---|---|
| Fixes the 400 | ✅ | ✅ | ✅ |
| Per-conversation id (cache / routing optimal) | ❌ one shared id → cache misses, slower & pricier | ✅ | ✅ real DSH session id |
| Other providers untouched | ✅ | ❌ rewrites UA + `x-opencode-*` on **every** host | ✅ `opencode.ai` only |
| Toggle without restart | — | — | ✅ JSON file flip |
| Extra dependencies | — | third-party plugin, client bundle | none |

## Install

```powershell
dsh plugin --profile web add dsh-opencode-session-header
```

or from a local clone / checkout:

```powershell
dsh plugin --profile web add "file:C:\path\to\dsh-opencode-session-header"
```

Then **restart dsh web** once — plugins load at boot. The startup log should show:

```
[dsh-opencode-session-header] loaded: header=x-opencode-session hosts=opencode.ai fallback=dsh-default
[dsh-opencode-session-header] runtime switch: <DSH_HOME>\plugins\dsh-opencode-session-header.json ({"enabled":false} disables; missing file = enabled)
```

## Runtime switch (no restart needed)

State file: `<DSH_HOME>/plugins/dsh-opencode-session-header.json` (defaults to `~/.dsh`):

```json
{ "enabled": false }
```

- `false` → injection off (all requests pass through untouched);
- `true` or **file missing** → injection on;
- the file is re-read on every LLM request, so toggling takes effect immediately.

## How it works

Two seams, both proven inside DSH `0.1.2-rc.1`:

1. **`llm/stream` waterfall observer** — wraps every adapter stream iteration in an `AsyncLocalStorage` carrying `GenerateOptions.sessionId` (stable per DSH conversation across turns, compaction and retries; fresh per conversation / fork / subagent).
2. **Fetch transport middleware** — stamps `x-opencode-session` **only** when the request host matches the allowlist (default: `opencode.ai` + subdomains). Value = the current session id, or the fallback id (`dsh-default`) outside any LLM context (e.g. model discovery). Every other host passes through byte-for-byte untouched.

The fetch pipeline runs under this plugin's own `Symbol.for` key (mechanics vendored from [`@aizigao/pi-fetch-pipeline`](https://github.com/aizigao/pi-fetch-pipeline), MIT), so it coexists with other fetch-patching plugins instead of clobbering them. Header merging follows the fetch spec: whichever of `init.headers` / `Request.headers` would reach the wire is used as the merge base.

## Testing

```powershell
npm test        # 13 assertions: injection, fallback, allowlist, runtime switch,
                # concurrent-session isolation, llm/stream propagation, subdomains
```

## Compatibility & retirement

- Built and verified against DSH `0.1.2-rc.1` (npm latest at release time).
- Depends on DSH outbound LLM traffic using the process-global `fetch`. If a future DSH build switches its network stack, the plugin silently stops injecting — the symptom is simply the 400 returning; uninstall then.
- Once upstream ships native per-conversation session headers ([discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495)), retire this plugin:

```powershell
dsh plugin --profile web remove dsh-opencode-session-header
```

then restart dsh web (optionally delete the switch file).

## Credits

- Fetch-pipeline mechanics vendored from [`@aizigao/pi-fetch-pipeline`](https://github.com/aizigao/pi-fetch-pipeline) (MIT); the fetch-layer approach on DSH was proven by [`dsh-custom-header`](https://github.com/Asaiuta/dsh-custom-header) (MIT) by [Asaiuta](https://github.com/Asaiuta).

## License

[MIT](./LICENSE)
