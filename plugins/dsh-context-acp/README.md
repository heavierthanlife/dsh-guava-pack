# dsh-context-acp — 模型驱动的上下文压缩（ACP 全套能力）

> 目标：把 `dsh-compaction-basic` 的「到阈值就自动压」换成 ACP 式**模型驱动压缩**：
> 模型决定何时压、压哪一段、摘要自己写（零额外 LLM 调用），并能检索/恢复被压原文。
> 这是在本机 DSH `0.2.1-alpha.3` 上的**第一方重写**，不是安装
> `billion-context-dsh`（那个包 peer 锁 `0.2.0-rc.2`，装不上）。

## 为什么需要它

内置压缩只有一条策略：`agent/pre-step` 时压力过阈值 → 引擎自己选区间 → 引擎**再调一次 LLM**
写摘要。三个问题：

1. **什么时候压不由模型决定**：模型可能正处在需要原始细节的阶段，却被自动压掉。
2. **压哪段不由模型决定**：引擎按 `retainRatio` 机械保留尾部，可能压掉刚读过的关键证据。
3. **摘要要额外调一次 LLM**：花一次完整请求的钱和时间；而且摘要质量取决于通用提示词，
   不是当前任务的上下文。

ACP 的做法是把这三件事交还给模型：nudge 提醒压力、`acp_status` 给账本、
`compress` 让模型指定区间并**自己写摘要**、`decompress` / `search_context` 找回原文。
本插件就是这套能力的完整实现。

## 架构（为什么这样拆）

```
ctx.compaction（preset realm，4 个 preset 各一份）
└── dsh-context-acp/engine  ← 行名替换了 compaction-basic
    └── AcpEngine extends BasicCompactionEngine
        ├── summarize()         ：优先用 compress 工具投递的模型自写摘要（零 LLM 调用）
        ├── compactIfNeeded()   ：常规压力返回 null（只 nudge）；overflow 保留父类抢救
        └── compactRegion()     ：全盘继承（surface 替换事务/记账/锁都在父类，绝不重写）

根平面（host）
└── dsh-context-acp（lib/index.js 装配）
    ├── tools：compress / decompress / search_context / acp_status
    ├── agent/pre-step：nudge（只提醒，不自动压；提醒本身是一条 logged user 消息，见下）
    ├── systemPrompt section：压缩规则与哲学
    ├── /acp 命令（status / blocks / nudge / handoff）
    └── 面板：session projection `contextAcp` + /context-acp 路由 + composer pill
```

关键事实（踩过坑，写下来）：

- **`ctx.compaction` 住在 agent preset realm**：`dsh-web-app` 把根平面的
  `compaction-basic` 显式 disabled。根插件**不能** `inject(['compaction'])`，
  必须用 `ctx.get('agentPresets').serviceFor(agent, 'compaction')` 取实例
  （浏览器 RPC 也走这条路）。headless 这类 preset-free 组合才回落到根平面 `ctx.compaction`。
- **Cordis 会把 service 包进 traceable Proxy**：类里的 JS `#private` 字段经 proxy
  调用会抛 `Cannot read private member`。本插件的引擎用模块私有 Symbol 键代替 `#`。
