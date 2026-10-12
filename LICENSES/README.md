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

### 改装内容（与上游 main 的实际 diff，非推测）

对比基准：`git clone --depth 1 https://github.com/Tommy00748/dsh-theme-cyberpunk2077.git`
（HEAD `a3681ee`，version 0.1.4）。

**只有一个文件不同：`lib/client.js`**（253 行 diff）。
`lib/index.js`、`package.json`、`cordis.patch.yml`、`README.md` 与上游**逐字节相同**。

改动分三类：

1. **主题开关偏好持久化** —— 新增 `PREF_STORE_KEY` / `readStoredPref` / `writeStoredPref`
   与 `wantUs` / `isActive`，让主题的启用状态可以被记住并按偏好决定是否生效。
2. **生命周期重构** —— 用 `startVisuals` / `stopVisuals` / `removeCyberpunkStyles`
   取代上游的 7 个独立 `stopXxx`（`stopClock` / `stopNotices` / `stopPending` / `stopRelic`
   / `stopTitle` / `stopWake` 及 `observer`），收敛成一对启动/停止入口。
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
| 改动 | **无** —— 原样收录 |
| 许可文件 | [`../plugins/dsh-opencode-session-header/LICENSE`](../plugins/dsh-opencode-session-header/LICENSE)（上游自带） |

## 3. 本包原创部分

`dsh-mobile-ui`、`dsh-theme-manager`、`provider-router`、`commandcode-bridge`、
以及本包的 patch/安装脚本 —— 均由本包所有者编写，按 MIT 提供（见包根 `package.json`）。

## 重新分发时请注意

- **保留** `plugins/dsh-theme-cyberpunk2077/LICENSE` 与
  `plugins/dsh-opencode-session-header/LICENSE`，不要删。
- 若你进一步修改赛博主题，建议在 `LICENSE` 的改动说明里补一句你改了什么，
  方便自己日后分辨与上游的差异。
- 包内**不应包含**任何抓包产物（`capture-last-request.json`）—— 那里面可能有你的提示词。
