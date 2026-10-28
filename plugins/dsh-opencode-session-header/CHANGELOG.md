# Changelog

## 0.1.0-dsh.1 — 2026-10-28（dsh-guava-pack 本地补丁，非上游发布）

- 新增「loopback + 路径首段」匹配：hostname 为 `127.0.0.1` / `localhost` / `::1`
  时，按路径首段（默认 `opencode-go`）补充判定是否打 `x-opencode-session`。
  原因：本 DSH profile 的 `opencode-go` 经本机路由代理（`127.0.0.1:8318/opencode-go`），
  hostname 恒为回环地址，上游的 hostname 白名单永不命中。
- 首段整段相等才算（`/opencode-goo` 不命中）；非回环主机不放宽；`loopbackPrefixes: []` 可关闭。
- 新增导出 `isLoopbackHostname` / `firstPathSegment` / `matchesSessionHeaderTarget`；
  `createSessionHeaderMiddleware` 与 `apply` 接受 `loopbackPrefixes`。
- 冒烟测试 13 → 22 条（新增 8a–8i），上游 13 条断言未改。
- 上游 0.1.0 的行为在真实 `opencode.ai` 主机上完全不变。

## 0.1.0 — 2026-09-07

- Initial release.
- Per-conversation `x-opencode-session` injection for OpenCode Go, scoped strictly
  to `opencode.ai` hosts (default allowlist, subdomains included).
- Runtime switch file `<DSH_HOME>/plugins/dsh-opencode-session-header.json`
  (`{"enabled": false}` disables, no restart needed; missing file = enabled).
- 13 smoke assertions covering injection, fallback id, host allowlist, the
  runtime switch, concurrent-session isolation, `llm/stream` context
  propagation and subdomain matching.
