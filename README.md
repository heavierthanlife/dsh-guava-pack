# dsh-guava-pack — 一个包带走全部插件

把本机这套 DSH 定制（手机 UI、供应商路由、主题管理、改装赛博主题、OpenCode 会话头修复、
上下文守卫、已归档会话清理、**模型驱动的上下文压缩 ACP**）连同 CommandCode 桥接服务，
打成一个**可离线分发**的包。
换台机器（含云端）**git clone 一次就能用**。

## 里面有什么

| 路径 | 内容 | 来源 |
|---|---|---|
| `plugins/dsh-mobile-ui` | 手机上像 App 一样的排版/触控/安全区 | 自研 |
| `plugins/dsh-theme-manager` | 设置里的主题管理页 | 自研 |
| `plugins/provider-router` | 供应商直连 / 经 SSR 路由 + 状态面板（**可配置**） | 自研 |
| `plugins/dsh-theme-cyberpunk2077` | 赛博朋克 2077 主题（**改装版**） | ⚠️ 原作者 Tommy00748，MIT |
| `plugins/dsh-opencode-session-header` | 修 OpenCode 的 `400 MissingSessionID`（**改装版**：本机代理路由也打头） | ⚠️ 原作者 beihzb，MIT |
| `plugins/dsh-context-guard` | **已合并进 `dsh-context-acp`（2026-10-27）**：自动压缩→兜底压缩、handoff→ACP 内；代码保留用于回滚，**patch 行已 `disabled: true`**，不再挂载 | 自研 |
| `plugins/dsh-context-acp` | **模型驱动压缩（ACP 全套）**：nudge 提醒 → 模型自己选区间/写摘要（零额外 LLM 调用）→ 账本/`decompress`/`search_context` 找回原文；**兜底自动压缩**（连续 2 次 nudge 未响应且 ≥75%）+ **交接文档**（压满 2 次写 handoff）；替换 4 个 agent preset 的 `compaction-basic` 后端 | 自研 |
| `plugins/dsh-session-purge` | 清理已归档会话记录（保留产出并写清单），侧栏入口在设置上方一行 | 自研 |
| `plugins/dsh-code-theme` | 只给代码上色（Monokai Pro / Material / One Dark / GitHub / **OpenCode 官方色值**，共 5 套），自动跟随明暗 + 可强制代码区明暗；附 WCAG 对比度自检 | 自研 |
| `config/cordis.patch.example.yml` | provider / 模型目录示例（6 家、24 个模型，全走本机路由） | 自研 |
| `config/model-policy.yml` | **模型选型意图表** —— 每家要哪些模型（`sync-model-policy` 读它） | 自研 |
| `ops/` | 运维脚本：`bootstrap-machine.sh`（新机装 dsh.service + linger）、`restart-dsh.sh`、`tailnet-url.sh`（打印带 token 的手机访问地址）、`dsh.service`、`bashrc.dsh.example`、`wsl.conf.example`；`NETWORK-NOTES.md` 手机连不上/流式卡/Tailscale 绕代理的排查手册 | 自研 |
| `services/commandcode-bridge` | 把 OpenAI 格式转成 Command Code 内部端点 | 自研 |

第三方组件的授权与出处见 [`LICENSES/`](LICENSES/)。**两个第三方包都在原作者 MIT 授权范围内**：
`dsh-theme-cyberpunk2077` 是**改装衍生版**（改动逐条记在 LICENSES §1）；
`dsh-opencode-session-header` 也是**改装版**（改动逐条记在 LICENSES §2）——
上游只认 `opencode.ai` 主机名，而这套 profile 的 `opencode-go` 走本机代理
（`127.0.0.1:8318/opencode-go`），hostname 恒为回环地址，上游规则永不命中。
本副本补了一条「回环 + 路径首段 `opencode-go`」的匹配，其余行为不变。两者都保留了各自的 LICENSE / 仓库地址。
`plugins/dsh-opencode-session-header` 是 vendored 的第三方副本（版本 `0.1.0-dsh.1`）：它的 `tests/smoke.mjs`
以上游 v0.1.0 的 13 条断言为基底、追加本副本的 9 条（现 **22 passed / 0 failed**），所以 `npm test` 可以跑。
上游出新的话，`lib/` 与 `tests/` 都要一起比对更新（本副本的 diff 很小，见 LICENSES §2）。

> ⏸ **运行期未验证**：上面这条改装「真正发出的头值是什么」尚未在活进程里观测过
> （当前没有 `opencode-go` 订阅流量；且日志不落该插件的 info 行、沙箱看不到宿主进程）。
> 注意 profile 里还有一条静态兜底 `x-opencode-session`，它会**掩盖**注入失效——
> 「能用」不等于「插件生效」。开通订阅后照 [`PENDING-VERIFICATION.md`](PENDING-VERIFICATION.md)
> §1 的 echo 配方验一次（含「两个会话头值是否不同」）。

> `ops/bootstrap-machine.sh` 是 **DSH 主仓库根目录**那份 bootstrap 的副本：它 clone DSH 仓库、
> 对仓库根与 `profiles/web` 各跑一次 `pnpm install`，并假定在 DSH 仓库根目录下执行。
> 本包保留它只作参考 / 迁移材料，**不是本包自己的安装路径**（本包是把 bundle 加进已有 profile）。

## 安装

```sh
# 0) 取包 —— 统一走 git clone，不再用 .tgz
git clone git@github.com:heavierthanlife/dsh-guava-pack.git ~/dsh-guava-pack

# 1) 装进目标 profile
dsh plugin --profile web add ~/dsh-guava-pack

#    等价于：在该 profile 目录里 pnpm add，并把包名写进 dsh.profile.bundles
#    旧版 CLI 也可手工两步：
#      cd <dsh>/profiles/web && pnpm add ~/dsh-guava-pack
#      然后在 profiles/web/package.json 的 dsh.profile.bundles 里加上 "dsh-guava-pack"

# 2) 重启 DSH（host 侧插件必须重启才加载）
systemctl --user restart dsh.service      # 或你原来的启动方式

# 3) 浏览器刷新一次（客户端 bundle 会重建）

# 以后更新：git pull 后重复 2、3
```

