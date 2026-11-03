# 升级预演：0.2.1-alpha.3 → 0.2.1-rc.5

> 日期：2026-11-03 · 预演方式：把 rc.5 的相关包从 npm 拉下来，与当前 alpha.3 逐项比对，
> 并对两个 `node_modules` 补丁做了**真实干跑**（不是读代码猜）。
> 结论：**可以升**，但有 4 件事必须做，其中 2 件不做会静默失效。

## 0. 目标版本

| 通道 | 版本 | 发布时间 |
|---|---|---|
| `latest` / `next` | **0.2.1-rc.5** | 2026-10-29 |
| `alpha` | 0.2.2-alpha.2 | 2026-10-27（版本号更高，但构建更旧） |

选 `0.2.1-rc.5`。`0.2.2-alpha.2` 属于下一条 minor 的早期预览，比 rc.5 还早两天。

## 1. 预演核对表（alpha.3 → rc.5）

### 1.1 必须处理（不做会静默失效）

| # | 项 | 证据 | 处理 |
|---|---|---|---|
| A | **三个 preset 新增一行** `tool-plugin-market` | `cordis/ptc/standard.patch.yml` 各 +3 行；`minimal` 无变化 | ACP 覆盖层是**整份复制**上游 preset 的，必须 `node tools/gen-acp-preset.mjs --write` 重新生成，否则三个 preset 里的插件市场工具**静默消失** |
| B | **pi-ai 的 Anthropic 补丁锚点断了** | rc.5 的 `dsh-llm-pi-ai` 依赖 `@earendil-works/pi-ai@^1.1.0` → 全新安装会装 **1.5.0**；1.5.0 在 `continue;` 与 `messageIndex` 之间插了 `flushPendingSystemMessages();`，原三行锚点失配 | 已把锚点改成**两行容错**（`if (blocks.length === 0) / continue;`），并双向干跑验证 1.2.0 与 1.5.0 均 `Fix A/B applied` |

### 1.2 必须做（流程性）

| # | 项 | 说明 |
|---|---|---|
| C | **重打三个 node_modules 补丁** | 升级会覆盖 `dsh-tools` / `pi-ai` / `dsh-client-ui-primitives`。干跑结果：required:[] 补丁 ✅ 通过；Anthropic 补丁修锚点后 ✅；eager-highlight 锚点 `function useViewportHighlighting(target, lang) {` ✅ 仍在 |
| D | **重启 DSH + 刷新页面** | host 侧（压缩引擎、preset）与 client 侧（代码配色、面板）都要重新加载 |

### 1.3 已核对、无变化（可以放心）

| 类别 | 检查项 | 结果 |
|---|---|---|
| 代码高亮 | `data-read` / `data-diff` / `data-terminal` 语义锚点 | ✅ 全在 |
| 代码高亮 | `SHIKI_PRE_PROPS`、`createCssVariablesTheme(variablePrefix:"--shiki-")`、`highlightLines` | ✅ 全在 |
| 代码高亮 | `--shiki-token-keyword` 套餐 | ✅ 仍在 `dsh-client-ui-theme` |
| 压缩引擎 | `compactNow` / `compactIfNeeded` / `compactRegion` / `this.summarize(` / `static Config` | ✅ 数量与 alpha.3 完全一致 |
| 压缩引擎 | `summarize(input, agent, signal)` 签名 | ✅ 仍是 `protected`，未改 |
| 压缩包导出 | `toolPairingBalancedBefore/After`、`isCompactCheckpointSource` | ✅ 全在 |
| 宿主服务 | `agentPresets.serviceFor` | ✅ |
| 宿主服务 | `sessionProjections` 的 `register` / `snapshot` / `stateOf` / `viewSchema` | ✅ |
| 宿主服务 | `theme.overrideTokens` / `setTheme` | ✅ |
| 宿主服务 | `commands.register` / `definitionId` | ✅ |
| 宿主服务 | `connection.requestRejection` / `authenticatedUrl` | ✅ |
| 宿主服务 | `web.registerSearchProvider` / `searchProvider` 配置 | ✅ |
| UI 槽位 | `conversation.composer.dock` / `conversation.header.leading` / `settings.section` / `shell.overlay` / `sidebar.footer.action` / `sidebar.session.row.hover` | ✅ **6/6 全在** |

### 1.4 已知变化（不影响功能，但要知道）

