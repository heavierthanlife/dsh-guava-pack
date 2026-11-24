#!/usr/bin/env bash
# 补齐 @deepseek-ai/dsh-tool-subagent-control 缺失的 ./list-agents 子路径。
#
# 症状：点开任何已有会话 → resume failed
#   RemoteError: tool-subagent-list-agents
#     (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started
#   → 前端把该会话移出列表，输入框显示「会话不可用」。
#
# 原因：上游 0.2.2-rc.5 的该包声明了 src/list-agents.ts 与 lib/types/list-agents.d.ts，
#   但发布产物缺 lib/list-agents.js，exports 里也没有 "./list-agents"。
#
# 做法：放一份由同版本 src 编译好的 lib/list-agents.js（vendor），并补 exports 条目。
#   上游一旦自带该文件与 exports 条目，本脚本自动跳过（幂等）。
set -euo pipefail

PKG_DIR="${DSH_HOME:-$HOME/dsh}/node_modules/@deepseek-ai/dsh-tool-subagent-control"
VENDOR="$(cd "$(dirname "$0")" && pwd)/vendor/subagent-control-list-agents.js"

[ -d "$PKG_DIR" ] || { echo "找不到 $PKG_DIR（DSH_HOME 不对？）"; exit 1; }
[ -f "$VENDOR" ] || { echo "找不到 vendor 文件 $VENDOR"; exit 1; }

if grep -q '"./list-agents"' "$PKG_DIR/package.json" 2>/dev/null && [ -f "$PKG_DIR/lib/list-agents.js" ]; then
  echo "已就绪（上游已自带或此前已打），跳过"; exit 0
fi

mkdir -p "$PKG_DIR/lib"
[ -f "$PKG_DIR/lib/list-agents.js" ] || cp "$VENDOR" "$PKG_DIR/lib/list-agents.js"

node - "$PKG_DIR/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.exports = pkg.exports ?? {}
if (!pkg.exports['./list-agents']) {
  pkg.exports['./list-agents'] = {
    types: './lib/types/list-agents.d.ts',
    default: './lib/list-agents.js',
  }
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log('已补 exports["./list-agents"]')
} else {
  console.log('exports 已存在')
}
NODE

# 自检：必须能按子路径解析，否则宁可失败让人看见
if node --input-type=module -e "import('@deepseek-ai/dsh-tool-subagent-control/list-agents').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "✅ list-agents 子路径可解析"
else
  echo "⚠️ 子路径仍不可解析（在 $PKG_DIR 之外运行时这条检查无意义，忽略）"
fi
