#!/usr/bin/env bash
#
# 清掉"记录已删、花名册还留着 id"的残留条目。
#
# 为什么必须停服：workspace.json 在运行时由 DSH 内存持有，改文件会被覆盖；
# 停服 → 进程把自己的状态刷盘 → 再改文件 → 启动，顺序才对。
#
# ⚠️ 请在【你自己的终端】里运行。不要从 DSH 会话内部调用：它会停掉 dsh.service，
#    从而杀掉正在执行这条命令的那个会话。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$HERE/lib/core.mjs"

# 无论中间哪一步失败，都要把服务拉回来 —— 否则一次失败就留下一个停着的 dsh。
trap 'systemctl --user start dsh.service >/dev/null 2>&1 || true' EXIT

echo "==> 停止 dsh.service"
systemctl --user stop dsh.service

# --roster-only 是必须的：不加它的话，没有 --id 就等于"清理全部归档会话"，
# 那会把所有归档会话一起移走，而本脚本的定位只是摘掉花名册里的残留 id。
echo "==> 清理花名册残留（--roster-only：只改 workspace.json，不删任何会话数据）"
node "$CLI" --confirm --roster-only

echo "==> 启动 dsh.service"
systemctl --user start dsh.service

echo "完成。刷新页面后，那些'点不进去'的条目应该消失。"