- **`web.searchProviderId` 私有字段在 rc.5 运行时消失**（alpha.3 有 3 处 → rc.5 0 处）。
  `dsh-web-search-switch` 的面板「是否钉住」会走它的 fallback（直接读 profile 的
  `web.searchProvider`），**功能不受影响**；只有面板可能显示「未判定」而非明确 true/false。
- rc.5 新增 `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` 环境变量，
  但优先级是 **config > env**，profile 里已钉 `searchProvider: switch`，所以不受影响
  （顺带提醒：别把这俩 env 写进 `.bashrc`，会绕过面板）。
- web-app 新增 3 个包：`dsh-client-ui-entry-customization`、
  `dsh-client-ui-deepseek-model-label-1017`、`dsh-plugin-market`；
  根 patch 也新增了对应两行（`entry-customization`、`ui-deepseek-model-label-1017`）。
  它们随 `@deepseek-ai/dsh` 一起装，**不需要手工处理**。

## 2. 升级步骤

```sh
# 0) 备份（版本 + 锁文件）
cd /home/guava5tar_/dsh
cp package.json "package.json.bak-$(date +%Y%m%d-%H%M%S)"
cp pnpm-lock.yaml "pnpm-lock.yaml.bak-$(date +%Y%m%d-%H%M%S)"

# 1) 升级 DSH 本体（根 package.json 现在钉的是 0.2.1-alpha.3）
pnpm add @deepseek-ai/dsh@0.2.1-rc.5

# 2) 重打 node_modules 补丁（必须，否则 agentrouter 会 400）
cd playground/themes/dsh-guava-pack
node install.mjs --patch
node install.mjs --check          # 末尾应为「包完整，可以装」，且三处补丁 ✅

# 3) 重新生成 ACP preset 覆盖层（presets 多了 tool-plugin-market 行）
node tools/gen-acp-preset.mjs --write
node tools/gen-acp-preset.mjs --check     # 必须干净

# 4) profile 依赖（web 插件都是 link:，@deepseek-ai/* 由根安装带过来）
cd /home/guava5tar_/dsh/profiles/web && pnpm install

# 5) 重启 + 刷新页面
systemctl --user restart dsh.service
```

## 3. 升级后验证（按顺序）

```sh
cd /home/guava5tar_/dsh/playground/themes/dsh-guava-pack

node tools/preflight.mjs                       # 端口 / key / mode.json / 模型引用
for t in tools/tests/*.mjs; do node "$t" || echo "FAILED $t"; done
node ../dsh-code-theme/tools/check-contrast.mjs
```

再到 Web UI 里手动确认 4 件事：

1. **压缩**：新会话发一句话，能正常出字（证明 preset 挂上了、`AcpEngine` 没炸）；
   面板胶囊上的「已压块数」可点开。
2. **代码配色**：读取卡（本次修的那个）与 Markdown 围栏块**颜色一致**，都是 Monokai Pro。
3. **搜索**：设置 → 搜索后端，当前仍是 `switch`；点一次测试搜索能出结果。
4. **供应商路由**：设置 → 供应商路由，AgentRouter 那行点「实测」不再报
   `unknown provider`（这是上一轮修的 routerKey）。

## 4. 回滚

```sh
cd /home/guava5tar_/dsh
cp package.json.bak-<时间戳> package.json
cp pnpm-lock.yaml.bak-<时间戳> pnpm-lock.yaml
pnpm install
cd playground/themes/dsh-guava-pack && node install.mjs --patch   # 补丁按旧树重打
node tools/gen-acp-preset.mjs --write
systemctl --user restart dsh.service
```

> 若只想回滚 preset 覆盖层版本号而不降 DSH：`gen-acp-preset --write` 会自动适应当前上游。

## 5. 风险与未覆盖项（据实记录）

| 风险 | 说明 |
|---|---|
| pi-ai 会浮到 1.5.0 | 补丁已兼容，但 1.5.0 的其它行为（新 `flushPendingSystemMessages` 逻辑、`managedProvider` 分支）**没有实跑过**。升级后若出现「tool_use without tool_result」类 400，先怀疑这里 |
| 真机 UI 未验证 | 无浏览器控制，只能靠你刷新后肉眼确认；本次已核对的选择器/槽位是静态证据 |
| 0.2.2-alpha.2 未预演 | 若你更想跟 alpha 线，需要再做一次同样的预演（尤其 preset 与 primitives） |
| `node_modules` 补丁会被覆盖 | 任何 `pnpm install` 之后都要重跑 `install.mjs --patch`——这是常态，不是升级专属 |