> 本包不再发布 `.tgz`。要更新就直接 `cd ~/dsh-guava-pack && git pull`。
> 本机（开发侧）改完插件后，用 `node tools/sync-plugins.mjs` 把工作副本同步进包再提交。
>
> ⚠️ **改客户端插件（`client.js`）后刷新页面即可，不必重启 DSH。**
> 客户端 bundle 由 `/plugins/??<ids>&rev=<hash>` 提供，响应头是
> `public, max-age=31536000, immutable`，所以必须靠 `rev` 变化来失效。
> `rev` = `framedHash("plugin-artifact",[mtimeMs, ctimeMs, size])`，取的是**激活时的快照**，
> **不是每次请求重算**；刷新靠 `dsh-client-hmr` 每 **500ms** `stat` 轮询，变了才重建并通知浏览器。
> （原文写"每次请求重算 mtime+size"是错的 —— 结论"刷新即生效"仍然成立，但机制不同：
> 靠的是 HMR 轮询，不是请求时重算。）
> 刷新后仍是旧行为的话，那是浏览器端缓存 —— 用带查询参数的地址打开（如 `?v=2`）
> 或清一次该站点存储。**host 侧（`index.js`）改动才需要重启。**

## 安装后配置（重要）

### 模型驱动的上下文压缩（ACP）—— 装完必须做的一步

`plugins/dsh-context-acp` 替换的是 **agent preset 里**的压缩后端（preset 是
`dsh-web-app` 声明的，profile patch 只能整棵覆盖它的 `config.plugins`）。
所以 preset 覆盖层由生成器从上游 preset 文件**确定性生成**，不允许手写：

```sh
node tools/gen-acp-preset.mjs --check   # 校验与上游 preset 一致（升级 DSH 后必跑）
node tools/gen-acp-preset.mjs --write   # 上游升级后重生成，然后重启 DSH
```

- 回滚内置压缩：`node tools/gen-acp-preset.mjs --write --backend basic`（重启生效）。
- 交接文档：压满 `handoff.afterCompactions`（默认 2）次后，在每次 `turn/end` **或**
  `compaction/end` 自动写 `HANDOFF-context-acp-<sid8>-c<N>-<时间>.md`（写在工作目录）。
  手动 compact 不在 turn 里，所以只靠 `turn/end` 会拖到下一轮 —— 2026-10-29 起
  `compaction/end` 也算触发点；当场要一份用 `/acp handoff`，无视阈值用 `/acp handoff --force`。
- 配置：`plugins/dsh-context-acp/config/acp.json`（唯一人工配置源），改完重新 `--write`。
- 生成物 `config/preset-override.generated.yml` + `config/runtime.json` **要提交**；
  `install.mjs --check` 与 `npm test` 都会跑 `--check` 拦上游漂移。
- ⚠️ 引擎行是裸说明符 `dsh-context-acp/engine`：本插件必须能从 profile 的
  `node_modules` 解析（pack 已声明 `file:./plugins/dsh-context-acp` 依赖；
  单独安装时要把插件包本身加进 profile）。
- 完整设计/安全边界/门禁见 [`plugins/dsh-context-acp/README.md`](plugins/dsh-context-acp/README.md)。

### provider-router 是可配置的 —— 云端不需要改代码

路由代理是个独立小进程（默认 `127.0.0.1:8318`），全部行为都能用环境变量/JSON 覆盖：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_ROUTER_HOST` / `DSH_ROUTER_PORT` | `127.0.0.1` / `8318` | 监听地址与端口 |
| `DSH_SSR_PROXY`（或 `SSR_PROXY`） | `http://127.0.0.1:2080` | 翻墙代理地址；**这是换机器最常改的一项** |
| `DSH_ROUTER_PROVIDERS` | `<包>/plugins/provider-router/providers.json` | 上游表 JSON 路径 |
| `DSH_ROUTER_CAPTURE` | 关 | 排障抓包，**开了会把提示词明文落盘**，见下 |

上游表：复制 `plugins/provider-router/providers.example.json` 为 `providers.json` 后按需增删。
改完要重启路由代理。

```sh
# 启动（幂等，带健康检查）
plugins/provider-router/start.sh

# 健康检查
curl -s http://127.0.0.1:8318/health
```

⚠️ **抓包开关**：`DSH_ROUTER_CAPTURE=1` 会把 agentrouter 的**完整请求体**（含你的提示词和
整段对话）明文写入 `plugins/provider-router/captures/req-<时间戳>.json`（只保留最近 8 份）。默认关闭；
只在排障时临时打开，用完立刻删除文件，**不要把抓到的内容随包分发**。

### ⚠️ node_modules 补丁 —— 不打的话 Anthropic 协议 provider 容易 400

有两个补丁**不在插件目录里**，而是改 DSH 安装目录下的 `node_modules`。
换机器只装包不打补丁，走 `api: anthropic-messages` 的路由（现在只剩 `antigravity`）仍会 400。
（这两个问题最早是在 `agentrouter` 的 `deepseek-v4-flash` 通道上暴露的；该路由已于
**2026-10-27 随上游模型下线而废弃**，见下面的「AgentRouter 变更」。）

| 补丁 | 改的文件 | 修什么 |
|---|---|---|
| `patches/apply-required-array.sh` | `@deepseek-ai/dsh-tools/lib/index.js` | 工具 schema 恒输出 `required`（含空数组）。AgentRouter 的 deepseek-v4-flash 通道把「缺失的 required」判成 null → `400 null is not of type "array"` |
| `patches/apply-anthropic-tool-fixes.sh` | `@earendil-works/pi-ai/dist/api/anthropic-messages.js` | ① 每个 `tool_use` 补上缺失的 `tool_result`（上下文裁剪会删掉大结果）② `tool_use` 稳定重排到 assistant 消息末尾。修 `400 tool_use ids were found without tool_result blocks immediately after`。<br>*(注：针对 DSH 0.2.1+ 已适配 `assistantLevels` 索引重映射与 `cache_control` 新锚点)* |

