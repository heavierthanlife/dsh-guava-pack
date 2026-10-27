# ACP-PLAN — 在本机 DSH `0.2.1-alpha.3` 上实现全套"智能压缩"（取代哑阈值压缩）

> 建立 2026-10-27。目标：把 `billion-context-dsh`（ACP）那套**模型驱动压缩**的能力，
> 在本机现有版本上**第一方重写**，而不是安装那个包（它 peer 锁 `0.2.0-rc.2`，我们装不了）。
>
> 工作模式：Lead 出计划/接线/验收 → 子代理（`commandcode/deepseek-v4.1-flash`）写具体模块
> → Lead 逐阶段跑门禁。

---

## 0. 可行性结论（已核验，不是推测）

| 依赖 | 结论 | 证据 |
|---|---|---|
| `ctx.compaction` 接缝 | ✅ 可替换后端 | `@deepseek-ai/dsh-compaction` 导出抽象类 `CompactionEngine`：`compactIfNeeded` / `compactNow` / `compactRegion` |
| 模型指定区间压缩 | ✅ 公开 API | `compactRegion(start, end, agent, signal)` 是 `CompactionEngine` 的抽象方法，`BasicCompactionEngine` 已实现 |
| **模型自写摘要（不二次调 LLM）** | ✅ 官方唯一 hook | `BasicCompactionEngine` d.ts 原文："`summarize()` is the sole subclass customization hook" |
| 摘要返回契约 | ✅ 已确认形状 | `SummaryResult = { summary: ContentBlock[], provider, model, maxTokens?, usage?, rawOutput?, llmStreamCall? }`；自写摘要不设 `llmStreamCall` |
| 工具表 / 命令 | ✅ 有 API | `ctx.tools.register(defineTool({name, description, parameters, execute(args, exec)}))`；`ctx.commands.register({...})` |
| nudge 注入点 | ✅ | `agent/pre-step` waterfall（内置 compaction-basic 也挂在这里） |
| 读取原文（decompress/search） | ✅ | `session.snapshotEvents(from,to)` / `eventAt(seq)` / `surface.nodes` / `deriveMessages()` |
| 替换 preset 里的后端 | ✅ 支持 | `dsh-web-app/presets/*.patch.yml` 里 `preset-cordis` 的注释明说：profile patch 可按 id override 该行的 `config.plugins`（Web 预设编辑器就是这么存的） |
| 工作子代理模型 | ✅ 实测可用 | `commandcode/deepseek/deepseek-v4.1-flash`：HTTP 200 / 2.3s / `finish: tool_calls` / 1M 窗口 / 已加入 `allowedModels` |
| ⚠️ 子代理前置 | **必须新会话** | `allowedModels` 在会话启动时固化（本会话已冻结） |

**结论：能办到。** 不存在需要"改上游包"的硬阻塞。

---

## 1. 与 ACP 的能力对照（本次要补齐的"全套"）

| ACP 能力 | 我们当前 | 本次目标 |
|---|---|---|
| 模型决定何时压 | 固定 65% 阈值 | nudge（阈值+增长+冷却），模型自行决定 |
| 模型决定压哪段 | 引擎按 `retainRatio` 自选 | `compress(startSeq,endSeq,summary)` 工具 |
| **模型自写摘要** | 引擎再调一次 LLM | 覆写 `summarize()`，用工具传入的文本（零额外调用） |
| checkpoint 持久化 | 引擎自带 | 复用 `compactRegion` 的 `compactCheckpointSource` |
| `decompress` 恢复原文 | ❌ | 新工具（分页） |
| `search_context` | ❌ | 新工具（混合检索） |
| `acp_status` 账本 | ❌ | 新工具 + 面板 |
| 注入行屏障 | ❌（真实风险） | 新模块（AGENTS.md 当前副本 / skill 目录 / 活动用户消息） |
| 分层蒸馏 T2/T3 | ❌ | 压 checkpoint 节点 = 蒸馏 |
| `/acp` 命令 | ❌ | 新命令 |
| overflow 抢救 | 内置自带（0.8） | 保留 |

---

## 2. 架构决策

### 2.1 复用 `BasicCompactionEngine` 作为基底（不重写事务）

