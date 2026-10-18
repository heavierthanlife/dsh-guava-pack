# 供应商路由插件 —— 项目计划与框架

## 1. 目标

一个 DSH 插件：**自动探测当前使用的 LLM 供应商**，按「国内直连 / 需翻墙(SSR)」分类，
以适配**明 / 暗 / 赛博**三套主题的方式**显示**当前供应商与路由模式，并提供**手动切换**开关。

## 2. 现状勘察结论（2026-10-03，纠正一个前提）

### 2.1 网络现实

| 事实 | 证据 |
|---|---|
| DSH 跑在 **WSL (mirrored)** | `wslinfo --networking-mode` → mirrored |
| **DSH/WSL 当前是「直连」，不走 SSR** | `dsh` 启动器主动清代理变量；shell 的代理变量**因会话而异**（继承自父进程，见 §10.2），测量必须显式声明 |
| WSL 直连：国内快、国外慢/挂 | baidu 0.16s ✅；opencode.ai 6s；api.commandcode.ai 4.8s；agentrouter.org 超时；generate.commandcode.ai DNS 解析失败 |
| **SSR 从 WSL 可达且可用** | `127.0.0.1:2080` TCP 通；HTTP 代理与 SOCKS5 **都可用**（baidu via socks5 = 0.06s） |
| SSR 监听 `0.0.0.0:2080` | 局域网也能访问 |
| ~~**SSR 上游到国外当前不正常**~~ → **已恢复** | 10-03 曾 `google → CONNECT aborted`；**10-04 实测经 SSR 全通**（见 §9.1），以此为准 |

### 2.2 关键结论（改变了设计）

> **用户以为「用国外供应商时电脑已走 SSR」—— 实际上 DSH 在 WSL 里一直是直连。**
> 国外供应商现在能用是「勉强能用」（opencode.ai 6 秒、commandcode 4.8 秒），
> 有些已经挂了（agentrouter 超时、generate.commandcode.ai DNS 污染）。
> **所以这个项目的价值比想象更大**：它不是「切换」，而是「让 DSH 真正会用 SSR」。

### 2.3 已确认的 subagent 模型 ID

| 角色 | 用户说法 | provider | model |
|---|---|---|---|
| worker（干活） | 官方 ds flash | `deepseek-official` | `deepseek-flash` |
| reviewer（复核） | mimo 2.6 pro | `xiaomi-token-plan-cn` | `mimo-v2.6-pro` |

> 注：`opencode-go/deepseek-v4.1-flash` 实测无法被 workflow 子代理路由（返回 null）；
> 官方 DeepSeek 供应商是 `deepseek-official`，模型为 `deepseek-flash` 与 `deepseek-v4-pro`。

## 3. 架构设计

### 3.1 分层

```
┌─────────────────────────────────────────────┐
│ 客户端插件 (client.js)                        │
│  · 探测当前供应商 / 路由模式                    │
│  · 主题适配的指示器 + 手动切换开关              │
│  · 读 host 暴露的路由状态                      │
└──────────────────┬──────────────────────────┘
                   │ RPC (remote.providerRouter.*)
┌──────────────────▼──────────────────────────┐
│ 主机插件 (index.js)                          │
│  · 供应商 → 路由模式 映射表（国内/翻墙）        │
│  · 暴露 getState / setMode / 探测              │
│  · 写「路由决策」到本地共享文件                  │
└──────────────────┬──────────────────────────┘
                   │ 读 /tmp 或 ~/dsh 下的 JSON
┌──────────────────▼──────────────────────────┐
│ 路由执行层（WSL 本地代理，独立进程）            │
│  · 一个本地「路由代理」端口                     │
│  · 按映射：国外 → 经 SSR(127.0.0.1:2080)       │
│            国内 → 直连                        │
│  · 读上面的决策文件，运行时切换                  │
└─────────────────────────────────────────────┘
```

### 3.2 路由执行机制 —— 三个选项（**待用户拍板**）