```sh
node install.mjs --patch          # 幂等，已打过就跳过
# 或直接分别执行：
# bash patches/apply-required-array.sh
# bash patches/apply-anthropic-tool-fixes.sh
```

**作用域**（都已核实，不会误伤其他模型）：

- 补丁①是全局的 —— 影响 dsh 自己声明的内置工具 schema；语义等价（`required: []` ≡ 不写），
  已实测 xiaomi 两种写法都 200。MCP 工具的 schema 原样透传，不受影响。
- 补丁②只作用于 `api: anthropic-messages` 的 provider（现为 `antigravity`；2026-10-27 前还包括 `agentrouter` 的 Anthropic 路由）；
  openai 系走另一个文件，完全没动。

**这两个补丁会在 dsh 依赖升级后被 npm/pnpm 覆盖** —— 升级完必须重跑补丁脚本。
脚本自带幂等标记和锚点断言：锚点找不到会**直接报错**而不是静默改坏代码。

### 🔄 DSH 升级与排障标准流程（必读防坑指南）

#### 1. 核心陷阱：`systemctl --user start` 对活跃服务是空操作
- **现象**：执行 `pnpm update` 升级到新版本后，再执行 `systemctl --user start dsh.service`，看似成功，但 Web 界面打开后 **21 个 UI 插件全部处于 pending 挂起状态**，控制台报错 `remoteAccess` 连接失败或服务依赖图解析卡死。
- **根因**：`systemctl start` 针对**已经在运行中的服务是静默空操作**！此时磁盘上的 `node_modules` 已经换成了新版代码，但内存中仍在运行老版本进程。DSH 的前端 dev-server 是按需从磁盘读文件的，导致**前端拿到新代码、后端跑着旧代码**，进程与文件版本错配，通信握手协议断裂。
- **铁律**：升级后**必须执行 `restart`**，切勿使用 `start`。

#### 2. 标准升级四步走

```bash
# 1. 升级 DSH 依赖
pnpm update @deepseek-ai/dsh@<版本号>

# 2. 重新打上工具 schema 必选数组补丁
bash ~/dsh/patches/apply-required-array.sh

# 3. 重新打上 Anthropic 工具调用协议补丁（含 assistantLevels 索引同步）
bash ~/dsh/patches/apply-anthropic-tool-fixes.sh

# 4. 干净重启服务（切记：restart，不是 start！）
systemctl --user restart dsh.service
```

重启后重新获取会话凭证 URL（每次重启 token 刷新）：
```bash
bash ~/dsh/tailnet-url.sh
```

### 让模型列表跟上服务商端（sync-models）

DSH 的可选模型来自 profile 里**静态声明**的 `models:` 数组 —— 各家上新/下线不会自动反映。
`tools/sync-models.mjs` 拿各家的 `/models` 端点来补齐这个缺口：

```sh
node tools/sync-models.mjs                  # 预览（默认 dry-run，不改文件）
node tools/sync-models.mjs --write           # 落盘（自动备份）
node tools/sync-models.mjs --free-only       # 只同步「有免费模型」的供应商
node tools/sync-models.mjs --exclude "tts|asr|embed"   # 排除非对话模型
node tools/sync-models.mjs --only antigravity
node tools/sync-models.mjs --prune --write   # 顺手删掉端点已无的（慎用，见下）
```

因为 profile 的 patch 层是**热重载**的，落盘后刷新页面即可，通常**不用重启 DSH**。

**三条从实测得来的设计约束**（不是凭空设的）：

1. **默认绝不删模型。** antigravity 反代上 `gemini-2.5-flash` 已不在 `/models` 里，
   但调用它**仍然成功** —— 服务端静默别名到 `gemini-3.1-flash-lite`；
   `claude-opus-4-6` → `claude-opus-4-6-thinking` 同理。
   **端点没列 ≠ 不能用**，所以要删必须显式 `--prune`。
2. **保留人工元数据。** 已存在模型的整段 YAML 原样保留（你手写的 contextWindow /
   reasoningEfforts / compat 都不会被覆盖），只追加新模型；新模型用默认值，
   你手工修正后下次同步会保留你的值。
3. **免费 ≠ 无限。** 端点只告诉你「是不是免费」（按 id 里的 `free` 判断），
   **拿不到**「每日 100 次」「capacity 用完为止」这类限制 —— 那些在服务商条款里。

⚠️ 另一个实测结论值得记下来：**「官方说会自动升级到新模型」未必属实**。
antigravity 的 `gemini-3.5-flash` 调用后直接返回文字
"Gemini 3.5 Flash is no longer…"，**并没有**自动连到 3.8。

### 按自己的意图固定模型列表（sync-model-policy）

`sync-models` 是"**只补不删**"的保守同步。如果你想**主动收敛**成一份明确的清单
（"xiaomi 只要最新旗舰"、"这几家除了 ds 只留最新免费"），用：

```sh
node tools/sync-model-policy.mjs                 # 预览 diff（默认，不写盘）
node tools/sync-model-policy.mjs --probe         # 预览 + **真调**（可用性 + 工具能力）
node tools/sync-model-policy.mjs --write         # 落盘（自动备份）
node tools/sync-model-policy.mjs --probe --write # 推荐的完整姿势：先验再落盘
node tools/sync-model-policy.mjs --only xiaomi-token-plan-cn
node tools/sync-model-policy.mjs --check-refs    # 引用体检
#   exit 0 好 · 2 悬空引用 · 3 被引用但确认不可用
```

意图写在 **`config/model-policy.yml`**（人话 + 可判定规则），改它就能改行为。

**每天自动跑一次**（09:30），用 systemd user timer（本仓库已带单元文件）：

