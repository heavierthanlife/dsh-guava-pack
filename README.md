# dsh-guava-pack — 一个包带走全部插件

把本机这套 DSH 定制（手机 UI、供应商路由、主题管理、改装赛博主题、OpenCode 会话头修复、
上下文守卫、已归档会话清理）连同 CommandCode 桥接服务，打成一个**可离线分发**的包。
换台机器（含云端）**git clone 一次就能用**。

## 里面有什么

| 路径 | 内容 | 来源 |
|---|---|---|
| `plugins/dsh-mobile-ui` | 手机上像 App 一样的排版/触控/安全区 | 自研 |
| `plugins/dsh-theme-manager` | 设置里的主题管理页 | 自研 |
| `plugins/provider-router` | 供应商直连 / 经 SSR 路由 + 状态面板（**可配置**） | 自研 |
| `plugins/dsh-theme-cyberpunk2077` | 赛博朋克 2077 主题（**改装版**） | ⚠️ 原作者 Tommy00748，MIT |
| `plugins/dsh-opencode-session-header` | 修 OpenCode 的 `400 MissingSessionID` | ⚠️ 原作者 beihzb，MIT |
| `plugins/dsh-context-guard` | 轮次结束后按阈值自动压缩、统计压缩次数、达上限写 handoff | 自研 |
| `plugins/dsh-session-purge` | 清理已归档会话记录（保留产出并写清单），侧栏入口在设置上方一行 | 自研 |
| `plugins/dsh-code-theme` | 只给代码上色（Monokai Pro / Material / One Dark / GitHub / **OpenCode 官方色值**，共 5 套），自动跟随明暗 + 可强制代码区明暗；附 WCAG 对比度自检 | 自研 |
| `config/cordis.patch.example.yml` | provider / 模型目录示例（6 家、24 个模型，全走本机路由） | 自研 |
| `config/model-policy.yml` | **模型选型意图表** —— 每家要哪些模型（`sync-model-policy` 读它） | 自研 |
| `ops/` | 运维脚本：`bootstrap-machine.sh`（新机装 dsh.service + linger）、`restart-dsh.sh`、`tailnet-url.sh`（打印带 token 的手机访问地址）、`dsh.service`、`bashrc.dsh.example`、`wsl.conf.example`；`NETWORK-NOTES.md` 手机连不上/流式卡/Tailscale 绕代理的排查手册 | 自研 |
| `services/commandcode-bridge` | 把 OpenAI 格式转成 Command Code 内部端点 | 自研 |

第三方组件的授权与出处见 [`LICENSES/`](LICENSES/)。**两个第三方包都在原作者 MIT 授权范围内**：
`dsh-theme-cyberpunk2077` 是**改装衍生版**（改动逐条记在 LICENSES §1）；`dsh-opencode-session-header`
是**原样分发**（未改一个字节）。两者都保留了各自的 LICENSE / 仓库地址。
`plugins/dsh-opencode-session-header` 是 vendored 的第三方副本（版本 0.1.0）：它的 `tests/smoke.mjs`
已从上游 v0.1.0 **原样收录**，所以 `npm test` 可以跑（13 passed / 0 failed）。
`package.json` 未改动。上游出新的话，`tests/` 也要一起更新。

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

### ⚠️ node_modules 补丁 —— 不打就用不了 agentrouter

有两个补丁**不在插件目录里**，而是改 DSH 安装目录下的 `node_modules`。
换机器只装包不打补丁，**agentrouter 的模型仍然会 400**：

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
- 补丁②只作用于 `api: anthropic-messages` 的 provider（即 antigravity、agentrouter）；
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
node tools/sync-model-policy.mjs --probe         # 预览 + **真调一遍**免费模型判断可用性
node tools/sync-model-policy.mjs --write         # 落盘（自动备份）
node tools/sync-model-policy.mjs --probe --write # 推荐的完整姿势：先验可用性再落盘
node tools/sync-model-policy.mjs --only xiaomi-token-plan-cn
node tools/sync-model-policy.mjs --check-refs    # 只查引用完整性，exit 2 = 有悬空
```

意图写在 **`config/model-policy.yml`**（人话 + 可判定规则），改它就能改行为。

**每天自动跑一次**（09:30），加一行 crontab 即可：

```sh
crontab -e
# 每天 09:30 按策略收敛；日志留一份好回看
30 9 * * * cd $HOME/dsh/playground/themes/dsh-guava-pack && /usr/bin/node tools/sync-model-policy.mjs --probe --write >> $HOME/dsh/logs/model-policy.log 2>&1
```

用 cron 而不是插件内置定时器，是因为**不依赖 DSH 是否开着**，也更好调试。
手动触发就再跑一次同样的命令。

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
      agentrouter:
        baseURL: http://127.0.0.1:8318/agentrouter
```

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

## 验证装好了没

```sh
dsh --profile web --dump-config | grep -nE "dsh-guava-pack|mobile-ui|provider-router"
node install.mjs --check
```

浏览器里应看到设置页多出 **5 项**：「移动端显示 / 主题管理 / 供应商路由 / 连接信息 / **代码配色**」，
主题列表里多出「Cyberpunk 2077」；侧栏还会多一行「清理归档会话」（在「设置」之上）。

## 已知边界

- `provider-router` 对 **loopback 目标恒直连**（把本机一跳塞进 SSR 没有意义）。
- `antigravity` 走的是第三方反代（默认 `127.0.0.1:8045`），本包无法控制它的出口，
  面板里对它的开关是禁用的。
- 客户端改动刷新页面即可生效；**host 侧改动必须重启 DSH**。
