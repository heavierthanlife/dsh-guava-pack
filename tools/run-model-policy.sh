#!/bin/sh
# model-policy 定时任务的入口：
# systemd 不能 eval，所以在这里先把凭证库里的 provider key 导出成环境变量，
# 再交给同步工具（它会优先读 process.env，其次 ~/.bashrc）。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/export-provider-keys.mjs" ] && [ -x /usr/bin/node ]; then
  eval "$(/usr/bin/node "$HERE/export-provider-keys.mjs" 2>/dev/null)"
fi
exec /usr/bin/node "$HERE/sync-model-policy.mjs" "$@"