```sh
cp ops/model-policy.service ops/model-policy.timer ~/.config/systemd/user/
mkdir -p ~/.config/systemd/user/timers.target.wants
ln -sf ../model-policy.timer ~/.config/systemd/user/timers.target.wants/model-policy.timer
systemctl --user daemon-reload
systemctl --user start model-policy.timer
```

**必须走 `tools/run-model-policy.sh`，不能直接 `node tools/sync-model-policy.mjs`。**
systemd 既不读 `~/.bashrc`（拿不到每台机器不同的 `DSH_SSR_PROXY`），也不能 `eval`
（拿不到 DSH 凭证库里的 provider key）。缺任一项任务都不会报错，但会**静默**把一批
模型探测成 401 并"保守保留"——非常隐蔽。这个壳脚本负责把两样都补齐。

用系统定时器而不是插件内置定时器，是因为**不依赖 DSH 是否开着**，也更好调试。
手动触发：

```sh
sh tools/run-model-policy.sh --probe --write
```

#### ⚠️ 三条必须先知道的事实（实测）

1. **端点给不出"谁更好"。** 实测 6 家 `/models` 只回 `id`/`name`/`created`/`context`，
   **没有任何能力字段**（没视觉标记、没思考强度、没"旗舰"标记）。
2. **`created` 是假时间戳。** agentrouter 全是 `1626777600`（2021-07-20），其余三家
   各自也全是同一个数 → **不能用来排"最新"**。所以"最新"只能按 **id 里的版本号**
   启发式判断。
3. **"最好的五个"无法自动判断。** 所以 antigravity 那份是**人工点名**的
   （写在 `pick.explicit`），脚本只负责忠实执行 + 在点名的型号消失时提醒你。

#### 🔒 硬保护：被引用的模型永不删

凡是**被别的条目引用**的模型，即使策略说不要也一律保留：

- `agent-default-model` 的 `provider`/`model` —— **本机它就指着一个免费模型**
  （`commandcode::stealth/glyph-cluster:free`）。扫描器很容易把它当"不要的"删掉，
  然后主 agent 就没有默认模型了。
- `subagent-model-selection-settings.allowedModels` 的每条路由 —— 删了那些路由会报
  `LLM provider "…" is not allowed for this Session`。

脚本每次都会打印"🔒 保留 …（被 … 引用）"。这条是拿构造场景实测过的，不是宣称。

#### ⚠️ HTTP 200 ≠ 能用

探针必须看**正文产出**，不能只看状态码。两个真实教训：
0. **两种协议格式完全不同**：`openai-completions` 的正文在 `choices[].delta.content`；
   `anthropic-messages`（现为 antigravity）是**一整个 message 对象**，
   正文在 `content: [{type:"text", text:"…"}]`。只认前者的话，后者正文数恒为 0
   → 好模型被误判成"只出推理不出正文"（踩过）。
1. commandcode 的桥接**对失败也返回 200**，错误藏在 SSE body 里（`data: {"error":…}`）。
2. 推理型模型 200 且无错误，但 `reasoning_tokens` 吃光额度、**正文 0 字符**
   → 判为 `🧠 只出推理不出正文`（`reasoning-only`），不算可用。

探针的 `max_tokens` 用 64（不能用 1）——给 1 的话**所有**推理模型都会"正文为空"，
那是探测伪影。

#### 免费额度：端点拿不到，只能人工记

`/models` **完全没有额度字段**，探针也只能测"此刻调不调得通"，测不出"每天几次"。
所以额度写在策略表的 `free_notices` 里（从供应商 UI 公告抄），作用是
① 打印在扫描结果里；② **影响排序** —— 无上限的排在前面。

commandcode 当前（2026-10-16 官方公告）：

| 模型 | 额度 | 备注 |
|---|---|---|
| `stealth/cat-jam:free` | **无上限** | 不计 credits |
| `stealth/glyph-cluster:free` | 100 次/天 | |
| `poolside/laguna-s-2.1-free` | 无上限 | 但"while capacity lasts"，实测探测到满载 → 排序靠后 |

⚠️ 公告都带 "while the stealth preview lasts" —— 是**限时**的，随时可能变。
策略里的 `free_notices` 需要你偶尔对一下 UI。

#### 模型用途标注（写进 name，因为 UI 只显示 name）

有些模型**功能独特但干不了常规对话/编程**。最典型的是推理型：`stealth/glyph-cluster:free`
实测把 `max_tokens` 全花在内部推理上（`reasoning_tokens: 45/50`），**正文 0 字符**，
在 DSH 里跑就是 `The stealth model could not complete the request. PI_AI_ERROR`。
光看名字"Glyph Cluster"完全看不出来。

模型选择器**只渲染 `model.name`**（实测 `dsh-client-ui-model-selection` 只用
`model.name` 做 label 与 title；pi-ai 的 schema 里**没有 `description`**），
所以标注只能写进 name 后缀：

```
Glyph Cluster（仅推理，不出正文）
Cat Jam（仅推理·正文极简）
Laguna S 2.1（免费但常满载）
```

规则写在策略表的 `annotations`（正则 → 标签），**幂等**：反复跑不会叠加成两个括号。

**括号剥离**：策略表的 `strip` 列出要**去掉**的括号内容。默认剥 `(Antigravity)` 与
`(free)` —— 归属在 id 里已有（`antigravity/gemini-…`），免费与否看 id 的 `free` 后缀，
name 里重复标一遍是噪音。**不认识的括号会保留**（只剥明确列出的），所以
`(Experimental)` 这类不会被误删。

#### 思考强度

端点上**完全拿不到** reasoning effort（要发真实请求才知道），所以按 **id 家族**套用，
规律是从现有手工配置里归纳的（见 `tools/lib/model-config.mjs` 的 `EFFORT_FAMILIES`）：
deepseek 血统 → `low/medium/high`（opencode 系实测支持 `max`）；antigravity 的 claude →
`low/medium/high`；**gemini 与免费模型不给**（手工条目也没给，给错档位会导致请求 400）。
**你手工写在 profile 里的值永远优先**，脚本不会覆盖已存在条目的元数据。

