# dsh-context-guard

在 DSH 自带的上下文占用显示（composer 里那个环形 `ContextMeter`）之外，
补上你真正需要的那几件事：

| 需求 | 实现 |
|---|---|
| 看到**已压缩次数** | 面板里的「已压缩次数」+「上次释放 tokens」，来自本插件注册的 `contextGuard` 投影 |
| 超过 **60%** 自动压缩 | 阈值在 `contextPressure`（token-meter）上判断，默认 `0.6` |
| **不能在任务运行中压缩** | 只在 `turn/end`（默认仅 `completed`）之后动手；且调用 `ctx.compaction.compactNow()`，它带 **idle admission**，agent 不空闲直接抛 `busy` —— 由 service 强制，不靠自觉 |
| 压缩 **2 次后**自动写详细 handoff | 写 `<会话 cwd>/HANDOFF-context-guard-<sid8>-c<N>-<时间>.md` |
| 提示开新 session | pill 变警示色并写明「已写出，建议开新会话」 |

## 显示在哪

一块 pill 挂在 `conversation.composer.dock`，**id `context-guard`、order 1**，
紧挨着自带「X 轮 X 步」pill（id `stats`，order 0）和原生上下文环。

点开面板（**向上向左**展开，所以不会被右下角"回到底部"按钮压住；点面板外或按 Esc 关闭）：

| 行 | 内容 |
|---|---|
| 已用上下文 | 百分比（来自 token-meter 的 `contextPressure`） |
| 上下文窗口 | 容量 |
| 自动压缩 | 已就绪 / 未就绪（见下） |
| 自动压缩阈值 | **可调**：`▼ 60% ▲`，20–95%，每档 5%，**按住连续调整** |
| 压缩几次后写 handoff | **可调**：`▼ 2× ▲`，1–5，每档 1，**按住连续调整** |
| 已压缩次数 / 上次释放 | 来自 `contextGuard` 投影 |
| handoff | 还差几次 / 已写出建议开新会话 |

pill 本体是 `压缩 N 次` + 一个 **zip 压缩包图标**（方框 + 拉链虚线 + 拉链头）。
字号、行高、内距、圆角、数字对齐**照抄宿主同排的两块**（`StatsPills` 的
`color:--dsw-alias-label-tertiary; gap:6px; padding:1px 8px; radius:999px` 与
`ContextMeter` 的 `font-size:--dsh-content-font-size-secondary(13px)` +
`line-height:calc(20px + --dsh-content-font-delta-secondary)`），所以并排看着是一套。

### 两个可调参数怎么真的生效

只改界面不改行为的面板是装饰，所以面板会 `POST /context-guard/setSettings` 把值回传 host：

- host 侧自注册 `webServer` 前缀路由，并用 **`ctx.connection.requestRejection()`**
  套上 connection 自己的 Host/Origin 围栏与浏览器鉴权（与 `/api` 同级），
  而不是自己糊一个同源检查。这条通路是 `provider-router` 验证过的：
  `ctx.provide` 不会桥接到浏览器，而 `connection.rpc.handle` 从外部插件不可用。
- 值写回运行时的 `settings`，**阈值与 handoff 次数立刻按新值工作**；
  同时落盘到 **`$DSH_HOME/context-guard.json`**（默认 `~/dsh/context-guard.json`）。
- 启动时该文件**优先于** patch 里的 `config`（面板上调过的值不会被 patch 静默改回）。
  想恢复 patch 的值：删掉这个文件再重启。

**一个必须知道的显示细节**：投影（`contextGuard`）只在**会话事件**时重新发布，而改设置
不产生会话事件 —— 所以保存成功后**不能**回落到投影，否则面板会立刻弹回旧值，看着像
"没保存"（实测踩到：保存其实早已成功写入文件）。现在的显示优先级是
`面板即时值 → 最近一次保存成功的值 → 投影`，并在成功后显示 1.6s 的「已保存」。

### 面板排版

照抄宿主面板（会话统计对话框 / ContextMeter）：`font-size:12px; line-height:18px;
padding:16px; border-radius:var(--dsw-radius-lg); background:var(--dsw-specific-menu);
box-shadow:var(--dsw-elevation-prominent)`。
**不要**用 `--dsh-content-font-size-secondary`：它会被 `ui-theme` 的 `fontSize` 放大
（本机 17），面板会比自带面板明显大一圈。