- **preset 覆盖只能整棵 `config.plugins` 替换**：手写必失配，所以由
  `tools/gen-acp-preset.mjs` 从上游 `@deepseek-ai/dsh-web-app/presets/*.patch.yml`
  确定性生成，并校验上游 sha256；`--check` 进 `npm test` 与 `install.mjs --check`。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/engine.mjs` | `AcpEngine`（三个覆写点）+ 待用摘要通道 + backend 切换包装 |
| `lib/barriers.mjs` | 注入行屏障（纯函数）：活动用户消息 / AGENTS.md 当前副本 / skill 目录 / system |
| `lib/tools-compress.mjs` | `compress`：`planCompress`（纯校验）+ 事务投递 |
| `lib/ledger.mjs` | 从会话日志重建块账本（b1..bN / tier / seq 映射 / 统计） |
| `lib/tools-restore.mjs` | `decompress`（分页取回原文）+ `search_context`（零依赖混合检索） |
| `lib/tools-status.mjs` | `acp_status`（账本/占用/上次 nudge/checkpoint 映射） |
| `lib/nudge.mjs` | `decideNudge` 纯策略 + `agent/pre-step` 注入壳 |
| `lib/prompt.mjs` | 系统提示段（稳定文本，保 KV cache） |
| `lib/command.mjs` | `/acp` 子命令 |
| `lib/settings.mjs` | 面板数据：projection `contextAcp` + `/context-acp` 路由 + 设置落盘 |
| `lib/state.mjs` | 每 agent 瞬时状态（WeakMap；只放「日志里没有也不该进日志」的东西） |
| `lib/fallback.mjs` | **兜底自动压缩**的纯逻辑：数「未被响应的 nudge」+ 决策（≥75% 且连续 2 次） |
| `lib/handoff.mjs` | **交接文档**（从 context-guard 迁移）：从日志重建统计 → 写 `HANDOFF-context-acp-*.md`；压缩次数增加时原地刷新同一份；含接线 `installHandoffHook`（`turn/end` + `compaction/end`） |
| `client.js` | 面板 pill（composer dock，沿用 context-guard 样式） |
| `config/acp.json` | **唯一人工配置源**（backend / nudge / retain / engine） |
| `config/preset-override.generated.yml` | 生成物：4 个 preset 的 `config.plugins` 覆盖 |
| `config/runtime.json` | 生成物：根插件读的运行时配置 |
| `cordis.patch.yml` | bundle patch：根平面挂载 `context-acp` |
| `../../tools/gen-acp-preset.mjs` | preset 覆盖层生成器（`--write` / `--check` / `--backend basic`） |

## 配置与回滚

配置只改 `config/acp.json`，然后：

```sh
node tools/gen-acp-preset.mjs --write   # 重生成 preset 覆盖层 + runtime.json
# 重启 DSH（host 插件改动需要重启）
```

**回滚到内置压缩**（重启生效，代码路径会切回上游 `BasicCompactionEngine` 类本身）：

```sh
node tools/gen-acp-preset.mjs --write --backend basic
# 或者把 config/acp.json 的 backend 改成 "basic" 再跑 --write
```

回滚后根插件保持惰性：不注册工具、不挂 nudge、不留提示段；preset 行原样保留
`@deepseek-ai/dsh-compaction-basic`。切回 `--write --backend acp` 即恢复。

主要旋钮（`config/acp.json`）：

| 键 | 默认 | 含义 |
|---|---|---|
| `nudge.pressureRatio` | 0.65 | 超过这个占用比例才提醒模型（**不会**自动压） |
| `nudge.growthTokens` | 12000 | 上次 nudge 后至少再涨这么多才重复提醒 |
| `nudge.cooldownSteps` | 6 | 同一 turn 内的步数冷却 |
| `nudge.maxPerTurn` | 2 | 每 turn 最多提醒几次 |
| `retain.decompressPageSize` | 8 | `decompress` 默认每页条数 |
| `retain.searchLimit` | 20 | `search_context` 默认命中数 |
| `retain.protect*` | true | 三类注入行屏障开关（system 恒保护） |
| `fallback.enabled` | true | 兜底自动压缩开关（关掉 = 纯模型驱动，无安全网） |
| `fallback.ratio` | 0.75 | 兜底阈值（生成器同时写进引擎行 `basic.thresholdRatio`，两处同源） |
| `fallback.afterUnansweredNudges` | 2 | 连续几次 nudge 没被响应才动手 |
| `fallback.retryCooldownSteps` | 3 | 兜底失败（无可压区间）后的节流步数 |
| `handoff.enabled` | true | 交接文档开关 |
| `handoff.afterCompactions` | 2 | 压缩满几次**开始**写（每个会话始终一份文件） |
| `handoff.prefix` | `HANDOFF-context-acp` | 文件名前缀 |
| `handoff.refreshOnHigherCompaction` | true | 压缩次数比上次写时更高 → 原地刷新同一份（关掉 = 写完冻结） |
| `backend` | `"acp"` | `"basic"` = 回滚到内置压缩 |

## 兜底自动压缩 + 交接文档（2026-10-27 合并 `dsh-context-guard`）

合并前有两个插件、两个药丸、两套压缩触发：ACP（模型决定）和 context-guard（到 65%
**无条件**自己压）。二者会**抢同一件事**，而且 UI 上重复统计同一个
`compaction/summary` 事件（用户实际看到「压缩 1 次」+「ACP 1 块」是同一件事）。

合并后的退化链是**一条**：

```
nudge（提醒模型）──模型响应──> 模型自己 compress（模型写的摘要，零额外 LLM 调用）
        │
        └──连续 2 次没响应 且 占用 ≥75%──> 兜底自动压缩（引擎 LLM 摘要，父类 pressure 策略）
                                              │
                                              └── provider 确认超窗 ──> context-overflow 抢救
