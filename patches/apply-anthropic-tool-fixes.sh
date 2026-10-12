#!/usr/bin/env bash
# pi-ai 的 Anthropic 转换层两处「协议兜底」：
#   A. tool_use 必须是 assistant 消息的最后一个块（AgentRouter 后端强制；
#      dsh 会存下 tool 调用之后泄漏的文本碎片）。
#   B. 每个 tool_use 必须有紧随其后的 tool_result（dsh 的上下文裁剪会删掉大结果）。
# 症状：400 `tool_use ids were found without tool_result blocks immediately after`。
# 重装/升级 pi-ai 后重跑：bash ~/dsh/patches/apply-anthropic-tool-fixes.sh
set -euo pipefail
F="${DSH_HOME:-$HOME/dsh}/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"
[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
if grep -q "enforceToolResultAdjacency" "$F" && grep -q "tool_use always trails" "$F"; then
  echo "已全部打过补丁，跳过"; exit 0
fi
cp -a "$F" "$F.bak-toolfix-$(date +%Y%m%d-%H%M%S)"
python3 - "$F" <<'PY'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()

# ---------- Fix A ----------
if "enforceToolResultAdjacency" not in s:
    helper = '''/**
 * Anthropic requires every `tool_use` block to be answered by a `tool_result`
 * with the same id in the message immediately after. DSH's context pruning can
 * drop a large `tool_result` while keeping the assistant `tool_use` that asked
 * for it, which makes the provider reject the whole request with
 * `tool_use ids were found without tool_result blocks immediately after`.
 * Backfill a placeholder result so the transcript stays protocol-valid.
 */
function enforceToolResultAdjacency(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        out.push(msg);
        if (msg.role !== "assistant" || !Array.isArray(msg.content))
            continue;
        const ids = msg.content.filter((block) => block.type === "tool_use").map((block) => block.id);
        if (ids.length === 0)
            continue;
        const next = messages[i + 1];
        const answered = new Set();
        if (next !== undefined && next.role === "user" && Array.isArray(next.content)) {
            for (const block of next.content) {
                if (block.type === "tool_result")
                    answered.add(block.tool_use_id);
            }
        }
        const missing = ids.filter((id) => !answered.has(id));
        if (missing.length === 0)
            continue;
        const fillers = missing.map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: "[tool result omitted by context pruning]",
        }));
        if (next !== undefined && next.role === "user" && Array.isArray(next.content)) {
            next.content = [...fillers, ...next.content];
        }
        else {
            out.push({ role: "user", content: fillers });
        }
    }
    return out;
}
function convertMessages('''
    a = "function convertMessages("
    assert s.count(a) == 1, "convertMessages 锚点不唯一"
    s = s.replace(a, helper, 1)
    b = "    // Add cache_control to the last user message to cache conversation history"
    assert b in s, "cache_control 锚点未找到"
    inplace = ("    {\n"
               "        const enforced = enforceToolResultAdjacency(params);\n"
               "        params.length = 0;\n"
               "        for (const message of enforced)\n"
               "            params.push(message);\n"
               "    }\n")
    s = s.replace(b, inplace + b, 1)
    print("Fix A applied")

# ---------- Fix B ----------
if "tool_use always trails" not in s:
    anchor = """            if (blocks.length === 0)
                continue;
            const messageIndex = params.length;"""
    new = """            // Anthropic requires every `tool_use` block to be the LAST block of its
            // assistant message. DSH can store content that a stream emitted *after*
            // the tool call (typically a leaked tool-syntax fragment), and the provider
            // then rejects the whole request with a misleading
            // "`tool_use` ids were found without `tool_result` blocks immediately after".
            // Stable-partition the blocks so tool_use always trails.
            if (blocks.some((block) => block.type === "tool_use")) {
                const ordered = [...blocks.filter((block) => block.type !== "tool_use"), ...blocks.filter((block) => block.type === "tool_use")];
                blocks.length = 0;
                for (const block of ordered)
                    blocks.push(block);
            }
            if (blocks.length === 0)
                continue;
            const messageIndex = params.length;"""
    assert anchor in s, "blocks 锚点未找到"
    s = s.replace(anchor, new, 1)
    print("Fix B applied")

io.open(p, 'w', encoding='utf-8').write(s)
PY
node --check "$F" && echo "补丁完成且语法 OK"
