# ADAPTIVE-PLAN — 插件"随供应商/模型变化自适应"落地方案

> 建立：2026-10-22
> 触发问题：`provider-router` 面板只认 5 家供应商，而 profile 里已有 7 家 —— 新供应商
> 不会出现在面板上、`auto` 静默回落 `direct`。要求：能自动随供应商/模型变化提供默认设置。

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 路由插件能做自适应吗？ | **能**，而且当前已在漂移（见 §1 实测），是本轮主要工作 |
| 其他插件都能吗？ | **不能一刀切**。能自动推导的只有"事实型"配置；"意图型/审美型/破坏型"必须留给人 |
| 最大障碍 | 上游 `/models` **不提供任何能力字段**，`created` 是假时间戳 → "哪个模型最好"永远无法推导 |

## 1. 实测到的漂移（本轮要修的）

```
profile 里 7 家                                    provider-router 认识 5 家
xiaomi-token-plan-cn / opencode-go / antigravity   ✅
agentrouter / commandcode                          ✅
agentrouter-responses                              ❌ 面板无此行
opencode                                          ❌ 面板无此行
```

根因三处硬编码：
- `plugins/provider-router/lib/index.js` 的 `DEFAULT_MODES`（一次性测量后写死）；
- `plugins/provider-router/lib/router.mjs` 的 `BUILT_IN_PROVIDERS`；
- `plugins/provider-router/lib/client.js` 的 `PROVIDERS` 数组。

## 2. 自动化的三层数据源（全部是 DSH 提供的公开接口）

| 层 | 接口 | 给到什么 |
|---|---|---|
| L1 事实 | `ctx.llm.listProviders()` / `listConfigurableProviders()` | live 供应商 + 可配置（休眠）路由 + 显示名 |
| L2 事实 | `ctx.llm.listModels(provider)` | `inputModalities`（能否看图）、`contextWindow`、`efforts[]`、`defaultEffort` |
| L3 实测 | `probe.mjs` + 路由双路测速 | 真能否调通、**能否挂工具**、是否 `slow`、direct vs SSR 谁快 |

**能自动化的（事实型）**：供应商行、路由模式、`compat` 开关、上下文/预算、能力标注。
**不能自动化的（意图型）**：默认模型、`allowedModels`、免费策略、价格额度、密钥。

## 3. 分阶段计划

### P1 — `provider-router` 自适应（本轮核心）

1. **供应商目录自适应**：面板行改为从 `ctx.llm.listProviders()` ∪ `listConfigurableProviders()`
   ∪ 内置兜底生成；新供应商自动出现，休眠路由标灰。
2. **路由代理可发现**：`router.mjs` 新增只读端点 `GET /_router/state`
   （已知前缀 + 上游 host + 当前模式 + 自动测量结果）。host 据此判断某供应商
   **能不能**被本代理承载（`control: router / bridge / external / unknown`），
   不再靠客户端写死。
3. **真正的 `auto` 模式**：`auto` = 每次决策前实测 `direct` 与 `ssr` 的首字节，
   取快者并缓存（TTL 10 分钟）；只有一个通就用那个；都不通回落 `direct`。
   面板显示实测数字（**依据可见，不是黑盒**）。
4. **版本握手**：host 声明 `apiVersion`，client 低于它就提示"宿主是旧版、要重启"，
   避免重演 `web-search-switch` 那次"点了没反应"。
5. **未知前缀可解释**：路由代理对未知前缀返回 404 时列出已知前缀；面板对
   "指向 8318 但上游表里没有"的供应商直接提示补 `providers.json`。

### P2 — `dsh-web-search-switch` 可用性回落（小）

首选后端不可用（无 key / 探测失败）时**自动回落**另一个并在面板标注
"已回落"；不让一次缺 key 把 `web_search` 整个打挂。

### P3 — 已自适应 / 不需要做的（写清楚原因，避免以后重复讨论）

| 插件 | 判定 | 理由 |
|---|---|---|
| `dsh-opencode-session-header` | **已经是自适应的** | 按**实际请求 host** 匹配 allowlist（子域自动覆盖），开关运行时热读；新增 host 无需改代码 |
| `dsh-context-guard` | **已经是窗口相对量** | 阈值是 `projectedTokens / contextWindow` 的**比例**（默认 60%），不是绝对 token 数；换 1M 窗口自动按比例放大 |
| `dsh-mobile-ui` | 已经是设备自适应 | 靠 `dsh-phone` 判定 + 安全区，无供应商/模型依赖 |
| `dsh-session-purge` | **明确不做**（用户要求） | 破坏性操作，"智能猜"是风险而非功能 |
| `dsh-theme-manager` / `cyberpunk` / `dsh-code-theme` | **明确不做**（用户要求） | 审美/意图型 |

> context-guard 的 60% 是**产品决策**（手机渲染成本），不是模型容量限制 ——
> 所以即使窗口变大也不该自动推到 92%。要按模型容量压缩，得显式改配置。

## 4. 验收标准

- 面板行数 == `ctx.llm.listProviders()` ∪ 可配置路由（本机 7 家）；
- 新增供应商（不重启插件，重载 profile 后）能出现在面板；
- `auto` 模式有实测数字且在两者都通时选快者；
- 未知前缀的 404 文案列出已知前缀；
- 版本握手：旧 host + 新 client 时面板明确提示重启；
- 新增自检 `tools/tests/provider-router-adaptive.mjs` 全过；
- `install --check` / `model-policy` / `web-search-switch` / `preflight` 全绿。

## 5. 落地状态（2026-10-22 完成）

| 项 | 状态 | 位置 |
|---|---|---|
| P1.1 auto 决策纯逻辑 | ✅ | `plugins/provider-router/lib/auto-mode.mjs` |
| P1.2 profile 读 baseURL | ✅ | `plugins/provider-router/lib/profile-providers.mjs` |
| P1.3 router 自省 + auto 实测 + 未知前缀提示 | ✅ | `plugins/provider-router/lib/router.mjs` |
| P1.4 host 目录自适应 + apiVersion 握手 | ✅ | `plugins/provider-router/lib/index.js` |
| P1.5 client 行来自 state.providers + 三态 + 实测按钮 | ✅ | `plugins/provider-router/lib/client.js` |
| P2 web-search-switch 可用性回落 | ✅ | 只回落"配置缺失"，上游故障照实报错 |
| P3 其余插件"已自适应/不做"的判定 | ✅ | 见 §3 |
| 自检 | ✅ | `tools/tests/provider-router-adaptive.mjs`（52 项） |

**实测验证**（本机，2026-10-22）：

```
agentrouter     direct 不可用(311ms 失败) / ssr 2388ms  → 选 ssr（与历史结论一致）
opencode-go     direct 1326ms / ssr 825ms              → 选 ssr
xiaomi          direct 118ms / ssr 106ms（差 12ms）    → 选 direct（平手规则）
commandcode     loopback 5ms                            → 选 direct（不绕代理）
antigravity     loopback 4ms                            → 选 direct
```

面板目录从 5 家 → **7 家**（补上 `agentrouter-responses` 与 `opencode`），
control 全部按真实 baseURL 推导。

## 6. 不做的事（边界）

- 不自动改 `agent-default-model` / `allowedModels` / 免费策略（意图型）。
- 不让路由代理在主请求路径上做"重试式探测"（会把延迟放大）。
- 不引入第三方包（社区有 Tavily/SearXNG provider，但属供应链信任问题）。