| 选项 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 本地路由代理** | WSL 起一个本地代理（如 `127.0.0.1:8318`），所有「翻墙」供应商的 `baseURL` 指向它；代理按映射把请求要么直连、要么经 SSR 出去 | 真·强制路由、按供应商、运行时可切换 | 要改 profile 的 baseURL（需重启一次）；新增一个常驻进程 | ✅ **推荐** |
| B. 只检测+显示+切换 | 插件只做 UI；实际路由交给已有桥接（commandcode 8317 / antigravity 8045）各自支持 SSR | 侵入最小 | 只覆盖已桥接的供应商；opencode-go / agentrouter 仍是直连 | 兜底 |
| C. 切 Windows 系统代理 | host 插件改注册表 `ProxyEnable` | 简单 | 影响整个系统；**会打断 Tailscale（它依赖 SSR）**；DSH 在 WSL 根本不读 WinINET | ❌ **否决** |

### 3.3 数据流（选项 A）

1. 用户在 UI 里把「某供应商」切到 SSR / 直连（或插件按内置映射自动判定）
2. host 插件把决策写进 `~/dsh/playground/themes/provider-router/mode.json`
3. 本地路由代理热读该文件，把该供应商的请求送 SSR 或直连
4. UI 显示当前供应商 + 生效中的路由模式（颜色随主题）

## 4. 组件拆分（worker 实现清单）

1. `provider-router/package.json` — `dsh.client`（web）+ host 导出
2. `provider-router/lib/index.js` — host：供应商映射表、`remote.providerRouter.{getState,setMode,detect}`
3. `provider-router/lib/client.js` — 客户端：指示器组件 + 切换开关 + 主题 token 读取
4. `provider-router/lib/router.mjs` — 本地路由代理（零依赖 Node，仿 commandcode-bridge）
5. `provider-router/start.sh` — 幂等启动路由代理
6. `provider-router/cordis.patch.yml` — 注册进 profile
7. `provider-router/README.md` — 使用说明 + 风险

**主题适配**：只读 `--dsw-alias-bg-* / --dsw-alias-label-* / --dsw-alias-state-*` 等主题 token；
赛博主题下额外尊重其霓虹强调色（`#00f0ff`/`#fce300`），**不硬编码颜色**。

## 5. 任务分工（subagent）

| 角色 | 模型 | 任务 | 交付物 | 写范围 |
|---|---|---|---|---|
| **worker** | opencode-go / deepseek-v4.1-flash | 按 §4 实现全部 7 个文件 + 语法自检 | 完整可装插件 | `playground/themes/provider-router/**` |
| **reviewer** | xiaomi-token-plan-cn / mimo-v2.6-pro | 复核：安全性（不改系统代理/Tailscale）、主题 token 用法、slot 注册、错误处理、`node --check` | 复核报告 + 必要修正 | 同上（只读+审） |

## 6. 风险与边界

1. ~~**SSR 上游当前连不上国外**（google CONNECT aborted）~~ → **已不成立**（2026-10-04 实测经 SSR 全通，见 §9.1）。遗留风险仅是 SSR 节点状态会变，届时重测 §9.1 矩阵即可。
2. 改供应商 `baseURL` 需要改 profile patch → **必须重启 DSH**（会杀当前 GUI 会话，先征得同意）。
3. **不碰 Windows 系统代理、不碰 Tailscale** —— 那是已证明的禁区。
4. 路由代理是「开发中灰色手段」，同 commandcode 桥接，用户知情接受。

## 7. 里程碑

1. ~~勘察网络现状 + 确认模型 ID~~（已完成）
2. 用户拍板「路由执行机制」+ 确认是否可重启 DSH
3. worker 实现 7 个文件 → reviewer 复核 → 修正
4. 安装、配置 baseURL、重启 DSH
5. 验证：国内供应商直连快 / 翻墙供应商经 SSR 快；三套主题下 UI 正常；手动切换生效

---

# 8. 实施记录（as-built，2026-10-04 完成）

## 8.1 最终架构（与 §3 的差异）

```
浏览器 (lib/client.js)
  │  fetch POST /provider-router/<endpoint>
  │  body: {type:'client-request', rpcId, method, payload}
  ▼
Host (lib/index.js)
  │  ctx.webServer.register({kind:'prefix', path:'/provider-router', handler})
  │  → 读写 mode.json，返回 {type:'server-response', rpcId, result:{ok,value}}
  ▼
mode.json  ←── 热读 ──  lib/router.mjs（127.0.0.1:8318，独立 WSL 进程，start.sh 拉起）
                          │ 按 <provider> 前缀路由
                          ├─ ssr    → HTTP CONNECT 127.0.0.1:2080 隧道 + TLS
                          └─ direct → 直连真实上游
```

