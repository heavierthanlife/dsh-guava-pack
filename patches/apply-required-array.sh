#!/usr/bin/env bash
# 让 dsh 的工具 JSON Schema 始终输出 `required`（即使为空数组）。
# 原因：AgentRouter 的 deepseek-v4-flash 通道会把「缺失的 required」判为 null 并 400：
#   Invalid schema for function '...': null is not of type "array"
# 重装/升级 dsh 依赖后重跑本脚本即可。用法: bash ~/dsh/patches/apply-required-array.sh
set -euo pipefail
F="${DSH_HOME:-$HOME/dsh}/node_modules/@deepseek-ai/dsh-tools/lib/index.js"
[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
if grep -q "Always emit \`required\`" "$F"; then echo "已打过补丁，跳过"; exit 0; fi
python3 - "$F" <<'PY'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = ("\t\t\tif (task.required.length > 0) {\n"
       "\t\t\t\ttask.compiled.required = task.required;\n"
       "\t\t\t\tif (task.destination.kind === \"object\") task.destination.target.required = task.required;\n"
       "\t\t\t}")
new = ("\t\t\t// Always emit `required` (even when empty). Some OpenAI-compatible\n"
       "\t\t\t// providers (e.g. AgentRouter's deepseek-v4-flash channel) reject a\n"
       "\t\t\t// `type: object` schema whose `required` is absent with\n"
       "\t\t\t// `null is not of type \"array\"`.\n"
       "\t\t\ttask.compiled.required = task.required;\n"
       "\t\t\tif (task.destination.kind === \"object\") task.destination.target.required = task.required;")
assert old in s, "补丁锚点未找到（dsh-tools 可能已升级，需人工核对）"
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print("patched")
PY
