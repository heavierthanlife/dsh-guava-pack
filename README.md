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
| `config/cordis.patch.example.yml` | provider / 模型目录示例（6 家、184 个模型，全走本机路由） | 自研 |
| `ops/` | 运维脚本：`bootstrap-machine.sh`（新机装 dsh.service + linger）、`restart-dsh.sh`、`tailnet-url.sh`（打印带 token 的手机访问地址）、`dsh.service`、`bashrc.dsh.example`、`wsl.conf.example`；`NETWORK-NOTES.md` 手机连不上/流式卡/Tailscale 绕代理的排查手册 | 自研 |
| `services/commandcode-bridge` | 把 OpenAI 格式转成 Command Code 内部端点 | 自研 |

第三方组件的授权与出处见 [`LICENSES/`](LICENSES/)。**两个第三方包都保持 MIT 原样分发**，
包内保留了各自的 LICENSE / 仓库地址；改装部分（赛博主题）在原作者 MIT 授权范围内。

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
> `public, max-age=31536000, immutable`；但 `rev` 由各文件的 **mtime + size** 算出、
> **每次请求重算**（实测：改完文件不重启，页面里引用的 rev 立刻变了）。
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
整段对话）明文写入 `capture-last-request.json`。默认关闭；只在排障时临时打开，用完立刻删除文件，
**不要把抓到的内容随包分发**。

### ⚠️ node_modules 补丁 —— 不打就用不了 agentrouter

有两个补丁**不在插件目录里**，而是改 DSH 安装目录下的 `node_modules`。
换机器只装包不打补丁，**agentrouter 的模型仍然会 400**：

| 补丁 | 改的文件 | 修什么 |
|---|---|---|
| `patches/apply-required-array.sh` | `@deepseek-ai/dsh-tools/lib/index.js` | 工具 schema 恒输出 `required`（含空数组）。AgentRouter 的 deepseek-v4-flash 通道把「缺失的 required」判成 null → `400 null is not of type "array"` |
| `patches/apply-anthropic-tool-fixes.sh` | `@earendil-works/pi-ai/dist/api/anthropic-messages.js` | ① 每个 `tool_use` 补上缺失的 `tool_result`（上下文裁剪会删掉大结果）② `tool_use` 稳定重排到 assistant 消息末尾。修 `400 tool_use ids were found without tool_result blocks immediately after` |

```sh
node install.mjs --patch          # 幂等，已打过就跳过
# 或直接：bash patches/apply-required-array.sh
```

**作用域**（都已核实，不会误伤其他模型）：

- 补丁①是全局的 —— 影响 dsh 自己声明的内置工具 schema；语义等价（`required: []` ≡ 不写），
  已实测 xiaomi 两种写法都 200。MCP 工具的 schema 原样透传，不受影响。
- 补丁②只作用于 `api: anthropic-messages` 的 provider（即 antigravity、agentrouter）；
  openai 系走另一个文件，完全没动。

**这两个补丁会在 dsh 依赖升级后丢失** —— 升级完重跑 `node install.mjs --patch` 即可。
脚本自带幂等标记和锚点断言：锚点找不到会**直接报错**而不是静默改坏代码。

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

它按 `mode.json` 决定出口（`direct`/`ssr`），并会自动在源码布局与打包布局之间找到该文件；
也可用 `DSH_PROVIDER_MODES` 指定。

## 云端部署清单

1. `dsh plugin --profile web add <pack>` + 重启
2. 设 `DSH_SSR_PROXY` 指向那台机器的翻墙代理（没有就留默认/不管，直连照样工作）
3. 按需写 `providers.json`
4. 需要 CommandCode 就设 `COMMANDCODE_API_KEY` 并起桥接
5. `restart-dsh.sh` 不是本包内容（属本机运维脚本）

**不装也行的部分是安全的**：`provider-router` 没启动时，只有那些把 baseURL 指向它的供应商会失败；
其余供应商不受影响。所以云端可以先只装不启用。

## 验证装好了没

```sh
dsh --profile web --dump-config | grep -nE "dsh-guava-pack|mobile-ui|provider-router"
node install.mjs --check
```

浏览器里应看到设置页多出「移动端显示 / 主题管理 / 供应商路由 / 连接信息」，
主题列表里多出「Cyberpunk 2077」。

## 已知边界

- `provider-router` 对 **loopback 目标恒直连**（把本机一跳塞进 SSR 没有意义）。
- `antigravity` 走的是第三方反代（默认 `127.0.0.1:8045`），本包无法控制它的出口，
  面板里对它的开关是禁用的。
- 客户端改动刷新页面即可生效；**host 侧改动必须重启 DSH**。
