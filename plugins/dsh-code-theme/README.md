# dsh-code-theme

**只给代码上色**的主题插件：Monokai Pro / Material 两套调色板，自动跟随界面明暗，也可以把**代码区**单独强制成深色或浅色。正文、按钮、标签一个都不碰。

## 为什么能"只改代码"

宿主的高亮器是 Shiki，但配的是 **css-variables 主题**（`variablePrefix: '--shiki-'`）。也就是说每个 token 的颜色不是内联色值，而是变量引用：

```html
<span style="color:var(--shiki-token-keyword)">export</span>
```

变量本身由主题样式表按明暗分别定义：

```css
:root                    { --shiki-token-keyword:#d6336c; … }   /* 浅色 */
body[data-ds-dark-theme] { --shiki-token-keyword:#faa2c1; … }   /* 深色 */
```

所以在**代码容器**上重设这些变量，就精确地只影响代码 —— 而且明暗两套天然分开，自动适配不用写一行逻辑。

## 两层落地（互为保险）

| 层 | 做什么 | 为什么 |
|---|---|---|
| 1. 原始 CSS | 在 `pre`/`code`/`[class*="_codeBody"]` 等容器上写 `--shiki-*` 与 `--dsw-alias-markdown-code-*`，含 `body[data-ds-dark-theme]` 深色分支 | 不依赖任何 API，一定生效 |
| 2. 主题服务 | `ctx.theme.overrideTokens('dsh-code-theme', {token:{light,dark}})` | 注册成正式覆盖层，宿主的检查工具也能看到；包在 try/catch 里，失败也不影响第 1 层 |

## 手动明暗怎么压过宿主

强制规则的选择器把类名**写两遍**提权：

```css
body.dct-force-dark.dct-force-dark pre, … { … }
```

这样就能压过 `body[data-ds-dark-theme]`（同特异性靠顺序决胜），**不用 `!important`**。

## 加一套调色板

1. 在 `client.js` 的 `PALETTES` 里加一项（必须同时给 `light` 与 `dark`，宿主要求成对）
2. 跑 `node tools/check-contrast.mjs` —— 低于 4.5:1 会报错退出

## 验证

```sh
node tools/check-contrast.mjs      # WCAG AA 逐项对比度（退出码 0 = 全达标）
```

真机看：**设置 → 代码配色**，面板里的预览直接引用 `--shiki-token-*` 变量，所以显示的就是真实生效的颜色。

## 已知边界

- **CSS-module 类名是哈希的**（`o3BgMG_codeBody`）：所以用 `[class*="_codeBody"]` 匹配后缀。宿主改命名后缀时这几条失效，但 `pre`/`code` 两条仍在。
- **Shiki 支持哪些语言与本插件无关** —— 这里只改颜色，不碰分词。
- 少数颜色相对原版做了亮度调整：原版 Monokai 的注释色在浅底上只有 3.7:1，手机上看不清。调整项由 `check-contrast.mjs` 逐条报出。
- 偏好存在 `localStorage`（`dsh-code-theme.preference`），换设备不跟随 —— 和 `dsh-theme-manager` 的做法一致。