`opencode-go` / `agentrouter` 的 baseURL 已改为
`http://127.0.0.1:8318/<provider>`（原始上游留在 router.mjs 的 PROVIDERS 表里）。
`antigravity`(8045) / `commandcode`(8317) 仍走各自桥接 —— **范围外，未接入**。

## 8.2 【三个大坑】—— 重挖一次很贵，务必先读

### 坑 1：`ctx.provide(name, value)` **不会**桥接到客户端 `ctx.remote`

报错：客户端报 `remote.xxx 不可用`，但 host 端一切正常。

```
ctx.provide("providerRouter", service)   // ✗ 只有 host 内部能用 ctx.providerRouter
```
能到达浏览器的值走 **connection RPC 桥**，不是 `ctx.provide`。

### 坑 2：`ctx.connection.rpc.handle(channel, handler)` **从外部插件不可用**

报错：
```
Error: cannot get property "webServer" without inject
    at this.register (dsh-client-connection/lib/index.js:656)
    at this.rpc.handle (index.js:576)
```
原因（源码）：
```js
get rpc() { const owner = this.ctx; ... }        // owner = connection 插件自己的 ctx
register(owner, ...) { owner.effect(() => owner.webServer.register(route), ...) }
```
而 `dsh-client-connection` 只声明 `inject = ["credentials"]`，`webServer` 是通过
**软注入** `ctx.inject(["webServer"], (webCtx) => ...)` 拿到的 —— 所以 `owner.webServer`
必然抛错。**往自己插件的 inject 里加 `webServer` 完全无效**（踩过这个坑）。

**正解**：用 `ctx.webServer.register({kind:'prefix', path, handler})` 自己注册 HTTP 路由，
并在 handler 里自己实现同源守卫（因为绕过了 connection 的 Host/Origin 围栏）。

### 坑 3：`ctx.remote.$host.rpc` 有**时序**问题

`$host` 句柄要等连接建立后才存在。在 `apply()` 里解析它会拿到 `null` 并被永久缓存 →
面板报 "rpc 不可用"。

**正解**：客户端**直接用 `fetch`** 打自己的路由即可（本插件的 host 路由就是普通 HTTP 端点），
不需要 `$host.rpc`。

### 附带：cordis 未注入服务的**取值即抛**

`var x = ctx.remote && ctx.remote.$host` —— 这个 `&&` **救不了**，因为
`ctx.remote` 取值那一刻就抛 `cannot get property "remote" without inject`。
后果：slot 条目的 `inject` 面抛错 → 条目 `active: false` → **设置页 tab 标题出现但内容全空白**
（`SlotErrorBoundary` 只兜组件渲染崩溃，兜不住 inject 面）。

## 8.3 客户端 bundle vs host 模块的更新方式（重要）

| 改动位置 | 生效方式 |
|---|---|
| `lib/client.js` | **刷新页面**即可（bundle 按需重建，rev 会变） |
| `lib/index.js`（host） | **必须重启 DSH**（模块按代际缓存，改文件无效） |

判据：报错栈里的**行号**是否等于当前文件的行号 —— 不等就是缓存的旧模块。

## 8.4 已完成验证（全部实测）

| 项 | 证据 |
|---|---|
| 路由代理 SSR 路径 | `/opencode-go/models` 经 SSR → **200 + 真实模型列表** |
| 路由代理 直连路径 | 同上直连 → 200 |
| 路由代理 TLS | 曾因漏做 TLS 报 `400 The plain HTTP request was sent to HTTPS port`，已修 |
| host 路由端到端 | 真实 3080 端口 `getState`/`setMode`/`reset`，**mode.json 确认落盘** |
| host handler 异常路径 | 11/11（405 / 跨域 403 / 坏信封 / 非法参数） |
| 客户端面板 | **用户在浏览器中确认渲染正常** |
| 路由代理健康 | `http://127.0.0.1:8318/health` → ok |

## 8.5 subagent 分工的实际结果（诚实记录）

| 角色 | 计划 | 实际 |
|---|---|---|
| worker | `deepseek-official/deepseek-flash` | ❌ 反复失败：opencode-go 模型无法路由（返回 null）、后台跑 10 分钟零产出被中止 |
| reviewer | `xiaomi-token-plan-cn/mimo-v2.6-pro` | ⚠️ 多次中断：先是电脑重启导致 systemd 用户总线挂掉；恢复后 reviewer 自己钻进 cordis 内部 API 验证的死循环 |
| 实现 | — | ✅ **由 Lead 直接完成**，并用行为测试（非代码审查）验证 |