自检：`node tools/tests/model-policy.mjs`（23 项，含缩进往返、引用识别、efforts 家族）。

### 让 DSH 真的走路由代理

路由代理只在供应商的 `baseURL` 指向它时才起作用。在该 profile 的 `cordis.patch.yml` 里：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        baseURL: http://127.0.0.1:8318/opencode-go
      agentrouter-responses:
        baseURL: http://127.0.0.1:8318/agentrouter/v1
```

> 2026-10-27：`agentrouter`（`api: anthropic-messages`）整条路由已移除 ——
> 上游只剩 3 个 Responses-only 模型，原 Anthropic 路由唯一的 `deepseek-v4-flash`
> 已下线（503「无可用渠道」）。剩下三个模型统一挂在 `agentrouter-responses` 上。

改完必须重启 DSH。面板「设置 → 供应商路由」里可以逐个切换直连 / 经 SSR。

### CommandCode 桥接

```sh
export COMMANDCODE_API_KEY=...        # 必需
export BRIDGE_PORT=8317               # 可选
services/commandcode-bridge/start.sh
```

它按 `mode.json` 决定出口（`direct`/`ssr`），并会自动在源码布局与打包布局之间找到该文件。

## 云端部署清单

1. `dsh plugin --profile web add <pack>` + 重启
2. 设 `DSH_SSR_PROXY` 指向那台机器的翻墙代理（没有就留默认/不管，直连照样工作）
3. 按需写 `providers.json`
4. 需要 CommandCode 就设 `COMMANDCODE_API_KEY` 并起桥接
5. 重启脚本：本包在 `ops/restart-dsh.sh` 提供一份副本；本机实际在运行的是 `~/dsh/restart-dsh.sh`

**不装也行的部分是安全的**：`provider-router` 没启动时，只有那些把 baseURL 指向它的供应商会失败；
其余供应商不受影响。所以云端可以先只装不启用。

## 联网搜索后端：官方 ↔ Tavily 一键切换

### 现状（2026-10-22 实测）

DSH 的搜索是可插拔的（`ctx.web` seam）。**官方**只发布了三个 provider：

| 包 | provider id |
|---|---|
| `@deepseek-ai/dsh-web-search-deepseek` | `deepseek-official`（一次 Messages 调用 + 原生 `web_search_20250305`） |
| `@deepseek-ai/dsh-web-search-exa` | `exa` |
| `@deepseek-ai/dsh-web-search-perplexity` | `perplexity` |

**官方没有 Tavily**（`@deepseek-ai/dsh-web-search-tavily` 在 npm 上 404）。
**社区有**（第三方包，装之前请自行评估代码信任）：
`dsh-tavily-cxykyw`（纯 Tavily provider）、`dsh-web-search-multi`
（SearXNG/Brave/Tavily/Gemini/Wikipedia）、`@lemoncat7/dsh-web-search`（多 provider）。

但**它们都没有"一键切换"**：seam 只认一个 `searchProvider`，而它是插件**构造时**
读的，且两个 provider 同时可用会直接 `WEB_PROVIDER_AMBIGUOUS`。

### 本包的方案：转发式 provider（id = `switch`）

`web.searchProvider` 钉成 `switch`，由它按**运行时偏好**转发到官方或 Tavily ——
切换只是改一个 JSON，**下一次搜索立即生效**：

```sh
# ⚠️ 这些脚本在 **pack 目录**里（不在 ~/dsh 根目录 —— 那里没有 scripts）
cd ~/dsh/playground/themes/dsh-guava-pack