**为什么不用新 slot 塞进原生那两块**：`StatsPills`（X 轮 X 步）和 `ContextMeter`
都是宿主 `dsh-client-ui-chat` / `dsh-client-ui-conversation` 里的硬编码 JSX，
**没有内部 slot**。要么顶掉 `stats` 那格（覆盖宿主 UI，升级易碎），要么在旁边加一格。
这里选后者。

## ⚠️ 一个必须知道的部署事实：compaction 住在 agent preset 里

本 profile 的 `dsh-web-app/cordis.patch.yml` 把**根平面**的 `compaction-basic`
和 `command-compact` 设成 `disabled: true`（有意为之：compaction 是 preset 拥有的能力），
改由 `dsh-web-app/presets/cordis.patch.yml` 的 `compaction` group 按 preset 挂载，
并 `isolate: { compaction: true }`。

**后果一**：根上下文的 `ctx.compaction` **不存在**，而且 **`agent.ctx` 也看不到它** ——
`dsh-agent-preset-registry` 的原文是 "The agent's own key is parented to its preset's
standing key, so the mount is **not under the agent's fiber**"，被 `isolate` 的服务只在
该 realm 内可见，所以从 agent 上下文 `inject` **永远解析不到**（这一条是实测踩出来的：
第一版就是这么写的，面板显示"未就绪"）。

正确的读地址是注册表的
**`ctx.agentPresets.serviceFor(agent, 'compaction')`** —— 该方法的文档正是为这种情况写的：
"This is read addressing for a caller that already holds the agent … a host row that
`inject`s a service cannot use it"。浏览器 RPC 也走这条路。

所以本插件对每个 live agent：用 `serviceFor` 解析实例 + 在 `agent.ctx` 上听
`session/event`。插件激活时用 `ctx.agents.list()` 接管**已经活着**的 agent
（安装插件时正在跑的会话也算），之后由 `agent/created` 接管新 agent。

**后果二**：preset 自带的「步间」自动压缩（默认 `thresholdRatio: 0.8`）**仍然存在**，
而且**没法从这里关掉** —— 对禁用行做 config 覆盖是空操作，而 preset 里的
`compaction-basic` 行在**多个 preset 里各有一份、id 相同**（实测 **3** 个：
`cordis` / `ptc` / `standard`；`minimal` 里没有），按 id 覆盖只会命中其中一个。
本插件的缓解办法是每轮结束就主动压到 60% 以下，所以步间压缩在实践中很少介入。
**要彻底禁止步间压缩，需要改 agent preset**（另一件事，建议单独做）。

## 面板上的「自动压缩」指示灯

`armed`：至少有一个 agent 的 realm 里解析到了 compaction 服务吗。
**显示"未就绪"就意味着自动压缩不会触发** —— 这是刻意的诚实指示灯，不是静默失效。

## 配置

`cordis.patch.yml` 里 `id: context-guard` 那行的 `config`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.6` | 触发压缩的上下文占用比例 |
| `handoffAfterCompactions` | `2` | 压缩到第几次后写 handoff |
| `writeHandoff` | `true` | 是否真的落盘（关掉只提示） |
| `triggerOn` | `['completed']` | 允许触发的 `TurnEndReason.kind` |
| `handoffPrefix` | `HANDOFF-context-guard` | 文件名前缀 |
| `maxRecentUserMessages` | `8` | handoff 里带多少条最近用户消息 |

> 本插件**没有**导出 `Config`：DSH 的插件 Config 必须是原生 **Schemastery** schema
> （`isNativeConfigSchema` 按 `Symbol.for('schemastery')` 判定），而本机没有
> schemastery 可解析；导出 zod 对象会让 Config 投影变成
> `status: "unsupported"` 并在 Plugin Manager 留一条诊断。所以配置在代码里兜底校验。

## handoff 里写了什么

全部来自会话日志（会话日志是唯一事实来源）：

1. 头部：会话 id、时间、cwd、模型路由、轮/步数、压缩次数、上下文窗口
2. 本会话 `write`/`edit` 动过的文件清单
3. **每一次压缩的摘要**（`compaction/summary` 的正文）—— 被折叠历史的官方浓缩，价值最高
4. 最近 N 条用户消息
5. 「下一步」模板位

## 已知限制

- 面板百分比来自 token-meter 的 `contextPressure`；该投影缺失时显示 `—`，
  且**不会**触发自动压缩（没有容量信息就不动手）。
- 压缩失败（busy / cancelled / changed / summary / commit / persistence）不写任何东西，
  等下一次对话自然结束再试。
- **改这个插件的 `index.js` 后需要重启 DSH 才会加载新的模块代**（安装新 bundle 可以
  热激活行，但替换已加载模块需要重启）。