**教训**：把「大块代码编写」交给 flash 级模型 + workflow 编排，在这个环境里不稳定；
**行为测试比代码审查更能发现问题**（坑 1/2/3 全是实测/报错暴露的，不是读代码看出来的）。

## 8.6 reviewer（mimo-v2.6-pro）复核结果：**ship**

最终一次用**严格约束**提示词（禁用 `cordis_inspect_query`、禁读框架源码、限 3 条命令、限 30 行输出）
成功跑完，逐项结论：

| 审查项 | 结论 |
|---|---|
| 安全（无系统代理/注册表/Tailscale；只写包内；只监听 127.0.0.1） | PASS |
| 语法（`node --check` ×3） | PASS |
| 客户端主题化（只用 `--dsw-alias-*` + fallback） | PASS |
| 路由代理（SSR 隧道+TLS / 直连 / `req.pipe`+`upRes.pipe`） | PASS |
| 明显 bug | PASS + **2 处小瑕疵** |

**reviewer 报出的 2 处瑕疵（已修并验证）：**

1. `router.mjs` CONNECT 握手期只挂了 `error`，代理静默断开时 `cb` 永不触发 → 请求永久挂起。
   **修**：加 15s `CONNECT_TIMEOUT_MS` + `close`/`end` 监听，三条路径都收敛到同一个 `done()`。
2. `start.sh` 健康检查失败仍留 pid 文件；端口被残留进程占用时不 kill 旧进程 → 重试只会 EADDRINUSE。
   **修**：区分「活着且健康」/「活着但不健康（先 kill -9 再起）」/「无 pid」三种情况；失败路径清掉 pid 文件。
   **验证**：二次运行 → `already running`（幂等）✓。

**复核后复测**：`/opencode-go/models` 经 SSR → 200 / 0.92s；`/agentrouter/models` → 401（上游受理）；
未知供应商 → 404；host 路由 `getState`/`setMode` 正常，mode.json 落盘确认。

## 8.7 最终状态（2026-10-04）

| 项 | 状态 |
|---|---|
| 插件 | `playground/themes/provider-router/`（7 文件，host 287 行 / client 330 行 / router 234 行；2026-10-04 快照，后续改动会漂移） |
| 安装 | profile 已装并启用 |
| 路由代理 | 常驻运行，`~/dsh/dsh` 启动器自动拉起 |
| `opencode-go` / `agentrouter` baseURL | 均指向 `http://127.0.0.1:8318/<provider>` |
| 界面 | 设置 → 供应商路由：5 家供应商 + 分类 + 直连/SSR 开关（用户已确认） |
| 备份 | `dsh.bak-provider-router-20261004-184039`、`cordis.patch.yml.bak-provider-router-20261004-184039` |

**范围外（未做）**：~~antigravity(8045) / commandcode(8317) 的 SSR 路由需在各自桥接脚本里实现~~
→ commandcode 已于 §9 接入（桥接读 mode.json）；antigravity 是第三方工具，改为面板标注不可控。

---

# 9. 全量实测 + 功能做齐（2026-10-04 晚）

## 9.1 【全测】各供应商真实上游 × 直连 vs 经 SSR

在当时的网络下实测（格式 `HTTP码 / 耗时`）：

| 供应商 | 真实上游 | 直连 | 经 SSR | 结论 |
|---|---|---|---|---|
| xiaomi | `https://token-plan-cn.xiaomimimo.com/v1` | 401 / **0.15s** | 401 / 0.33s | 直连更快 |
| opencode-go | `https://opencode.ai/zen/go/v1` | 200 / 0.82s | 200 / 0.79s | 持平 |
| **agentrouter** | `https://agentrouter.org/v1` | **000 / 12s 超时** ❌ | **401 / 1.70s** ✅ | **唯一真需翻墙** |
| commandcode | `https://api.commandcode.ai`（经桥接） | 200 / **0.81s** | 200 / 2.09s | 直连更快 |
| antigravity | `127.0.0.1:8045`（第三方 `antigravity-tools`） | 401 / 0.005s | — | 本地，无需 |