理由：surface 替换事务 + 记账 + 幂等 + `compaction/start|end` 持久化锁，全在
`compactRegion()` 里；重写它 = 重写 DSH 最危险的一段代码。我们只覆写**三个点**：

```js
class AcpEngine extends BasicCompactionEngine {
  async summarize(input, agent, signal) {
    const pending = takePendingSummary(this);   // compress 工具给的文本
    if (pending !== undefined) {
      return { summary: [{ type: 'text', text: pending.text }], provider: pending.provider, model: pending.model };
    }
    return super.summarize(input, agent, signal); // 自动/手动压缩仍可回落到 LLM
  }
  async compactIfNeeded(agent, trigger) {
    if (trigger === 'context-overflow') return super.compactIfNeeded(agent, trigger, signal); // 抢救保留
    return null;                                        // 常规压力：只 nudge，不自动压
  }
  // compactRegion 全盘继承（模型指定区间时由工具调用）
}
```

### 2.2 必须替换 preset 内的后端

`ctx.compaction` 是 preset realm 的服务（`isolate: { compaction: true }`）；根平面那份是
`disabled: true`。所以要在 profile patch 里对 `preset-cordis`（以及其它三个 preset）
`override` 其 `config.plugins`：把 `compaction` group 里的 `compaction-basic` 行换成
`name: dsh-context-acp/lib/engine.mjs`。

**漂移风险**：`config.plugins` 是整棵数组替换，上游 preset 升级会失配。
对策：`tools/gen-acp-preset.mjs` 从 `node_modules/@deepseek-ai/dsh-web-app/presets/*.patch.yml`
**生成** override 块（确定性变换），`--check` 比对上游哈希；`install.mjs --check` 与
`preflight` 都跑它。升级 DSH 后一条命令重新生成。

### 2.3 插件拆分（**写作用域不重叠**，便于并行子代理）

```
plugins/dsh-context-acp/
  package.json               # Lead
  cordis.patch.yml           # Lead（root：工具/nudge/路由/命令总装）
  index.js                   # Lead（只做装配，写的人不碰）
  lib/engine.mjs             # A：引擎子类 + pending summary 通道
  lib/barriers.mjs           # A：受保护区判定（纯函数）
  lib/tools-compress.mjs     # A：compress 工具
  lib/ledger.mjs             # B：从日志重建块账本 / tier / seq 映射（纯函数为主）
  lib/tools-restore.mjs      # B：decompress + search_context
  lib/tools-status.mjs       # B：acp_status
  lib/nudge.mjs              # C：pre-step nudge 策略（纯函数 + 薄事件壳）
  lib/prompt.mjs             # C：系统提示段（压缩规则/哲学）
  lib/command.mjs            # C：/acp
  lib/settings.mjs           # C：设置落盘 + HTTP 路由
  client.js                  # C：面板 pill（沿用 context-guard 的成熟样式）
  tools/gen-acp-preset.mjs   # Lead（pack 内，不在插件内）
tools/tests/acp-*.mjs        # 各自负责自己的，Lead 补 e2e
```

---

## 3. 接口契约（子代理照此实现，不许自行改形状）

### 3.1 `compress`

```js
{ startSeq: number, endSeq: number, summary: string, verifiedReadings?: string[] }
→ { ok: true, compactionId, seqs: {start,end}, shadowedTokens, tier }
  | { ok: false, code: 'unbalanced'|'protected'|'active'|'missing'|'no-gain'|'busy', message }
```

规则：边缘必须 tool-pairing 平衡（用 `toolPairingBalancedBefore/After`）；
活动用户消息、AGENTS.md **当前副本**、skill 目录 → 直接拒绝并点名；
预估收益 ≤ 0（summary 比原文长）→ 拒绝（`no-gain`）；被压的是 checkpoint 节点 → `tier+1`。

### 3.2 `decompress`

```js
{ block?: 'b3', compactionId?: string, offset?: number, limit?: number }
→ { ok: true, blocks: [{seq, role, text}], next?: number, total }
```

只读日志：`session.snapshotEvents()` 找 `replace` 事件的 `shadowedRange` 与 checkpoint 源。

### 3.3 `search_context`

```js
{ query: string, scope?: 'all'|'summaries'|'originals', limit?: number }
→ { ok: true, hits: [{ block: 'b3', seq, score, excerpt }] }
```

