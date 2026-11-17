# 页面契约（写任何页面之前必须读）

这是 `dsh-arcade` 所有子页面的**硬约定**。首页按约定链接各页面；
门禁测试 `tools/tests/arcade-pages.mjs` 会逐条检查，违反就红。

## 文件与路由

| 文件 | 路由 | 内容 |
|---|---|---|
| `public/index.html` | `/<令牌>/` | 统一首页（入口卡） |
| `public/shared.css` | 共用 | 明暗底色 / 5 套主题 / 每页强调色 / 顶栏按钮 / 面板样式 |
| `public/arcade.js` | 共用 | **主题、明暗、分数增删、存档槽、二次确认**（不要改） |
| `public/g2048.html` | `g2048` | 2048 |
| `public/snake.html` | `snake` | 贪吃蛇 |
| `public/mines.html` | `mines` | 扫雷 |
| `public/tetris.html` | `tetris` | 俄罗斯方块 |
| `public/relax.html` | `relax` | 白噪音 + 呼吸引导 + 番茄钟 |
| `public/decide.html` | `decide` | 转盘 / 骰子 / 抽签 |
| `public/pixel.html` | `pixel` | 像素画板（导出 PNG） |

**每个页面仍然是一个 HTML 文件**（页面自己的 CSS/JS 内联），不打包、无外部依赖。
允许并应当引用两个共用文件（相对路径，不带前导 `/`）：

```html
<link rel="stylesheet" href="shared.css">
<script src="arcade.js"></script>
<script>Arcade.initTheme({ page: 'g2048', accent: 'gold' });</script>
```

> **为什么允许共用 JS**（2026-11-17 修订）：
> 主题切换、分数删除、存档槽、二次确认这四件事原本要抄进 8 个页面。
> 抄 8 份的后果不是代码多，而是**行为漂移** —— 改一处忘三处，
> 用户会觉得"时好时坏"。抽成 `arcade.js` 之后，页面只负责"游戏本身"。
>
> 主题脚本必须放在 `<head>` 里**同步**执行：晚了会先闪一下默认配色。

### 每个子页面必须做的三件事

```js
// 1. 主题（<head> 里，早于首帧）
Arcade.initTheme({ page: 'g2048', accent: 'gold' });

// 2. 顶栏明暗切换按钮：<button class="icon-btn" id="mode">☀</button>
Arcade.mountModeToggle(document.getElementById('mode'), 'g2048');

// 3. 游戏页：存档槽 + 最高分删除
Arcade.mountSlots({
  gameId: 'g2048',
  unit: '分',
  capture: function () { return { score: 分数, state: 可JSON化的局面 } || null; },
  restore: function (state) { /* 从 state 还原局面，并停在暂停态 */ },
  onPause: function () { /* 真的把游戏停下 */ }
});
Arcade.mountScoreRow(document.getElementById('score-row'), 'g2048');
```

**存档语义**（用户明确要求）：
- 中途退出（切标签页 / 锁屏 / 关页面）**自动暂停 + 自动存档**；
- 每个游戏**最多 5 个**存档；
- 超出时**淘汰分数最低的那个**（不是最旧的 —— 刚开始就退出的那局最该让位）；
- 自动存档固定覆盖 `auto` 槽，反复切标签页不会把槽位堆满；
- 手动"保存当前进度"才新建槽位。

**强调色对照**（`accent` 取值）：2048 `gold`、贪吃蛇 `mint`、扫雷 `rose`、
俄罗斯方块 `violet`、放松 `sky`、选择 `sunset`、画板 `cyan`。

## 必须遵守

1. **零外部资源**：不许 CDN、Google Fonts、外链图片、`fetch` 第三方。
   断网/飞行模式下页面必须完全可用。图标用内联 SVG 或 emoji。
2. **零构建**：不要 npm、不要 JSX、不要 `import` / `export`。原生 `<script>` 即可。
3. **手机优先**：
   - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
   - 所有可点元素 ≥ 44×44 CSS px
   - 单指可玩；需要手势时同时提供替代操作（别只有 swipe）
   - 不产生横向滚动（`overflow-x` 不许超）
4. **顶栏统一**（复制这段结构）：
   ```html
   <header class="topbar">
     <a class="back" href="index.html" aria-label="返回首页">←</a>
     <h1>页面标题</h1>
   </header>
   ```
   返回用**相对路径** `index.html`（不要 `/` 或 `/<令牌>/`，令牌不该出现在子页面里）。
5. **最高分/存档一律用 `localStorage`**，键名统一前缀 `arcade.`：
   ```
   arcade.g2048.best      arcade.snake.best
   arcade.mines.best      arcade.tetris.best
   arcade.relax.settings  arcade.decide.options
   arcade.pixel.canvas
   ```
   读写必须 `try/catch`（隐私模式会抛）。
6. **`prefers-reduced-motion`**：动效可以被关掉；靠 `shared.css` 的兜底 +
   你自己别用 `requestAnimationFrame` 做纯装饰。
7. **暂停/离开要停**：`visibilitychange` 隐藏时暂停游戏循环，
   别在后台空转（这是台 2 核 1.6 GB 的机器，但更重要的是手机上会掉电）。
8. **不打印任何密钥/令牌**，页面里不许出现 `PREFIX`、cookie 名之类的字样。

## 禁止

- 不许写 `public/index.html`、`shared.css`、`arcade.js`、`server.mjs`、`install.sh`（他人作用域）。
- 不许改 `ops/console/`、`ops/vps/`、其他插件目录。
- 不许引入 `eval` / `new Function`（门禁会查）。
- 不许用 `document.write`。
- 不许在游戏页里放任何"联网""上传""分享到"功能。

## 门禁会检查什么

`node tools/tests/arcade-pages.mjs` 对每个页面断言：

1. 文件存在、是完整 HTML（有 `<!doctype html>` 与 `<html`）；
2. 含 viewport meta；
3. 含 `.topbar` + `href="index.html"` 返回链接；
4. 无 `eval(` / `new Function` / `document.write`；
5. 无外部 `http(s)://` 资源引用（`xmlns` 与注释里的说明文字除外）；
6. 无前导斜杠绝对路径（`src="/..."`、`href="/..."`）—— 会丢掉令牌前缀；
7. 页面里不出现令牌变量名（`DshArcadeToken` 等）；
8. `localStorage` 使用处必须包在 `try` 里。