**关键结论：默认映射从「4 家全 SSR」改为「只有 agentrouter 走 SSR」** —— 原默认是错的。
（该网络比赛话早期好一个数量级：opencode-go 6s→0.82s、commandcode 4.8s→0.81s。）

## 9.2 功能做齐：5 家的开关现在都真生效

| 供应商 | 接入方式 | 开关 |
|---|---|---|
| xiaomi | baseURL → 路由代理（**新接入**，profile 补 `api` + `baseURL`） | ✅ |
| opencode-go | baseURL → 路由代理 | ✅ |
| agentrouter | baseURL → 路由代理 | ✅ |
| **commandcode** | 桥接**热读 mode.json**（**新实现**） | ✅ |
| antigravity | 第三方工具，无法控制 | ❌ 面板已标注"由外部工具控制·开关不可用" |

**运行中合成配置实证**（`./dsh --profile web --dump-config`，2401 行，exit=0）：

```
xiaomi-token-plan-cn  baseURL: http://127.0.0.1:8318/xiaomi-token-plan-cn
opencode-go           baseURL: http://127.0.0.1:8318/opencode-go
agentrouter           baseURL: http://127.0.0.1:8318/agentrouter
commandcode           baseURL: http://127.0.0.1:8317/v1
antigravity           baseURL: http://127.0.0.1:8045
```

## 9.3 本轮的四个真 bug 修复

1. **`provider-router/start.sh` 缺 `setsid`**（严重）
   裸 `nohup … &` 起的进程仍挂在调用它的 shell 会话上，会话一收就被带走 ——
   这是 DSH 重启后 router 消失、**3080/8317/8318 三个端口全空**的根因。
   改为 `setsid nohup … < /dev/null &`（与 commandcode-bridge 一致）。

2. **`restart-dsh.sh` 3/3 次「只杀不起」**（18:40 / 18:46 / 20:27）
   从 shell 起脚本会随 DSH 死亡被一起带走。改为**自举进 systemd 瞬时单元**：
   ```sh
   exec systemd-run --user --collect --setenv=DSH_RESTART_IN_UNIT=1 restart-dsh.sh
   ```
   （`systemd-run --user` 已实测可用：单元能起、命令执行、结束后自动回收。）

3. **启动器 `--trusted-host` 追加条件过宽**
   `[ "$1" = "web" ] || [ "$1" = "--profile" ]` 让 `./dsh --profile web --dump-config`
   也追加该参数，实测报错：
   `error: config dumps take no app arguments, got "--trusted-host" …`
   改为扫描全部参数：遇到 `web` 置真，遇到 `--dump-config/--help/--version` 置假。

4. **commandcode 桥接的 undici 坑**
   SSR 路径最初报 `UND_ERR_INVALID_ARG` —— Node 内置 fetch 用内部 undici 副本，
   与 `import('undici')` 拿到的 npm 那份 dispatcher 不兼容。**必须配套使用同一份
   undici 的 `fetch` + `ProxyAgent`**。

## 9.4 对另一 agent 报告的逐条核对

| 它的说法 | 核对结果 |
|---|---|
| start.sh 缺 setsid | ✅ **属实**，已修 |
| restart-dsh.sh 3/3 失败 | ✅ **属实**，已改用 systemd-run |
| 启动器 `--trusted-host` 条件过宽 | ✅ **属实**，已修 |
| "xiaomi/commandcode 的开关不影响实际路由" | ❌ **证伪**：它按"router 里 loopback 恒直连"**推断**，没注意 commandcode 的 baseURL 指向**桥接**（桥接自己读 mode.json）。实测 xiaomi 经代理 401/0.17s ✅；commandcode 热切换 direct 0.77s → ssr 0.85s → 还原 0.24s ✅；运行中合成配置也证明 xiaomi 的 baseURL 就是路由代理 ✅ |
| antigravity 8045 没跑 | ✅ 属实（第三方工具未启动；面板已如实标注） |
| agentrouter 401 是 key/风控问题 | ✅ 属实（与路由无关；路由 1.5s 到达上游）；**实测 agentrouter 可达，只是容易触发敏感词风控** |

## 9.5 遗留（未做，供后续决定）

