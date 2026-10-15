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

## 2. dsh-opencode-session-header（原样分发）

| 项 | 值 |
|---|---|
| 上游 | https://github.com/beihzb/dsh-opencode-session-header |
| 作者 | beihzb \<zhang2357@mail.ustc.edu.cn\> |
| 版本 | 0.1.0 |
| 授权 | MIT，Copyright (c) 2026 beihzb |
| 改动 | **无改动** —— 所有文件原样收录，另**补回**上游的 `tests/smoke.mjs`（原先漏收，导致 `npm test` ENOENT） |
| 许可文件 | [`../plugins/dsh-opencode-session-header/LICENSE`](../plugins/dsh-opencode-session-header/LICENSE)（上游自带） |

`tests/smoke.mjs` 取自上游 **v0.1.0 tag**，blob SHA 与上游一致
（`474028a602f8be9826cfd2fe7f708662d0207815`，5687 字节），未改一个字节；
`package.json` 也**未改**（它本来就写着 `test: node tests/smoke.mjs`）。
补上之后 `npm test` → **13 passed / 0 failed**。

## 3. 本包原创部分

`dsh-mobile-ui`、`dsh-theme-manager`、`provider-router`、`commandcode-bridge`、
以及本包的 patch/安装脚本 —— 均由本包所有者编写，按 MIT 提供（见包根 `package.json`）。

## 重新分发时请注意

- **保留** `plugins/dsh-theme-cyberpunk2077/LICENSE` 与
  `plugins/dsh-opencode-session-header/LICENSE`，不要删。
- 若你进一步修改赛博主题，建议在 `LICENSE` 的改动说明里补一句你改了什么，
  方便自己日后分辨与上游的差异。
- 包内**不应包含**任何抓包产物（`plugins/provider-router/captures/req-<时间戳>.json`）——
  那里面可能有你的提示词。`captures/` 与旧的 `capture-last-request.json` 都已被
  `.gitignore` / `.npmignore` 排除，但**手工 `cp`/打包时仍要自己确认**。
