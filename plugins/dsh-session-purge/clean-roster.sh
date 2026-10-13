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

echo "==> 停止 dsh.service"
systemctl --user stop dsh.service

echo "==> 清理花名册残留（只改 workspace.json，不删任何会话数据）"
node "$CLI" --confirm --clean-roster

echo "==> 启动 dsh.service"
systemctl --user start dsh.service

echo "完成。刷新页面后，那些'点不进去'的条目应该消失。"