- ~~**DSH 常驻方案**~~ → **已做**，见 §10.1（systemd user service）。
- **antigravity 供应商**：依赖第三方 `antigravity-tools`(8045)，它没跑时该供应商不可用。
- **agentrouter 401**：**实测可达**（经 SSR），主要是**容易触发敏感词风控**；与路由无关。

---

# 10. 交叉复核与修正（2026-10-04 深夜）

另一个 agent 独立复核后**认错并交出了自己的错误机制**，两条都值得记下来。

> **真相源分工**
> 本文档（`playground/themes/PROVIDER_ROUTING_PLAN.md`）是**路由/网络侧的权威文档**
> —— §9 全测矩阵、§10 交叉复核。
> **dsh 运维侧**（进程 / 服务 / 启动器 / 双机同步）见仓库根部的
> [`SYNC.md`](../../SYNC.md)。
> 两边措辞冲突时，**以实测数字为准**，并对齐一次。
>
> **历史**：曾有一份 `HANDOFF.md`（`~/dsh/HANDOFF.md`、`D:\ZZZArea\HANDOFF-dsh.md`，
> 后合并到第一台桌面的 `HANDOFF-dsh.md`），已于 2026-10-04~06 删除；
> 现行文档只有本文件与 `SYNC.md`，**都在仓库内**，不再保留机器本地的副本
> （见 `SYNC.md` §9）。

## 10.1 DSH 已改为 systemd 用户服务

`~/.config/systemd/user/dsh.service`：

```ini
ExecStart=/home/guava5tar_/dsh/dsh web --no-open     # 仍走启动器 → API key / --trusted-host / 桥接 / 路由代理全照旧
Restart=on-failure
RestartSec=5
```

实测：`is-active=active`、`is-enabled=enabled`、**`MainPID` 就是 dsh 本体**、
`Restart=on-failure/5s`、router 同属该服务。
重启：`systemctl --user restart dsh.service`（或 `~/dsh/restart-dsh.sh`，它会先停服务、
再清不受 systemd 管理的野生实例、最后启动 —— 野生实例占着 3080 会导致服务起不来）。

**linger：已启用（本文件曾误记为「未做」，2026-10-04 21:30 实测更正）**

```
$ loginctl show-user guava5tar_ -p Linger   →  Linger=yes
$ ls -la /var/lib/systemd/linger/           →  guava5tar_  root  0  Oct  4 14:48
$ loginctl list-sessions                    →  c5  1000  guava5tar_  manager  （无登录，存活至今）
    WSL 启动 = 10:58:16，linger 于 14:48:38 启用
```

所以**当前实际是第 2 档，不是第 1 档**。措辞注意 —— 在 WSL 上 linger **不等于「开机即起」**：

| 档 | 方案 | 实际效果 | 现状 |
|---|---|---|---|
| 1 | 无 linger | 有活动 session / 已登录时服务才起 | ❌ 已不是现状 |
| 2 | + `enable-linger` | **WSL 实例一被启动**就起服务，不必先登录 | ✅ **已生效** |
| 3 | + linger + Windows 侧任务拉起 WSL（`wsl.exe -d <distro> -u <user> true`） | Windows 重启后**只要登录过 Windows**，手机就能连 | ❓ 待用户定 |

关键点：linger 只保证「**WSL 已经在跑**时用户服务自动起」，它管不了 WSL 本身 ——
Windows 重启后若没人碰 WSL（没开终端、没跑 `wsl.exe`，或被 `wsl --shutdown` / idle timeout
回收），整个发行版都不在运行，linger 无从生效。

**第 3 档的一个措辞坑**：「登录时」触发的任务仍然要求**有人登录 Windows** ——
真正「无人登录也起」需要「启动时」触发（要管理员权限，且 session 0 里 WSL 行为不可靠）。
所以第 3 档实际买到的是「**不必开终端，登录 Windows 就够**」，不是字面意义的开机即起。

第 3 档要不要做，等用户拍板；**不代跑 sudo / 不动 Windows 任务计划**。

三档要不要动、动到哪一档，等用户拍板；**不代跑 sudo**。

## 10.2 【重要陷阱】`https_proxy` 会静默接管 curl，污染「直连 vs SSR」的测量

另一个 agent 最初得出「agentrouter 直连能通（401）」的错误结论，是因为**它的 shell 继承了
`https_proxy=http://127.0.0.1:2080`**，`curl` 默认跟着走 SSR —— 它以为的「裸直连」其实绕了代理。
Node 不认这些变量，所以 Node 侧才是诚实的。