零依赖混合打分：token 化（CJK 用 bigram）+ 词干近似 + 子串加权；**不引第三方包**。

### 3.4 `acp_status`

```js
{ scope?: 'blocks'|'context', view?: 'summary'|'messages'|'ranges', limit?: number }
→ { ok: true, blocks: [...], totals: {tool, text, summaries}, nudge: {state, reason, nextAt}, checkpoints: {b3: seq} }
```

### 3.5 引擎内部通道

`compress` 工具 → `engine.compactRegion(start,end,agent)` 之前，把摘要文本投递到
引擎实例的**按 agent 隔离的待用槽**（`WeakMap<agent, PendingSummary>`），`summarize()` 取走；
取不到 → 回落 `super.summarize()`。**禁止全局变量**（并发子代理/多会话会串）。

---

## 4. 安全 / 边界（验收会逐条查）

1. **注入行屏障**：AGENTS.md 等策略文件的**当前副本**、`<available_skills>` 最新目录、
   当前活动用户消息 → 拒绝压缩（点名 seq，提示可切区间）。被取代的旧副本允许压。
2. **并发锁**：`compactRegion` 自带 `compaction/start` 锁；工具层再加 `inFlight` 防重入。
3. **记账**：`shadowedTokenCount` 必须用宿主 `ctx.tokenMeter` 的固定启发价计算
   （`heuristicTokens ?? tokens`），**不得**用插件自己的估算 —— 否则会把宿主账本扣成负数、
   卡死中文会话（ACP issue #54/#103 的教训）。
4. **收益拒绝**：summary 不比原文短就拒绝，避免"压了反而更大"。
5. **可回滚**：配置 `backend: 'acp' | 'basic'`；切换后重启即回内置，
   `compaction-basic` 行保留在生成器里，随时能切回。
6. **失败可见**：所有工具错误带稳定 `code`；引擎异常写 `logger.warn`（首次）+ 面板。

---

## 5. 阶段计划与验收门禁

| 阶段 | 谁做 | 交付 | 验收门禁（Lead 跑） |
|---|---|---|---|
| **P0 尖刀验证** | Lead | 隔离 profile 里确认「preset override + 引擎挂载」可行；写入骨架（engine/tools 空实现、index.js 装配、生成器） | 新会话/隔离进程里 `ctx.compaction.constructor.name === 'AcpEngine'`；`acp_status` 工具可见；无双 provider 冲突；回滚开关可切回 basic |
| **P1 引擎 + compress + 屏障** | 子代理 A | `engine.mjs` / `barriers.mjs` / `tools-compress.mjs` + 单测 | A 的 `node tools/tests/acp-engine.mjs` 全过；Lead 在 scratch 会话手工 compress 一次，`compaction/start|summary|end` 出现且**无第二次 LLM 调用**（日志计数） |
| **P2 账本 + 恢复 + 搜索 + status** | 子代理 B | `ledger.mjs` / `tools-restore.mjs` / `tools-status.mjs` + 单测 | B 的测试全过；Lead 压完后 `decompress` 取回原文、`search_context` 命中、`acp_status` 账本数字与日志一致 |
| **P3 nudge + 提示段 + 命令 + 面板** | 子代理 C | `nudge.mjs` / `prompt.mjs` / `command.mjs` / `settings.mjs` / `client.js` + 单测 | C 的测试全过；Lead 验：压力到阈值出现 nudge（不自动压）、`/acp status` 正常、面板显示块数/占比/上次 nudge |
| **P4 端到端** | Lead | `tools/tests/acp-e2e.mjs` + 隔离 profile 全流程 | 造 70% 压力的 scratch 会话：nudge → 模型调 compress → 压力下降 → decompress/search 可用 → **AGENTS.md 当前副本被拒** → 回滚到 basic 后行为恢复 |
| **P5 收尾** | Lead | 文档（README/PLAN/HANDOFF）、`install.mjs` 清单、全量门禁、提交推送 | `npm test` / `install --check` / `preflight` / sync dry-run 全绿；commit |

依赖：P1 → P2 → P3 串行（P2/P3 依赖 P1 的引擎 API）；A/B/C 的**文件互不重叠**，
P2 的 `ledger.mjs` 纯函数部分可与 P1 并行起稿，但合并按 P1→P2 顺序。

---

## 6. 子代理协议（Lead 派发时按此写任务书）

