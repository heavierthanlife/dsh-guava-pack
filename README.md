# dsh-guava-pack — 一个包带走全部插件

把本机这套 DSH 定制（手机 UI、供应商路由、主题管理、改装赛博主题、OpenCode 会话头修复）
连同 CommandCode 桥接服务，打成一个**可离线分发**的包。换台机器（含云端）装一次就能用。

## 里面有什么

| 路径 | 内容 | 来源 |
|---|---|---|
| `plugins/dsh-mobile-ui` | 手机上像 App 一样的排版/触控/安全区 | 自研 |
| `plugins/dsh-theme-manager` | 设置里的主题管理页 | 自研 |
| `plugins/provider-router` | 供应商直连 / 经 SSR 路由 + 状态面板（**可配置**） | 自研 |
| `plugins/dsh-theme-cyberpunk2077` | 赛博朋克 2077 主题（**改装版**） | ⚠️ 原作者 Tommy00748，MIT |
| `plugins/dsh-opencode-session-header` | 修 OpenCode 的 `400 MissingSessionID` | ⚠️ 原作者 beihzb，MIT |
| `services/commandcode-bridge` | 把 OpenAI 格式转成 Command Code 内部端点 | 自研 |

第三方组件的授权与出处见 [`LICENSES/`](LICENSES/)。**两个第三方包都保持 MIT 原样分发**，
包内保留了各自的 LICENSE / 仓库地址；改装部分（赛博主题）在原作者 MIT 授权范围内。

## 安装

```sh
# 1) 装进目标 profile（包名或 .tgz 路径都行）
dsh plugin --profile web add /path/to/dsh-guava-pack-1.0.0.tgz

#    等价于：在该 profile 目录里 pnpm add，并把包名写进 dsh.profile.bundles
#    旧版 CLI 也可手工两步：
#      cd <dsh>/profiles/web && pnpm add /path/to/xxx.tgz
#      然后在 profiles/web/package.json 的 dsh.profile.bundles 里加上 "dsh-guava-pack"

# 2) 重启 DSH（host 侧插件必须重启才加载）
systemctl --user restart dsh.service      # 或你原来的启动方式

# 3) 浏览器刷新一次（客户端 bundle 会重建）
```

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