```

为什么兜底走父类而不是新写：区间选择、tool-pair 平衡、`compaction/summary` 记账必须由
**唯一 token meter** 完成（ACP #54/#103 的教训）。阈值通过生成器写进引擎行的
`basic.thresholdRatio`，与面板上的兜底阈值是同一个数（改 `acp.json` 后必须重跑
`gen-acp-preset --write`，否则面板显示 75% 而引擎按旧值动手）。

**交接文档**：从 `dsh-context-guard` 迁移的 `HANDOFF-context-acp-<sid8>-<时间>.md`
（一个会话始终只有一份，文件名不带压缩次数），在 **`turn/end` 与 `compaction/end`**
两个事件上检查；统计（轮/步/压缩次数/释放 token/路由）全部从
`session.snapshotEvents()` **现场重建**，所以同一份日志永远生成同一份文档。

**刷新语义（2026-10-29 增强）**：文件一旦写出，之后每次压缩完成（次数比上次写时高）
就**覆盖刷新同一份** —— 否则长会话从 c2 压到 c6，交接文档会永远停在 c2 的旧快照
（摘要少了两次、统计全旧）。代价是每次压缩多写一次盘（频率天然被压缩事件限制，
不是每步写盘）；并发触发（`compaction/end` 紧跟 `turn/end`）用 per-session promise 链
串行化，保证不会写出两份。`handoff.refreshOnHigherCompaction=false` 可回到「写完冻结」。
旧命名 `…-c<N>-…` 的历史文件仍会被认领并**原地刷新**（不改名），重启后也能续写。
面板显示「写没写、写在哪、为什么没写」。

为什么要加 `compaction/end`：手动 compact 是一次**独立命令**（日志里 `turn: null` +
`sourceCommandId`），压缩完成时没有任何轮结束。只在 `turn/end` 检查的话，用户手动压满
两轮后直接关会话，就永远等不到交接文档（2026-10-29 实测就是这样：账本已有 b1/b2 两个块，
目录里一份 handoff 都没有）。另外 `/acp handoff [--force]` 可以当场触发检查、
`--force` 无视阈值立即写一份（换会话 / 收尾时用）。

**移除 context-guard**：profile `dsh.profile.bundles` 已删掉 `dsh-context-guard`
（依赖仍保留，回滚时加回一行 + 重启即可）。旧文件 `HANDOFF-context-guard-*.md`
不会被新插件认领，但内容仍可读。

## nudge 的真实语义（一条重要偏离，别按旧文档理解）

`agent/pre-step` 返回的 `messages` 在 DSH `0.2.1-alpha.3` 里会被 agent-loop **写进会话日志**
（`dsh-agent-loop/lib/index.js`：除 `source.kind === 'runtime-context'` 外一律
`session.append('user/message', message, {surfaceOp:'append'})`；而 `runtime-context`
会被跳过 → 模型根本看不到提醒）。所以 nudge **不是**「只进本次请求投影」：

- 每条提醒都是一条真实的 user 消息（`source: {kind:'context-acp', form:'notice'}`），
  会出现在对话历史里、可回放、可被 `decompress` 找回；
- 频率由 `pressureRatio` / `cooldownSteps` / `growthTokens` / `maxPerTurn` 四重限制，
  不会变成刷屏；
- 这对账本与屏障是**安全**的：它不是用户输入（不会触发活动用户消息保护），
  旧提醒也可以被后续 compress 压掉（属于过时历史）。

**注意**：`source.kind` 是合法的 MessageSource 形状（有单测直接用真实 `Session.append`
钉住），不要改成 `runtime-context` —— 那会让提醒静默消失。

## 安全边界（验收逐条查）

1. **注入行屏障**：AGENTS.md 等策略文件的**当前副本**、`<available_skills>` 最新目录、
   当前活动用户消息、surface 第 0 个 system 节点 → 拒绝压缩并点名 seq。
   **被取代的旧副本允许压**（它们才是该进历史的部分）。
2. **并发锁**：`compactRegion` 自带 `compaction/start` 持久化锁；工具层再加 per-agent
   `inFlight` 防重入。
3. **记账只用宿主 tokenMeter**：`shadowedTokenCount` / 收益判定都由宿主的固定启发价算，
   插件不自己估算 —— 否则会把宿主账本扣成负数（ACP #54/#103 的教训）。
4. **收益拒绝**：摘要（含 checkpoint 框架）不比原文短就拒绝（`no-gain`）。
5. **零额外 LLM 调用**：模型 `compress` 路径的摘要来自工具投递，不设 `llmStreamCall`；
   只有非模型发起的路径（overflow 抢救 / `/compact` / 自动）才回落父类 LLM 摘要。
6. **失败可见**：工具错误带稳定 `code`；引擎/工具失败写 logger 与面板状态；屏障判不了就拒绝。

## 门禁（全部在隔离 profile 里跑，不碰 live）

```sh
node tools/tests/acp-mount.mjs    # P0：preset 覆盖组合 + 引擎真实激活 + 工具可见 + 回滚
node tools/tests/acp-engine.mjs   # P1：引擎/屏障/compress 规划（纯单测）
node tools/tests/acp-ledger.mjs   # P2：账本/恢复/检索/status（纯单测）
node tools/tests/acp-nudge.mjs    # P3：nudge/命令/设置/提示段（纯单测）
node tools/tests/acp-e2e.mjs      # P1 级端到端（真实隔离 DSH 进程 + preset agent）
node tools/tests/acp-e2e.mjs --strict   # P4 级：再加账本/tier2/恢复/检索硬断言
node tools/tests/acp-client.mjs   # 面板客户端模块能进 boot 清单并编译出 bundle
node tools/gen-acp-preset.mjs --check   # 上游漂移
```

## 已知限制

- **需要重启 DSH**：preset 覆盖层与根插件都在 host 侧加载。
- **面板 pill 的「上次 nudge」是进程级最新一条**：客户端 slot 拿不到 sessionId，
  每会话数据走 projection，nudge 瞬时状态只能全局展示（面板标注「本进程最新」）；
  `/acp status` 里的 nudge 才是该会话自己的（读共享 state 的 per-agent 值）。
- **面板只暴露两个可调项**（阈值%、增长 tokens）；`decompressPageSize` / `searchLimit`
  仍可在 `config/acp.json` + 面板 HTTP 路由的 `setSettings` 调整，只是没放成步进控件。
- **`compactRegion` 需要在 turn 内调用**：模型在 turn 中调 `compress` 天然满足；
  没有 turn 的外部调用会被父类拒绝（这是父类的锁语义，不是本插件的限制）。
- **上游升级会漂移**：升级 DSH 后必须重跑 `gen-acp-preset.mjs --write` 并跑
  `--check`；`install.mjs --check` 会拦。
- `protected-unreadable` / `protected-system-prompt` 是屏障内部的细分 code，
  工具对外统一返回 `code:'protected'`，细分写在 message 里。
