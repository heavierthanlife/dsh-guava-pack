# dsh-code-theme

**只给代码上色**的主题插件：五套调色板（Monokai Pro / Material / One Dark / GitHub / OpenCode），自动跟随界面明暗，也可以把**代码区**单独强制成深色或浅色，并可把代码字体换成 Maple Mono CN。正文、按钮、标签一个都不碰。

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

## 两个必须同时做到的细节

### 1. 光设变量不够，必须同时设 `color`

**没有语言标签的代码块不会分词**（Shiki 不产出 token span，标题显示为"代码块"）。那种情况下整段文字的颜色只由容器的 `color` 决定 —— 只设 `--shiki-*` 变量的话，会被**主题自己的** `code { color: … }` 接管（赛博朋克主题就是明黄 `#fcee0a`）。

所以每个声明块都必须带 `color`，`tools/check-contrast.mjs` 会把这条当规则逐块检查。

### 2. 必须用 `:root` 提权

主题也写 `code { color: … }`。同特异性时胜负取决于样式表顺序，不可靠；`:root code` 稳定压过 `code`，**不用 `!important`**。

强制明暗则再叠一层：类名写两遍 + `:root` 前缀 → 特异性 `(0,3,2)`，压过深色规则 `(0,2,2)`。

```css
:root pre, :root code, …                                  { … }   /* 浅色 */
:root body[data-ds-dark-theme] pre, …                     { … }   /* 深色 */
:root body.dct-force-dark.dct-force-dark pre, …           { … }   /* 强制 */
```

## 代码字体

选中 Maple Mono CN 时，往代码容器上写：

```
--ds-font-family-code
--dsw-font-markdown-code-font-family
--dsw-font-markdown-code-block-font-family
--dsw-font-markdown-code-block-small-font-family
```

直接在元素上设变量即可压过主题在 `:root` 上的设定（就近声明优先，与特异性无关）。字体栈带完整回退，没装该字体也不会变丑；手机上没有这个字体时会落到系统等宽字体。

**侧栏的文件查看器、日志、JSON 面板走的是另一条路**：它们用的是 `--dsw-font-mono`，而宿主里**没有任何地方定义它** —— 所以它们的 `var(--dsw-font-mono, ui-monospace…)` 永远取回退值。开启字体时插件会额外写一条 `:root:root{--dsw-font-mono:…}`（双写 `:root` 提权），一次性覆盖这些等宽区域。`--dsw-font-mono` 的消费方只有 4 个包（文件查看器 / 日志 / 插件管理 / agent preset），全是等宽技术区域，所以设成全局是安全的。

### 字体变量全景（以后遇到"某处字体没变"先看这里）

全项目被 `var()` 消费、但**无人定义**的字体变量（即永远走回退值）：

| 变量 | 消费方 | 本插件 |
|---|---|---|
| `--dsw-font-mono` | 文件查看器 / 日志 / 插件管理 / agent preset | ✅ 设置 |
| `--dsh-font-mono` | cordis 面板的 row id（**不是代码**） | ❌ 有意不动 |
| `--dsw-font` | 正文（`var(--dsw-font, inherit)`，34 处走 `--dsw-font-family`） | ❌ 动了会改正文 |
| `--dsh-content-font-size` / `--dsw-font-sm-13` / `--min-font-size` | 字号，不是字体族 | ❌ 无关 |

自查命令（在 `node_modules/@deepseek-ai` 下跑）：

```sh
grep -rhoE 'var\(--[a-z0-9-]*font[a-z0-9-]*' */lib/*.js | sed 's/var(//' | sort -u > /tmp/u
grep -rhoE '\-\-[a-z0-9-]*font[a-z0-9-]* *:' */lib/*.js | sed 's/ *:$//' | sort -u > /tmp/d
comm -23 /tmp/u /tmp/d      # 用了但没人定义 = 永远走回退
```

## 加一套调色板

1. 在 `client.js` 的 `PALETTES` 里加一项（必须同时给 `light` 与 `dark`，宿主要求成对）
2. 跑 `node tools/check-contrast.mjs` —— 对比度或 CSS 结构不达标都会报错退出

> ⚠️ 加完必须确认 `PALETTE_IDS` 里出现了新键。往对象里插内容时**别把对象的 `};` 当锚点** —— 文件里有多个 `};`，锚错位置会让新条目变成别的对象的键（语法合法、`node --check` 抓不到、但完全不生效，实际踩过）。

