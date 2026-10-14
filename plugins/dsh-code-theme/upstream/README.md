# upstream/ — OpenCode 官方内置主题的留档

`PALETTES.opencode` 的色值来自这里，**不是近似值**。留档的目的：下次要改这套配色时，
不必再猜、也不必重新联网找，直接 diff 这两个文件即可。

## 文件

| 文件 | 上游路径 | blob SHA-1 | 字节 |
|---|---|---|---|
| `opencode-v1.json` | `packages/tui/src/theme/assets/opencode.json` | `e92dca8c2f11603fb050ac94dc59c9d7d0d290cd` | 5393 |
| `opencode-v2.json` | `packages/tui/src/theme/assets/v2/opencode.json` | `804f4957198725cf2cfca0d3924be7b93538f23b` | 8902 |

仓库：`github.com/anomalyco/opencode`（`sst/opencode` 已 301 重定向到此）。
分支：**`dev`** —— 这个仓库**没有 `main`**（`?ref=main` 返回 404）。

## 为什么两个文件都留

两套 schema，同一个调色板：

- **v1**（`defs` + `theme`，`{dark,light}` 形式）：token 名与本插件的 `--shiki-token-*` 能一一对应，是映射的依据。
- **v2**（`base` + `light` + `dark`，`$hue.*` 引用 + 100–900 色阶）：**当前 live 默认**。
  上游 `packages/tui/src/theme/index.ts` 里 `getOpenCodeTheme()` 引的是 `./assets/v2/opencode.json`。
  v2 解析后的语法色与 v1 **完全一致**（dark keyword→`$hue.accent.200`=`#9d7cd8`、function→`$hue.interactive.200`=`#fab283`…），
  两者互为交叉验证。

> 历史：`packages/opencode/src/cli/cmd/tui/context/theme/opencode.json` 曾是这个文件的路径，
> 在 `a53fae15110ee87bd19012b167ed800b27f14f9b` 上与今天的 v1 文件 **byte-identical** ——
> 只是被 `fe0c4f8c74` 移动了位置，内容没变。

## 取回 / 校验

`raw.githubusercontent.com` 在部分网络下不可达（实测 HTTP 000），所以走 Contents API：

```sh
# 取回（base64 → 原文）
curl -s https://api.github.com/repos/anomalyco/opencode/contents/packages/tui/src/theme/assets/opencode.json \
  | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(Buffer.from(j.content,"base64"))' \
  > opencode-v1.json

# 校验：git blob 的 SHA-1 必须等于上面的表（API 返回的 sha 字段也应相同）
node -e '
const fs=require("fs"),c=require("crypto");
for (const f of ["opencode-v1.json","opencode-v2.json"]) {
  const b=fs.readFileSync(f);
  console.log(f, b.length, c.createHash("sha1").update("blob "+b.length+"\0").update(b).digest("hex"));
}'
```

API 的 `size` 字段必须等于落盘字节数；两者都对上才算拿全（base64 截断会同时体现为长度不符）。

## token → 本插件变量的映射

| 本插件 `--shiki-token-*` | OpenCode v1 token | dark | light |
|---|---|---|---|
| `constant` | `syntaxNumber` | `#f5a742` | `#d68c27` → `#a16a1d` |
| `string` / `string-expression` | `syntaxString` | `#7fd88f` | `#3d9a57` → `#35854b` |
| `comment` | `syntaxComment` | `#808080` | `#8a8a8a` → `#757575` |
| `keyword` | `syntaxKeyword` | `#9d7cd8` | `#d68c27` → `#a16a1d` |
| `parameter` | `syntaxVariable` | `#e06c75` | `#d1383d` |
| `function` | `syntaxFunction` | `#fab283` | `#3b7dd8` → `#3775cb` |
| `punctuation` | `syntaxPunctuation` | `#eeeeee` | `#1a1a1a` |
| `link` | `markdownLink` | `#fab283` | `#3b7dd8` → `#3775cb` |

`→` 后面的是本插件的实际取值（WCAG AA 压暗，见 `../README.md`）。

非 token 变量：`block`←`background`、`banner`←`backgroundPanel`、`inline`←`backgroundElement`、
`selected`←`darkStep4`/`lightStep4`、`unselected`←`background`、`diffAdded`←`diffAddedBg`、`diffDeleted`←`diffRemovedBg`。

## 注意

- 上游 `syntaxFunction` 与 `markdownLink` **同指 primary**，所以 `function` 与 `link` 同色是照搬上游，不是笔误。
- 浅色模式下上游 `syntaxKeyword` 与 `syntaxNumber` 也同色（都指向 `lightAccent`/`lightOrange` = `#d68c27`），
  所以 `keyword` 与 `constant` 在浅色下同色 —— 同样照搬上游。
- 上游浅色有 4 个原值在白底上低于 4.5:1（最低 `#d68c27` 只有 2.75:1），本插件按最小幅度压暗处理。
- 上游文档页 <https://opencode.ai/docs/themes/> 只写格式与加载顺序，**不含任何内置主题的色值**；
  它唯一的色值表是 Nord 的示例，与 OpenCode 内置调色板无关，别拿它当来源。