**本机复核结论**：
- 我自己的 shell **没有**代理变量；DSH 进程（pid 14770）也**没有任何 proxy 变量**，
  且 `NODE_USE_ENV_PROXY` 未设置 → DSH 的连接是真直连。
- 但**测量时仍应显式声明**：直连用 `curl --noproxy '*'`，走 SSR 用 `curl --proxy http://127.0.0.1:2080`。
- 该变量不来自 `~/.bashrc`/`/etc/profile.d`，是 WSL/父进程继承的，所以不同会话可能不一样。

带上显式声明重测，矩阵与 §9.1 一致：**只有 agentrouter 需要 SSR**（真直连 15s 超时，
SSR 1.54s 到达）。

## 10.3 agentrouter 直连失败的真正原因：DNS 污染

```
agentrouter.org → 199.59.148.201 / 154.83.15.20        ← 被污染（IPv4 会漂移）
                → 2a03:2880:f10f:83:face:b00c:0:25de   ← Facebook 段 IPv6
                → 2a03:2880:f112:83:face:b00c:0:25de
```

这些地址 `ETIMEDOUT` / `ENETUNREACH`，与「被墙」的表现一致 —— 所以**它必须走 SSR**。

**污染指纹（比「DNS 污染」这个说法更可操作）**：

| | 行为 |
|---|---|
| IPv4 | **漂移** —— 观测到 `199.59.148.201`、`154.83.15.20`，每次可能不同 |
| IPv6 | **特征恒定** —— `2a03:2880:*:face:b00c:*`（Facebook 段），只有中段（`f10f`/`f112`）变 |

本会话内两次独立观测印证：第一次 `curl -v` 是 `2a03:2880:f10f:83:face:b00c:0:25de`，
后来 502 body 里是 `2a03:2880:f112:83:face:b00c:0:25de` —— **前缀漂移、`face:b00c:0:25de` 不变**。
所以判断污染看 IPv6 尾部即可，别盯 IPv4。

**连带发现**：Node 在「所有地址都失败」时抛的是 `AggregateError`，而**它的 `message` 是空串**，
所以 router 原先只打印 `upstream error: `（后面什么都没有），完全无法诊断。

**已修**（`router.mjs` 新增 `describeUpstreamError()`）：把 `code`、`cause`、
以及聚合里**每个地址的 code/地址**都带出来。真实失败下的输出：

```
upstream error: ETIMEDOUT | ETIMEDOUT 154.83.15.20:443 connect ETIMEDOUT 154.83.15.20:443
              | ENETUNREACH 2a03:2880:f112:83:face:b00c:0:25de:443 ...
```

现已做到「**只看响应体就能定位**」（另一条会话逐字节复现一致）。

## 10.4 鉴权围栏的顺序（文档更正）

本插件的路由从手写同源检查换成了官方 `ctx.connection.requestRejection()`。实测顺序是
**Host/Origin 信任 → 浏览器 cookie → method**：

| 请求 | 实际返回 |
|---|---|
| 无 cookie 的 GET | **401**（不是 405） |
| 无 cookie 的 POST | 401 |
| 伪造 Origin | 403 |
| 带 cookie 的 GET | 405 |
| 带 cookie 的 POST | 200 |

所以 §8.4 里「handler 异常路径 11/11」的 **GET → 405 那条，前提是「已通过围栏（带 cookie）」**；
裸 curl 会先被 401 挡下。这一点已在 `getToken` 上实测：无 cookie → 401；
走正常登录流程拿 cookie 后 → 返回与 `logs/web-run.log` 一致的 token 与 `ygy12.tailef4f13.ts.net`。

## 10.5 mode.json 的持久值会覆盖默认值

`mode.json` 里的显式值优先于 `DEFAULT_MODES`（设计如此 —— 那正是「手动切换」的落点）。
所以「只有 agentrouter 走 SSR」是**默认值**；若 mode.json 里另有残留（例如面板上点过一次
`opencode-go`），生效的就是 2 家 SSR。**排查时先看 mode.json，再看 DEFAULT_MODES。**

本次已清除测试残留，当前 `mode.json` 与默认一致：
`xiaomi/opencode-go/antigravity/commandcode = direct`，`agentrouter = ssr`。




