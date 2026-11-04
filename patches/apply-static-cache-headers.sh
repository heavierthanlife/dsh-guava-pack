#!/usr/bin/env bash
# 给 SPA 静态资源补上 HTTP 缓存头。
#
# ## 为什么需要它
#
# `@deepseek-ai/dsh-host-frontend-static` 的 `serveStatic()` 只发 `content-type`，
# **没有任何 `cache-control` / `etag` / `last-modified`**。于是浏览器每次打开或刷新页面
# 都可能重新拉 `dist/assets/index-<hash>.js`（本机实测 gzip 后 320KB）。
#
# 在手机经 Tailscale 中继访问时，RTT 常在 250–350ms，这次重传就是**一两秒**的纯等待，
# 而且把高抖动的链路多暴露一次。文件名本身带内容哈希，天然适合 immutable 缓存。
#
# ## 改法
#
# 只改 `res.writeHead(200, { "content-type": type })` 这一处：
#   · `/assets/<name>-<hash>.<ext>` → `public, max-age=31536000, immutable`
#   · 其余（尤其 index.html）        → `no-cache`（换版后立即生效，不会被旧 HTML 卡住）
#
# 幂等：带 marker 就跳过。DSH 升级会覆盖 node_modules，`install.mjs --patch` 重打即可，
# `install.mjs --check` 会报告丢失。
set -eu

DSH_HOME="${DSH_HOME:-$HOME/dsh}"
TARGET="$DSH_HOME/node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js"
MARKER="guava: static cache headers"

if [ ! -f "$TARGET" ]; then
  echo "找不到 $TARGET（DSH_HOME 不对？）" >&2
  exit 1
fi

if grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "已打过：静态资源缓存头（$TARGET）"
  exit 0
fi

python3 - "$TARGET" "$MARKER" <<'PY'
import io
import sys

path, marker = sys.argv[1], sys.argv[2]
with io.open(path, 'r', encoding='utf-8') as handle:
    source = handle.read()

old = '\tres.writeHead(200, { "content-type": type });\n'
new = (
    '\t// ' + marker + '\n'
    '\t// 文件名带内容哈希 → 可以 immutable 长缓存；其余（尤其 index.html）必须每次校验，\n'
    '\t// 否则换版后浏览器会拿着旧 HTML 去引用已删除的旧 bundle。\n'
    '\tconst hashedAsset = /^\\/assets\\/.*-[A-Za-z0-9_-]{8,}\\.[a-z0-9]+$/.test(pathname);\n'
    '\tres.writeHead(200, {\n'
    '\t\t"content-type": type,\n'
    '\t\t"cache-control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache"\n'
    '\t});\n'
)
if old not in source:
    sys.stderr.write('锚点缺失：找不到 res.writeHead(200, { "content-type": type })（上游结构变了，需要更新补丁）\n')
    sys.exit(1)

source = source.replace(old, new, 1)
with io.open(path, 'w', encoding='utf-8') as handle:
    handle.write(source)
print('已打补丁：静态资源缓存头（%s）' % path)
PY

node --check "$TARGET"
echo "✅ 静态资源缓存头已应用；**需要重启 DSH**（host 侧模块已按旧代码进入 ESM 缓存），重启后刷新页面生效"