npm run search -- status          # 看当前实际生效的后端
npm run search -- tavily          # 切 Tavily（顺手把 pin 钉好）
npm run search -- official
npm run search -- bypass          # pin 写回 deepseek-official（绕过本插件）
```

也可以在 **设置 → 搜索后端** 点按钮，或聊天里 `/search-backend tavily`。

Tavily 的 key 走 `TAVILY_API_KEY`，三种填法（按优先级）：
DSH 凭证库 → 进程环境（`~/.bashrc`，**改完要重启**）→ **设置 → 搜索后端 里直接粘贴**
（存本机 `storages/web-search-switch.json`，0600，不进配置文件、不进日志；
优势是**立刻生效、不用重启**）。

没配 key 时切过去不会崩：搜索会回一条结构化错误，直接说明缺哪个变量。

⚠️ **client 半边刷新即生效，host 半边必须重启**。两者错位时（典型症状：面板上有
key 输入框，填完点保存毫无反应且不报错），插件会用 `state.apiVersion` 识别出来并
在面板上提示"请重启 DSH"，不再静默失败。

⚠️ CLI 会先确认"运行中的 DSH 真的挂载了插件"（比对 `storages/web-search-switch.mounted.json`
的 pid 与监听 3080 的进程）。**装好但没重启**时它拒绝直接钉 `switch`，只记偏好 ——
否则搜索会立刻 `configured provider "switch" is not registered`（踩过）。

偏好文件：`<DSH_HOME>/storages/web-search-switch.json`（0600，热读，坏了回落官方）。

### ⚠️ 两个必须知道的顺序/语义事实（都实测踩过）

1. **pin 必须在插件已挂载之后才能指向 `switch`。** 否则搜索立刻变成
   `configured web provider "switch" is not registered`。
   所以第一次要**先重启 DSH**（让插件挂上），再切换；面板按钮天然安全。
2. **profile patch 的"删除"不能可靠热回滚。** 实测删掉 `- id: web` 覆盖后 seam
   仍用旧值。回滚必须**显式写回** `searchProvider: deepseek-official`
   （`npm run search -- bypass` 就是干这个的）。

取舍（如实记录）：官方后端走 **API key**，没有复刻官方插件的
「DeepSeek 账号登录态优先」路径；需要账号态时用 `bypass` 回到官方。

## 供应商路由是自适应的

`provider-router` 面板的供应商列表**不再写死**：

```sh
# 面板行 = live 路由 ∪ 可配置路由 ∪ 内置兜底（去重、live 优先）
curl -s http://127.0.0.1:8318/_router/state | python3 -m json.tool | head -20
```

- **新供应商自动出现**（不用改插件代码），已配置但未注册的会标「未注册」；
- **每家的开关到底生不生效**由 profile 里真实的 `baseURL` 判定
  （`router` 真生效 / `bridge` 真生效 / `external`、`direct` 标灰并说明原因）；
- 指向本代理但上游表缺前缀的，直接标成"会 404，请补 `providers.json`"；
- **`auto` 模式**：每次决策前实测 direct 与 SSR，取更快那条（带 10 分钟缓存），
  面板里点「实测」可以看到两边的毫秒数 —— 依据可见，不是黑盒。

只在你显式选 `auto` 时才测；`direct`/`ssr` 的请求路径上零额外延迟。
详见 [plugins/provider-router/README.md](dsh-guava-pack/plugins/provider-router/README.md)
与 [ADAPTIVE-PLAN.md](dsh-guava-pack/ADAPTIVE-PLAN.md)。

## 一条命令体检（出问题先跑它）

```sh
node tools/preflight.mjs          # 只读，不改任何东西
node tools/preflight.mjs --json   # 给别的脚本用
```

它逐条断言这套东西的**全部前提**，失败时直接给出下一步该敲什么：

| 检查 | 为什么值得单列 |
|---|---|
| Node / `DSH_HOME` | 版本太旧或家目录指错时，一切看起来都像"模型坏了" |
| pack 位置 | 曾把默认值写成 `$HOME/dsh-guava-pack`（实际在 `$DSH_HOME/playground/themes/...`）→ 桥接与路由代理被**静默跳过**，8317/8318 双双起不来 |
| `node_modules` 补丁 | 一次 `pnpm install` 就把 Anthropic 工具补丁冲掉，之后 anthropic 协议路由（antigravity）立刻 400，报错完全看不出原因 |
| 8318 / 8317 / 3080 | 三进程互相独立，挂哪个现象都不一样 |
| `mode.json` 可写 | 不可写时面板开关"点了没反应"，没有任何提示 |
| provider key 可得性 | 只报"有没有"，绝不打印值。缺 key 时探测全是 401，免费模型会被"保守保留"成噪音 |
| 被引用模型的可用性 | 默认/子代理引用的模型若已下线或该协议不支持工具，**新会话每轮必失败** |

退出码：`0` 全通；`1` 有致命问题；`2` 只有告警。

## 改了服务代码怎么让它真的生效

两个 `start.sh` 默认是**幂等**的（活着且健康就退出）。这在启动器里正确，但会造成一个
几乎无法自察的坑：**代码改了、进程还是旧的，健康检查却全绿**。

```sh
sh plugins/provider-router/start.sh --force      # 按 pidfile / 监听端口收掉老进程再起
sh services/commandcode-bridge/start.sh --force

