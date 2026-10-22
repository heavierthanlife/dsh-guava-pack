# dsh-provider-router

自动探测当前 LLM 供应商，并控制其请求走**直连**还是**经 SSR（翻墙）**。提供一套
适配明 / 暗 / 赛博三套主题的状态面板与手动切换开关。

## 结构

- `lib/index.js` — Host 端：供应商 → 路由模式映射，写 `mode.json`
- `lib/client.js` — 客户端：设置面板「供应商路由」，主题 token 化样式 + 切换开关
- `lib/router.mjs` — 本地路由代理（独立 WSL 进程，端口 `127.0.0.1:8318`）
- `start.sh` — 幂等启动路由代理

## 自适应（2.0）

面板**不再维护写死的供应商列表**。目录来自三处合并（`lib/auto-mode.mjs`）：

| 来源 | 作用 |
|---|---|
| `ctx.llm.listProviders()` | 当前真的注册着的路由（用户马上能用） |
| `ctx.llm.listConfigurableProviders()` | 可配置但休眠的路由（配了 key 才会变 live，面板也要能看见） |
| `DEFAULT_MODES` | 内置兜底（llm 服务缺失时的最后一道） |

**每家的 `control` 也不再靠 id 猜**，而是读 profile 里真实的 `baseURL`
（`lib/profile-providers.mjs`）：

| control | 含义 | 开关是否生效 |
|---|---|---|
| `router` | baseURL 指向 `127.0.0.1:8318/<prefix>` 且代理认识该前缀 | ✅ 真生效 |
| `bridge` | 本地桥接读同一份 `mode.json`（commandcode） | ✅ 真生效 |
| `external` | 第三方反代自己控制出口（antigravity） | ❌ 标灰 |
| `direct` | baseURL 不经过本代理（如 `opencode` 直连上游） | ❌ 标灰 |
| `router-missing-upstream` | baseURL 指向本代理，但代理的上游表里没这个前缀 | ⚠️ 会 404，提示补 `providers.json` |
| `unknown` | 读不到 baseURL —— **不猜** | ⚠️ 说明原因 |

### `auto` 模式

`direct → ssr → auto` 三态循环。`auto` 不是又一个静态值，而是：

1. 对上游发一条最小探活请求（HTTP 状态无关，**能连上就算通**）；
2. **两条路都测**（direct 与经 SSR），带超时；
3. 取更快的那条；差距 < 50ms 视为平手 → 选 direct（SSR 多一跳、多一个故障点）；
4. 只有一条通 → 用它；都不通 → 回落 direct；
5. 结果缓存 10 分钟（`DSH_ROUTER_AUTO_TTL_MS`，探活超时 `DSH_ROUTER_AUTO_TIMEOUT_MS`，默认 3s）。

⚠️ 只在你**显式选 auto** 时才测；`direct`/`ssr` 的请求路径上**零额外延迟**。
面板里的「实测」按钮可以手动触发一次并看到两边的毫秒数（依据可见，不是黑盒）。

### 自省端点（只读，仅 loopback）

```
GET /_router/state              # 已知前缀、上游 host、当前模式、auto 实测缓存
GET /_router/measure?provider=  # 当场测一次，返回 direct/ssr 的 ok+ms
```

未知前缀的 404 现在会**列出已知前缀**并提示怎么补 `providers.json`
（以前只有一行 `unknown provider: x`，看不出是拼错了还是上游表缺条目）。

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
