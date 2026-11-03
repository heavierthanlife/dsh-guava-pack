#!/usr/bin/env bash
# ⚠️ 仅适用于 DSH ≤ 0.2.1-alpha.x：0.2.1-rc.5 起不再安装 @deepseek-ai/dsh-client-ui-primitives，
#    代码块渲染逻辑进了预构建的 dsh-web-frontend bundle，本补丁没有目标文件。
#    已从 install.mjs 的 PATCHES 撤掉；保留仅供回滚到 alpha.x 时手工执行。
# 让聊天/思考区的代码块**渲染即高亮**，而不是等它滚进视口才高亮。
#
# ## 为什么需要它
#
# `@deepseek-ai/dsh-client-ui-primitives` 的 `useViewportHighlighting`（源码
# `lib/index.js`）用 IntersectionObserver 延迟高亮：代码块第一次进入视口才激活。
# 这带来两个用户可见的问题：
#   1. 长会话里没滚到过的代码块、以及「思考（reasoning）」展开后的代码块，
#      `pre` 一直是 `_plain_*`（没有 Shiki token span），只剩主题的单一前景色 ——
#      看起来和正文同色；而侧栏文件预览按扩展名推语言、总是高亮，于是形成
#      「只有开侧边栏看的代码有主题色」的错觉。
#   2. 激活时机依赖 IntersectionObserver 的布局/可见性判定，在折叠展开、
#      虚拟列表、流式消息等场景里并不总是可靠。
#
# 这里把该 hook 改成**挂载即返回支持结果**：所有受支持语言的代码块（Markdown
# fence、read 卡、思考区代码块）都会同步走 Shiki。代价是渲染时多做一次分词；
# 语言仍然是懒加载的，未加载的语言在 grammar 就绪后由宿主自己的 re-render 补上。
#
# 这是对 node_modules 的补丁：DSH 升级后会被覆盖，`install.mjs --patch` 可重打，
# `install.mjs --check` 会报告丢失。客户端改动只需刷新页面，不需要重启 DSH。
set -eu

DSH_HOME="${DSH_HOME:-$HOME/dsh}"
TARGET="$DSH_HOME/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js"
MARKER="guava: eager code highlight"

if [ ! -f "$TARGET" ]; then
  echo "找不到 $TARGET（DSH 安装目录不对？设 DSH_HOME 后重试）" >&2
  exit 1
fi

if grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "已打过：客户端代码块立即高亮（$TARGET）"
  exit 0
fi

python3 - "$TARGET" "$MARKER" <<'PY'
import io
import sys

path, marker = sys.argv[1], sys.argv[2]
with io.open(path, 'r', encoding='utf-8') as handle:
    source = handle.read()

anchor = 'function useViewportHighlighting(target, lang) {'
start = source.find(anchor)
if start < 0:
    sys.stderr.write('锚点缺失：找不到 useViewportHighlighting（上游结构变了，需要更新补丁）\n')
    sys.exit(1)

# 函数体到下一个顶格 "}"（bundled 源码里的类/函数都在顶格）。
end = source.find('\n}\n', start)
if end < 0:
    sys.stderr.write('锚点缺失：找不到 useViewportHighlighting 的函数结尾\n')
    sys.exit(1)

replacement = (
    'function useViewportHighlighting(target, lang) {\n'
    '\t// ' + marker + '\n'
    '\t// 原实现用 IntersectionObserver 等代码块进入视口才激活；聊天/思考区的块\n'
    '\t// 经常一直是 plain（没有 token），看起来和正文同色。这里挂载即激活。\n'
    '\t// `target` 参数保留以维持调用签名（宿主可能按位置传参）。\n'
    '\tvoid target;\n'
    '\treturn supportsHighlighting(lang);\n'
    '}'
)
patched = source[:start] + replacement + source[end + 2:]
with io.open(path, 'w', encoding='utf-8') as handle:
    handle.write(patched)
print('已打补丁：useViewportHighlighting → 立即激活（%s）' % path)
PY

# 语法自检：客户端包是 ESM，node --check 能验证。
node --check "$TARGET"
echo "✅ 客户端代码块立即高亮补丁已应用；刷新页面（无需重启 DSH）后生效"