每个子代理必须收到：

1. **工作目录**：`/home/guava5tar_/dsh/playground/themes`，仓库 `dsh-guava-pack`。
2. **只允许写**：本阶段列出的文件（明确列路径）。**禁止**改 `index.js`、`cordis.patch.yml`、
   profile、其它插件、`npm` 依赖。
3. **必须遵守**：ESM、零新依赖、中文注释解释"为什么"、纯逻辑与 IO 分离、错误带稳定 code。
4. **必须自查**：`node --check <file>`；跑本阶段测试；报告格式：
   `改了什么 / 测试结果 / 未决问题 / 需要 Lead 决策的点`。
5. **禁止**：重启 DSH、写 profile、`git commit`、动 live 会话。
6. 模型：`provider=commandcode, model=deepseek/deepseek-v4.1-flash`。
   若同一任务连续两次失败，Lead 改派 `agentrouter/deepseek-v4-flash` 或亲自写。

Lead 在每阶段结束时：读 diff → 跑全量门禁 → 只由 Lead 接线 `index.js` → 进入下一阶段。

---

## 7. 验收清单（最终）

**自动**
- [ ] `npm test`：原有 4 套 + `acp-engine` / `acp-restore` / `acp-nudge` / `acp-e2e` 全过
- [ ] `node install.mjs --check` = 0；`preflight` = 0；`sync-plugins --dry-run` 零差异
- [ ] `tools/gen-acp-preset.mjs --check` = 0（preset 与上游一致，无漂移）

**功能（隔离 profile）**
- [ ] nudge 出现但不自动压（`compactIfNeeded` 返回 null，日志无 `compaction/start`）
- [ ] 模型 `compress` 后：`compaction/start` + `compaction/summary` 出现，摘要文本 == 模型写的
- [ ] 摘要调用次数 = 0（不额外调 LLM）
- [ ] `decompress` 取回原文（分页正确）；`search_context` 命中被压内容
- [ ] `acp_status` 的块数/占比/checkpoint seq 与日志一致
- [ ] **AGENTS.md 当前副本 / skill 目录 / 活动用户消息** 被拒绝（错误码 `protected`）
- [ ] 二次压缩 checkpoint = tier 2
- [ ] 回滚 `backend: basic` → 重启 → 内置压缩恢复

**人工**
- [ ] 面板 pill 显示块数/占比/上次 nudge；错误可见
- [ ] 会话跑 1 小时无异常（无 unhandledRejection、无账本负数）

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| preset `config.plugins` 整树替换 → 上游升级漂移 | 生成器 + `--check`；`install.mjs --check` 纳入 |
| 双 provider 冲突（basic 未禁用） | P0 就验；生成器强制删 `compaction-basic` 行 |
| 账本扣成负数（ACP #54/#103） | 只用宿主 `tokenMeter` 固定启发价；e2e 断言压力单调非增 |
| 压缩→重注入死循环（ACP #71） | 注入行屏障 + e2e 断言 AGENTS.md 被拒 |
| skill 目录被压后永久丢失（ACP #185） | 同一屏障 |
| ds4.1flash 产出质量不稳 | 每阶段门禁 + 失败即改派；Lead 保留亲自写关键模块的权利 |
| 子代理越界改文件 | 任务书写死文件清单；Lead 全量 diff 审查 |
| 会话/进程开销 | P1–P3 用现有 live 进程的 scratch 会话；不启第二个常驻 DSH |

---

## 9. 前置条件（当前状态）

- [x] `commandcode/deepseek/deepseek-v4.1-flash` 实测可用、工具调用正常
- [x] 已加入 profile `subagent-model-selection-settings.allowedModels`（+ 分发包模板）
- [ ] **需要新会话**：本会话 `allowedModels` 已冻结，子代理派不出去
- [ ] P0 尖刀验证（Lead 在新会话第一步做）

## 10. 新会话开场指令（复制给新会话）

```
按 dsh-guava-pack/ACP-PLAN.md 执行。先做 P0 尖刀验证并给结论；
通过后用 subagent(provider=commandcode, model=deepseek/deepseek-v4.1-flash)
按 P1/P2/P3 派发，每阶段回来跑门禁、接线 index.js、再进下一阶段；
P4/P5 由你亲自做验收与提交，最后给我验收报告。
```
