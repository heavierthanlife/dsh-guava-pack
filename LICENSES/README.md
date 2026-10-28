# 第三方组件归属

本包收录了自研插件与我（包使用者）**改装过的**第三方组件。两个第三方组件都是 MIT，
按 MIT 要求保留署名与许可声明。

## 1. dsh-theme-cyberpunk2077（改装版）

| 项 | 值 |
|---|---|
| 上游 | https://github.com/Tommy00748/dsh-theme-cyberpunk2077 |
| 版本 | 0.1.4（与上游 main 同版本号） |
| 授权 | MIT（上游 package.json 声明） |
| 许可文件 | [`../plugins/dsh-theme-cyberpunk2077/LICENSE`](../plugins/dsh-theme-cyberpunk2077/LICENSE) |

### 改装内容（与上游的实际 diff，非推测）

对比方式：`api.github.com` Contents API 取上游文件（本机 `raw.githubusercontent.com`
与 `cdn.jsdelivr.net` 均不可达），逐字节比对并在本地 `diff`。

**两个文件与上游不同**：

| 文件 | 差异 |
|---|---|
| `lib/client.js` | **305 行 diff**（上游 blob `62b4a5c3…`，1218 行；本包 1428 行） |
| `README.md` | **10 行 diff** —— 只修了两处**过度声明**（见下） |

`lib/index.js`、`package.json`、`cordis.patch.yml` 与上游**逐字节相同**
（实测 blob：`e82ed74647…`、`b5d1759f03…`、`2ecc8ec8432…`）。

**README 的两处更正**（上游描述与代码不符，我们按代码改了）：

1. 上游写"每个特效独立开关"，实际 `DECK` 面板只有 **5 个**开关
   （`scan` / `relic` / `boot` / `type` / `sfx`）。
2. 上游写"小屏自动关闭扫描线、数据流和重动画"，实际 `≤768px` 的媒体查询只隐藏
   `#root::after`、`#cp2077-hud`、`#cp2077-chip` 并停掉主按钮与会话行 hover 的动画。

**`lib/client.js` 的改动分三类**：

1. **主题开关偏好持久化** —— 新增 `PREF_STORE_KEY` / `readStoredPref` / `writeStoredPref`
   与 `wantUs` / `isActive`，让主题的启用状态可以被记住并按偏好决定是否生效。
   后续加固：`storageUsable()` 探测 localStorage 是否真能用 —— **被禁时不再冒充默认主题**
   （否则 Safari 隐私模式 / 内嵌 webview 下再也切不出去），只在主题服务偏好确实是我们时才接管。
2. **生命周期重构** —— 用 `startVisuals` / `stopVisuals` / `removeCyberpunkStyles`
   取代上游的 7 个独立 `stopXxx`（`stopClock` / `stopNotices` / `stopPending` / `stopRelic`
   / `stopTitle` / `stopWake` 及 `observer`），收敛成一对启动/停止入口。
   后续加固：`startVisualsSafely` 加回滚（中途抛错不再丢清理器）、
   捕获 `ctx.theme.register()` 的 disposer（否则 HMR 后注册表留旧模块的 TOKENS）、
   两处快捷键判断补 `|| e.shiftKey`（Shift+Enter 在 DSH 里是换行，不是发送）。
3. **宿主痕迹还原** —— 通过 `hostTitle` / `writeTitle` / `lastWrittenTitle` 保存并还原
   `document.title`，通过 `prevIcon` / `createdIcon` 保存并还原站点图标；
   主题卸下时不再留下自己的标题与 favicon。

⚠️ 上游**未在仓库内提供 LICENSE 文件**（只在 package.json 里声明 MIT）。本包内的 LICENSE 是
按该声明与仓库地址补写的，并已在文件头部注明这一点 —— 若上游日后发布自己的 LICENSE，
以上游为准。

## 2. dsh-opencode-session-header（改装版，2026-10-28）