## 验证

```sh
node tools/check-contrast.mjs
```

一次跑两件事，退出码 0 表示全通过：

- **对比度**：每套调色板 × 明暗 × 每个 token，按 WCAG AA（≥4.5:1）逐项算
- **CSS 结构**：每套调色板 × 3 种明暗策略 × 字体开关 = 30 种组合，检查花括号平衡、**每个声明块都带 `color`**、9 个 token 变量齐全、字体开关是否与输出一致、强制规则是否存在

调色板数据不复制 —— 脚本从 `client.js` 里把 `PALETTES` 和 `buildCss` 抽出来求值，保证检查的永远是真实生效的那份。

真机看：**设置 → 代码配色**，面板里的预览直接引用 `--shiki-token-*` 变量，所以显示的就是真实生效的颜色。

## OpenCode 调色板：官方原值 + 4 项 AA 调整

`PALETTES.opencode` 用的是上游内置主题的**真实色值**，不再是拼出来的近似配色。

来源 `github.com/anomalyco/opencode`（`sst/opencode` 已 301 重定向到此），分支 **`dev`**（该仓库**没有 `main`**）：

| schema | 路径 | blob SHA-1 | 字节 |
|---|---|---|---|
| v1（token 名可直接对应） | `packages/tui/src/theme/assets/opencode.json` | `e92dca8c…d290cd` | 5393 |
| v2（**当前 live 默认**，`$hue` 引用式） | `packages/tui/src/theme/assets/v2/opencode.json` | `804f4957…f38f23b` | 8902 |

两个文件解析后的语法色完全一致，互为交叉验证。原文留档在 `upstream/`（含取回与 blob 校验命令）。

**深色**：全部官方原值，逐项都 ≥4.5:1，无需调整。
**浅色**：4 个官方原值在白底上不达 AA，按**最小幅度等比压暗**（保色相）处理 —— 这是本插件"手机上看得清"这条底线唯一的让步：

| token | 官方原值 | 原对比度 | 本插件取值 | 调整后 | 系数 |
|---|---|---|---|---|---|
| `keyword` / `constant` | `#d68c27` | 2.75:1 | `#a16a1d` | 4.57:1 | ×0.755 |
| `string` | `#3d9a57` | 3.52:1 | `#35854b` | 4.56:1 | ×0.867 |
| `comment` | `#8a8a8a` | 3.45:1 | `#757575` | 4.61:1 | ×0.851 |
| `function` / `link` | `#3b7dd8` | 4.11:1 | `#3775cb` | 4.60:1 | ×0.940 |

想要 100% 原值：把 `client.js` 里这 4 处换回官方色即可（`upstream/README.md` 有对照表）——
换回后 `check-contrast.mjs` 会立刻报红，属预期行为。

另外两处**照搬上游**、看起来像 bug 但确实是有意为之的地方：

- 上游 `syntaxFunction` 与 `markdownLink` 同指 primary → 本插件 `function` 与 `link` 同色。
- 上游浅色 `syntaxKeyword` 与 `syntaxNumber` 都指向 `#d68c27` → 浅色下 `keyword` 与 `constant` 同色。

> 上游文档页 <https://opencode.ai/docs/themes/> 只写格式与加载顺序，**不含任何内置主题的色值**；
> 它唯一的色值表是 Nord 的示例，与 OpenCode 内置调色板无关，别拿它当来源。

## 已知边界

- **CSS-module 类名是哈希的**（`o3BgMG_codeBody`）：所以用 `[class*="_codeBody"]` 匹配后缀。宿主改命名后缀时这几条失效，但 `pre`/`code` 两条仍在。
- **Shiki 支持哪些语言与本插件无关** —— 这里只改颜色，不碰分词。
- **OpenCode 那套已是官方原值**（2026-10 起，见上一节），不再是近似配色。
- 少数颜色相对原版做了亮度调整（One Dark 浅色版的 string 原色只有 3.07:1；OpenCode 浅色有 4 项）。调整项由 `check-contrast.mjs` 逐条报出，并在上一节列成表。
- 偏好存在 `localStorage`（`dsh-code-theme.preference`），换设备不跟随 —— 和 `dsh-theme-manager` 的做法一致。
