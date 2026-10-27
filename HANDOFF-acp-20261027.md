# HANDOFF — 模型驱动压缩（dsh-context-acp）落地记录

> 2026-10-27。给下一个会话/下一位维护者：这份是**操作手册 + 决策记录**，
> 设计与边界见 `plugins/dsh-context-acp/README.md`，方案原文见 `ACP-PLAN.md`（§11 是执行记录）。

## 1. 现在是什么状态

- 插件已完整实现并通过全部门禁（在**隔离 DSH_HOME** 里验证，**没有**装进 live profile）：
  `npm test` 全绿 = 原有 4 套 + `acp-engine`(25) / `acp-ledger`(18) / `acp-nudge`(27)
  + `acp-mount`(10) / `acp-e2e --strict` / `acp-client` + `gen-acp-preset --check`。
- 四件事是这次的核心成果，别回退：
  1. **引擎替换在 preset realm 内生效**（4 个 preset 的 `compaction` group 里
     `compaction-basic` 行被换成 `dsh-context-acp/engine`），根平面无第二份 provider。
  2. **模型自写摘要零额外 LLM 调用**：`compress` 把摘要投递到引擎实例的 per-agent 槽，
     `summarize()` 直接返回（`llmStreamCall` 不设）。
  3. **常规压力只 nudge 不自动压**：`compactIfNeeded('pressure')` 返回 null；
     `context-overflow` 仍保留父类抢救。
  4. **注入行屏障**：活动用户消息 / AGENTS.md 当前副本 / skill 目录 / system 节点被拒；
     **被取代的旧副本可压**。

## 2. 装到 live 的操作（唯一需要人工的一步）

```sh
cd ~/dsh/playground/themes/dsh-guava-pack
node install.mjs --check                    # 必须 0
node tools/gen-acp-preset.mjs --check       # 必须 0（上游漂移会拦）
dsh plugin --profile web add ~/dsh/playground/themes/dsh-guava-pack/plugins/dsh-context-acp
systemctl --user restart dsh.service        # 注意是 restart（start 对活跃服务是空操作）
```

装完验收（新会话）：
- 面板 composer dock 出现 `ACP N 块 · xx%` pill；点开能看到块/tier/上次 nudge。
- 输入 `/acp status` 有账本输出；`/acp blocks` 列块。
- 压力高的时候模型会收到一条 `[acp-nudge]` 提醒（是历史里的 user 消息，见下）。
- 模型调用 `compress` 后：`compaction/start|summary|end` 三件套、
  `acp_status.blocks` 增加、`decompress`/`search_context` 可用。
- **必须不存在**：根平面多出来的 compaction provider、自动压缩事件（nudge 场景下）。

回滚（重启生效，代码路径回到上游 `BasicCompactionEngine`）：

```sh
node tools/gen-acp-preset.mjs --write --backend basic
systemctl --user restart dsh.service
# 恢复：node tools/gen-acp-preset.mjs --write && restart
```

## 3. 两个必须知道的坑（都是实测）

### 3.1 nudge 会写一条 user 消息进日志（不是污染，是宿主语义）

`dsh-agent-loop` 对 `agent/pre-step` 返回的 messages **硬读 `source.kind`**，除
`'runtime-context'` 外一律 `session.append`。而 `runtime-context` 会被跳过 →
模型根本看不到提醒。所以 nudge 消息带 `source:{kind:'context-acp', form:'notice'}`
落进历史，受 `pressureRatio/cooldownSteps/growthTokens/maxPerTurn` 限制。
单测里用真实 `Session.append` 钉住了这个 source 形状（`tools/tests/acp-nudge.mjs`）。

### 3.2 preset 覆盖层是生成物，永远不要手改

`plugins/dsh-context-acp/config/preset-override.generated.yml` 由
`tools/gen-acp-preset.mjs` 从上游 `@deepseek-ai/dsh-web-app/presets/*.patch.yml`
确定性生成，头部记上游 sha256。**DSH 升级后必须重跑 `--write`**，否则
`npm test` / `install.mjs --check` 会红（这是故意的：整棵 `config.plugins` 覆盖
一旦漂移是静默失配，少挂一个工具不会报错）。

另外：引擎行是裸说明符 `dsh-context-acp/engine`，所以**插件包必须能从 profile 的
node_modules 解析**。pack 的 package.json 已声明 `file:./plugins/dsh-context-acp`；
单独安装时要把插件包本身 `dsh plugin add` 进 profile。

## 4. 文件地图（谁负责什么）

```
plugins/dsh-context-acp/
  lib/engine.mjs         AcpEngine（summarize/compactIfNeeded 覆写）+ backend 切换包装
  lib/barriers.mjs       注入行屏障（纯函数，fail closed）
  lib/tools-compress.mjs compress = planCompress（纯校验）+ stageSummary + compactRegion
  lib/ledger.mjs         从 session 日志重建块/tier/统计（事实唯一来源）
  lib/tools-restore.mjs  decompress（分页原文）+ search_context（零依赖混合检索）
  lib/tools-status.mjs   acp_status
  lib/nudge.mjs          decideNudge/renderNudge/createNudgeHandler/installNudge
  lib/prompt.mjs         系统提示段（稳定文本）
  lib/command.mjs        /acp
  lib/settings.mjs       projection `contextAcp` + /context-acp 路由 + 设置落盘
  lib/state.mjs          每 agent 瞬时状态（WeakMap）
  client.js              composer dock pill
  config/acp.json        唯一人工配置源
  config/preset-override.generated.yml / runtime.json   生成物（提交）
tools/gen-acp-preset.mjs preset 覆盖生成器（--write / --check / --backend basic）
tools/tests/acp-*.mjs    门禁（mount/engine/ledger/nudge/e2e/client）
tools/tests/lib/acp-driver.mjs  进程内 e2e 驱动（只在隔离 profile 里经 --patch 挂载）
```

## 5. 未做/待观察（人工项）

- 面板 pill 的**视觉与交互**未人工验收（自动门禁只证明客户端模块进 boot 清单且
  bundle 能编译）。装到 live 后看一眼：块数/占比/上次 nudge/错误可见。
- **长时间运行**（1 小时）观察：无 unhandledRejection、无负账本、tier 推导稳定。
- **style A（pack 整体作为一个 bundle 安装）** 未在隔离环境完整跑（需要模拟 pnpm 的
  file: 依赖安装 + 禁用 pack 其它插件）；本机 live profile 用的是 style B（逐插件 link）。
  如果另一台机器按 README 单包安装，请先 `ls profiles/web/node_modules/dsh-context-acp`
  确认插件被 file: 依赖带进来了，再重启验证。