| 项 | 值 |
|---|---|
| 上游 | https://github.com/beihzb/dsh-opencode-session-header |
| 作者 | beihzb \<zhang2357@mail.ustc.edu.cn\> |
| 上游版本 | 0.1.0（本副本版本号 `0.1.0-dsh.1`，表示带本地补丁） |
| 授权 | MIT，Copyright (c) 2026 beihzb |
| 改动 | **有改动**：新增「loopback + 路径首段」匹配规则（见下）；另补回上游的 `tests/smoke.mjs` 并扩展它 |
| 许可文件 | [`../plugins/dsh-opencode-session-header/LICENSE`](../plugins/dsh-opencode-session-header/LICENSE)（上游自带，未改） |

### 改装内容（与上游 v0.1.0 的实际 diff）

**`lib/index.js`**：

- 上游只按 **hostname** 白名单（`opencode.ai` + 子域）决定是否打 `x-opencode-session`。
  但这套 profile 把 `opencode-go` 的 baseURL 指到本机路由代理
  `http://127.0.0.1:8318/opencode-go`，出站请求的 hostname 恒为 `127.0.0.1` ——
  上游规则**永远不命中**，插件对主用路由空转，只能靠 profile 里一条硬编码的静态
  UUID 顶着（所有会话共用，丢掉上游按会话的路由亲和与前缀缓存）。
- 新增补充规则：hostname 是回环地址（`127.0.0.1` / `localhost` / `::1`，含 `[::1]`）时，
  再按**路径首段**匹配；默认只认 `opencode-go`（与 baseURL 前缀同名），
  可用挂载配置 `loopbackPrefixes` 覆盖，传 `[]` 关闭这条规则。
- 首段判定是**整段相等**，不是字符串前缀：`/opencode-goo/...` 不会命中。
- 非回环主机即使路径相同也不命中 —— 白名单没有被放宽。
- 新增导出：`isLoopbackHostname`、`firstPathSegment`、`matchesSessionHeaderTarget`；
  `createSessionHeaderMiddleware` 新增 `loopbackPrefixes` 选项；`apply` 透传并在
  info 日志里打印生效前缀。

**`tests/smoke.mjs`**：上游 v0.1.0 的 13 条断言保留不动，新增第 8 组 9 条
（8a–8i）覆盖上述规则，现为 **22 passed / 0 failed**。

上游那份 `tests/smoke.mjs` 本身的 blob SHA 与上游一致
（`474028a602f8be9826cfd2fe7f708662d0207815`，5687 字节）—— 改动是**追加**上去的，
原有 13 条断言一个字节没动。`package.json` 仅把 `version` 改成 `0.1.0-dsh.1`，
`test` 脚本、`files`、依赖声明均未改。

## 3. 本包原创部分

`dsh-mobile-ui`、`dsh-theme-manager`、`provider-router`、`commandcode-bridge`、
以及本包的 patch/安装脚本 —— 均由本包所有者编写，按 MIT 提供（见包根 `package.json`）。

## 重新分发时请注意

- **保留** `plugins/dsh-theme-cyberpunk2077/LICENSE` 与
  `plugins/dsh-opencode-session-header/LICENSE`，不要删。
- 若你进一步修改赛博主题，建议在 `LICENSE` 的改动说明里补一句你改了什么，
  方便自己日后分辨与上游的差异。
- `plugins/dsh-opencode-session-header` 已是**改装版**（§2）：重新分发时要么保留
  §2 的改动说明，要么把它换回上游原版（那样 `opencode-go` 走本机代理时又会被
  profile 里那条静态 UUID 顶掉按会话隔离）。上游发布新版本时，先比对 `lib/index.js`
  与 `tests/smoke.mjs`，把本地补丁重新贴上去再升级。
- 包内**不应包含**任何抓包产物（`plugins/provider-router/captures/req-<时间戳>.json`）——
  那里面可能有你的提示词。`captures/` 与旧的 `capture-last-request.json` 都已被
  `.gitignore` / `.npmignore` 排除，但**手工 `cp`/打包时仍要自己确认**。
