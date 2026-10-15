# dsh-provider-router

自动探测当前 LLM 供应商，并控制其请求走**直连**还是**经 SSR（翻墙）**。提供一套
适配明 / 暗 / 赛博三套主题的状态面板与手动切换开关。

## 结构

- `lib/index.js` — Host 端：供应商 → 路由模式映射，写 `mode.json`
- `lib/client.js` — 客户端：设置面板「供应商路由」，主题 token 化样式 + 切换开关
- `lib/router.mjs` — 本地路由代理（独立 WSL 进程，端口 `127.0.0.1:8318`）
- `start.sh` — 幂等启动路由代理

## 路由模式

| 模式 | 含义 |
|---|---|
| `direct` | 请求直连上游 |
| `ssr` | 请求经 SSR 代理（`127.0.0.1:2080`，HTTP CONNECT）|
| `auto` | 回落到该供应商的默认值 |

默认映射（`mode.json` 由 Host 插件首次激活时生成；2026-10-04 实测修正 —— 只有 agentrouter 真需翻墙，见 PLAN §9.1）：

| 供应商 | 默认 |
|---|---|
| `xiaomi-token-plan-cn`（小米，国内） | direct |
| `opencode-go` | direct |
| `antigravity` | direct |
| `agentrouter` | **ssr** |
| `commandcode` | direct |

## 启用路由

**4 家可切、1 家禁用**（2026-10-04 实测，PLAN §9.2）：`xiaomi-token-plan-cn` / `opencode-go` /
`agentrouter` 的 `baseURL` 已指向 `http://127.0.0.1:8318/<provider>`；
`commandcode`(8317) 的桥接**热读 `mode.json`**，开关同样生效；
`antigravity`(8045) 是第三方工具（`antigravity-tools`）持有，**开关不可用**、面板已标注「由外部工具控制」
（`lib/client.js` 里该条 `control:'external'`，不受开关影响）。

> 原文写"5 家开关均真生效"，紧接着自己又说 antigravity 不可用 —— 已按代码更正为
> "4 家可切 + 1 家禁用"。

## 风险

- 只在 `127.0.0.1` 监听，不暴露局域网。
- 不改 Windows 系统代理、注册表、Tailscale。
- SSR 上游实测可用（2026-10-04，PLAN §9.1）；仍取决于 SSR 节点状态，变化时重测 PLAN §9.1 矩阵。
