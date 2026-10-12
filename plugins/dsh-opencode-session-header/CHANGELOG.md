# Changelog

## 0.1.0 — 2026-09-07

- Initial release.
- Per-conversation `x-opencode-session` injection for OpenCode Go, scoped strictly
  to `opencode.ai` hosts (default allowlist, subdomains included).
- Runtime switch file `<DSH_HOME>/plugins/dsh-opencode-session-header.json`
  (`{"enabled": false}` disables, no restart needed; missing file = enabled).
- 13 smoke assertions covering injection, fallback id, host allowlist, the
  runtime switch, concurrent-session isolation, `llm/stream` context
  propagation and subdomain matching.