curl -s http://127.0.0.1:8318/health ; curl -s http://127.0.0.1:8317/health
```

## 模型能力 ↔ 协议：一个模型可能只认某条路由

DSH 是 Agent，**每一轮都会把工具清单塞进请求**。而"能聊"和"能挂工具"是两件事：

- `agentrouter-responses`（`api: openai-responses`）：线上仅剩的三个模型
  （`gpt-6.1-sol` / `gpt-5.6-sol` / `gpt-6-astra`）**全部**只能走 `/v1/responses`，
  工具调用正常（实测返回 `function_call`）。
- 历史教训：`agentrouter`（`api: anthropic-messages`）会把 `/v1/messages` 翻成
  OpenAI `/v1/chat/completions`，而这三个模型在该端点上**一律 400**
  （原文：「请改用 /v1/responses」）。该 Anthropic 路由已于 2026-10-27 废弃。
- 另一个坑：AgentRouter 的网关按 **User-Agent 白名单**拦截，`curl/*` 会被
  `401 unauthorized client detected` 拒掉；`opencode/1.18.29` 或本包路由代理用的
  `pi (win32 …)` 都能过。排障时别因为 401 就以为 key 废了。

### AgentRouter 变更（2026-10-27 实测）

上游模型池变了，**不是配置写错**。当日用本机 key（经 SSR + 合法 UA）实测：

| 观测 | 结果 |
|---|---|
| `GET /v1/models` | 只剩 `gpt-6.1-sol`、`gpt-5.6-sol`、`gpt-6-astra` |
| 三个模型 → `/v1/chat/completions` | **全部 400**：「模型 X 不支持 /v1/chat/completions 接口，请改用 /v1/responses」 |
| 三个模型 → `/v1/responses` | **全部 200**，且工具调用正常（`function_call`） |
| `deepseek-v4-flash`（原 Anthropic 路由唯一模型） | **503**「当前分组 default 下对于模型 deepseek-v4-flash 无可用渠道」 |
| UA 不带合法值（如 `curl/*`） | `401 unauthorized client detected`；`pi (win32 …)` / `opencode/1.18.29` 均 200 |

由此做的改动：**删除 `agentrouter`（anthropic-messages）整条路由**，
三个模型统一挂 `agentrouter-responses`；策略表同步（`config/model-policy.yml`）。

> ⚠️ **本机 profile 的对应改动尚未落盘**（与另一个并发会话冲突，等它收工后再做）。
> 在那之前，本机 live profile 里仍留着 `agentrouter` + `deepseek-v4-flash`
> （选中会 503），`allowedModels` 里也还留着这条死引用 —— 这是已知且临时的状态。

**加新模型时先确认它支持哪种协议**：

```sh
node tools/sync-model-policy.mjs --probe     # 会额外探测一次"带 tools 的请求"
```

探测结果是三态：`ok` / `no` / `unknown`。
- `no` → 自动在模型名后打上 **（无工具调用）**，在模型选择器里一眼可见；
- `unknown` → 不下结论（模型只是"没听话"而已，不能冤枉它）。

`--check-refs` 会把"被引用但不可用 / 不支持工具 / 是免费模型"全部列出来，
并用 `exit 3` 与"悬空引用"的 `exit 2` 区分开。

## 手机/平板经 Tailscale 打开后"一直 reconnecting、不显示对话"

几乎总是 **`--trusted-host` 缺失**，不是 Tailscale 断了。区分方法：

```sh
# 服务在跑、页面能开，但 API 被围栏拒了：
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: <你的>.<tailnet>.ts.net' \
     http://127.0.0.1:3080/api/changes.summary     # 403 = 围栏拒绝；401 = 围栏通过（只是没带 token）
# 看当前进程到底有没有这个参数：
tr '\0' '\n' < /proc/$(fuser -n tcp 3080 2>/dev/null | tr -d ' ')/cmdline | grep trusted-host
```

原因：`/api` 的浏览器信任围栏默认只信 loopback 与 IP 字面量，MagicDNS 主机名必须
用 `--trusted-host` 显式放行。启动器会自动加，但**以前是从 `/etc/resolv.conf` 的
`search` 域现推的** —— WSL 会重写这个文件，恰好在那次启动时没有 search 域，参数就
静默丢了（页面能开、每个 API 都 403 → 客户端无限重连）。

已修（2026-10-27）：

1. 启动器优先读 **`DSH_TAILNET_HOST`**（建议在 `~/.bashrc` 显式写死，模板见
   `ops/bashrc.dsh.example`），其次 resolv.conf、再次 `hostname -d`；
2. 三个来源都拿不到时**大声告警**并写 `logs/launcher.log`，不再静默；
3. 每次启动把 `trusted-host=<值> (source=env|derived)` 记进 `logs/launcher.log`，
   下次一查就知道。

> 另注：token 每次重启都会换。手机端要重新从「设置 → 连接信息」复制当次链接，
> 用旧链接同样会连不上。

## 手机 tailnet 全自动（开机自启 + 固定入口）

两个组件，装一次就够（`sh ops/install-tailnet-autostart.sh`，幂等；`--check` 只预览）：

| 组件 | 作用 |
|---|---|
| Windows 启动文件夹里的 `dsh-wsl-autostart.vbs` | 登录时**隐藏**拉起 `wsl.exe -d Ubuntu --exec sleep infinity`；WSL 起后 systemd user `linger` 自动启动 `dsh.service` 与 `dsh-entry.service` |
| `dsh-entry.service`（127.0.0.1:3099）+ `tailscale serve --set-path /go` | 固定入口：`https://<tailnet>/go` → 302 → DSH 当前 token 链接。**手机只需收藏这一个地址，DSH 重启换 token 也不用重新复制** |

为什么用启动文件夹而不是计划任务：`Register-ScheduledTask` 需要管理员权限（实测
`0x80070005` 拒绝）；启动文件夹方案普通用户即可，效果等价（登录时触发）。

验证：

```sh
systemctl --user is-active dsh-entry.service     # active
curl -s http://127.0.0.1:3099/health             # {"ok":true,...}
"/mnt/c/Program Files/Tailscale/tailscale.exe" serve status
#   |-- /    proxy http://127.0.0.1:3080
#   |-- /go  proxy http://127.0.0.1:3099
```

边界与注意：

- `/go` 只经 **tailnet** 暴露（serve 不是 funnel），能打开它的设备本来就在你 tailnet 里；
- 入口服务只监听 `127.0.0.1`，不直接开局域网端口；
- `wsl --shutdown` 会停掉 WSL 内所有服务，直到下次登录/手动拉起；
- 同机用浏览器直接访问 `https://<自己 tailnet 名>` 会 TLS 失败（Windows 对本机 tailnet IP
  的 hairpin 限制），**这是正常的**，从手机/其他设备访问不受影响。

## 手机界面适配（2026-10-28 回归 + 修复）

**现象**：手机上门户能打开、控制台无报错，但输入栏下方的数据条**挤成一行**、
文字被截断，ACP 药丸要么看不见、要么压在输入框边框上。旧版（context-guard 时期）
是**两列上下叠放**：左边「N 轮 M 步 · x tok/s」「xxxM tok · 缓存命中 x%」，
右边「63%」和上下文药丸，贴在输入栏下方。

**根因**：

1. 撑开/排布 dock 的 JS 原来在 `dsh-context-guard` 客户端里（打 `cguard_dock`
   网格类）。合并进 ACP 时一起删掉了 → 没人负责 dock 布局；
2. 宿主把统计、上下文计量、插件药丸全塞在 dock 的**一行 flex** 里 → 手机上
   必然挤成一排并截断；
3. 另一个坑：**侧栏抽屉展开时** frame 的列被压成 0（这是手机抽屉的既有行为），
   此时 dock 宽度为 0 属正常；量布局必须在**抽屉关闭态**。

**因此确立约定**：

- **dock 的两列网格由 `dsh-mobile-ui` 负责**（布局归属回到手机适配插件）：
  左列 = 统计竖排，右列上行 = 上下文计量，右列下行 = 插件药丸（内联参与网格）；
- 插件不要把手机药丸做成悬浮徽标（会压输入框边框），也**不要**自己去改 dock
  的 display/宽度；
- 手机样式以 **`:root.dsh-phone`** 为准，不要只写 `@media (max-width:520px)`
  —— 横屏宽度 844 > 520，媒体查询不命中但宿主仍标记 `dsh-phone`；
- `position:fixed` 的浮层（如 ACP 面板）**祖先不能**有
  `backdrop-filter` / `filter` / `transform` —— 会给它创建包含块
  （实测横屏面板被压成 91px 宽、top=−80）；
- 触控目标 ≥40px（视觉可小，用 `::after` 扩大可点区域）。

**本轮修复**：

| 插件 | 改动 |
|---|---|
| `dsh-mobile-ui` | 给 dock 打 `dsh-mobile-dock` 标记，并用 `:root.dsh-phone` 网格复原旧版两列：统计竖排 / 占用+药丸竖排；用 MutationObserver 兜住 dock 重建 |
| `dsh-context-acp` | 手机端药丸**内联**参与网格（完整文案 `ACP N 块 · P%`），不再悬浮；面板 `max-height:min(60dvh,520px)` 可滚动、长标签折行、步进按钮可点区域 44px |
| `dsh-session-purge` | 侧栏行 32 → 40px（触控） |
| `provider-router` | 行允许换行、按钮最小高度、备注可断词 |
| `dsh-web-search-switch` | 输入框/按钮换行（360px 不再挤出屏幕） |

**门禁**：

```sh
npm test                 # 含 tools/tests/mobile-ui-guards.mjs（静态守卫，22 条）
npm run test:mobile      # 真机视口审计（需浏览器 --remote-debugging-port=9222）
```

审计实测：`390×844`、`360×740`、`844×390`（横屏）三档 **14/14** 通过
（检查项：dock 两列网格、统计在左竖排、占用与药丸在右竖排、药丸内联且不截断、
面板在屏内可滚动、步进按钮可点区域 ≥40）。

> 未覆盖：`theme-manager` / `code-theme` / `cyberpunk` 的设置页没有逐页量；
> `dsh-mobile-ui` 里针对 `[data-composer-stats]` 的旧规则在当前宿主已失效
> （该属性不再输出），属于待清理的历史规则。

## 超时：为什么默认是 60 秒

`DSH_ROUTER_HEADER_TIMEOUT_MS` 默认 **60000**（旧默认 120000）。上游卡住时这个值
决定 UI 傻等多久；DSH 自己还会重试，所以 120s 叠加重试能挂近 **4 分钟**，除了强刷
页面没有出路。正常模型首字节 0.4–3.5s，60s 已经非常宽松；跑超大上下文首包时再调大。

## 可移植性：不要写死家目录路径

`tools/lib/yaml.mjs` 统一解析 `js-yaml`（DSH 自带依赖），按
`裸解析 → $DSH_HOME/node_modules → $HOME/dsh/node_modules → createRequire` 四级回落。
以前两个工具把 `/home/<user>/dsh/node_modules/js-yaml/...` 写死在 `import` 里 ——
换用户名、或从 systemd/cron 跑就直接 `ERR_MODULE_NOT_FOUND`，而且只在无人值守时才炸。
自检里有一条规则专门守这个（不认注释里的示例路径）。

## 验证装好了没

```sh
dsh --profile web --dump-config | grep -nE "dsh-guava-pack|mobile-ui|provider-router"
node install.mjs --check
node tools/preflight.mjs
```

浏览器里应看到设置页多出 **5 项**：「移动端显示 / 主题管理 / 供应商路由 / 连接信息 / **代码配色**」，
主题列表里多出「Cyberpunk 2077」；侧栏还会多一行「清理归档会话」（在「设置」之上）。

## DSH 版本与升级评估

**当前安装**：`0.2.1-alpha.3`（2026-10-14）。

**registry 上更新的**（2026-10-22 查询）：

| dist-tag | 版本 | 发布时间 |
|---|---|---|
| `alpha` | **0.2.1-alpha.5** | 2026-10-16 |
| `latest` / `next` | **0.2.1-rc.2** | 2026-10-17 |

所以有 2 个 alpha 之后的版本可选。**升级兼容性实测**（不是猜的）：

| 风险点 | 结论 |
|---|---|
| `dsh-tools` 的 `required` 补丁锚点 | ✅ `0.2.1-rc.2` 里锚点原样存在 |
| `pi-ai` Anthropic 两处补丁锚点 | ✅ `1.3.0` / `1.4.0` 三处锚点全部命中（latest 是 1.4.0，rc.2 只要求 `^1.1.0`） |
| base 组合的**条目 id**（profile 靠 id 打补丁） | ✅ 95 → 96，**零改名、零删除**，只新增 `web-deepseek-api` |
| 本包用到的 6 个 seam 的 `.d.ts`（slots / webServer / theme / locale / commands / connection） | ✅ 与 alpha.3 **逐字节相同** |
| 新增能力 | `web-deepseek-api`：**DeepSeek 专用的 Search / Fetch API**（不再用一次模型回合换一次搜索） |

结论：**可以升**，风险集中在"升级后必须重打两个补丁"这一步（脚本自带锚点断言，
锚点没了会直接报错而不是改坏代码）。

建议步骤（两条命令都要跑，别只用 `start`）：

```sh
cd ~/dsh
git -C playground/themes/dsh-guava-pack pull          # 先拿到最新补丁脚本
pnpm update @deepseek-ai/dsh@0.2.1-rc.2               # 或 0.2.1-alpha.5
node playground/themes/dsh-guava-pack/install.mjs --check   # 先看补丁状态
node playground/themes/dsh-guava-pack/install.mjs --patch   # 重打补丁（幂等）
node playground/themes/dsh-guava-pack/tools/preflight.mjs   # 体检
systemctl --user restart dsh.service                  # 必须 restart
```

若想留在 stable 一些的轨道：`0.2.1-rc.2` 是当前 `latest`，比 `alpha.5` 更新；
两个都跨过了 alpha.3。

**我没做的**：没有实际执行升级（会中断当前会话，且需要在真机上验证 UI）。
上面是**静态兼容性证据 + 风险清单**，不是升级承诺。

## 已知边界

- `provider-router` 对 **loopback 目标恒直连**（把本机一跳塞进 SSR 没有意义）。
- `antigravity` 走的是第三方反代（默认 `127.0.0.1:8045`），本包无法控制它的出口，
  面板里对它的开关是禁用的。
- 客户端改动刷新页面即可生效；**host 侧改动必须重启 DSH**。
