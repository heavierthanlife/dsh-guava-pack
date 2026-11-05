#!/usr/bin/env bash
# restic 便捷封装：省掉每次都要敲 -o sftp.args 和一堆环境变量。
#
#   restic-ctl.sh snapshots                 # 看快照
#   restic-ctl.sh ls latest                 # 列某快照内容
#   restic-ctl.sh stats                     # 仓库统计
#   restic-ctl.sh check                     # 完整性校验
#   restic-ctl.sh restore ...               # 恢复
#   restic-ctl.sh forget <id> [--prune]     # 删快照
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$HOME/.restic-pass}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-sftp:root@112.126.90.114:/srv/backup/dsh}"
SSH_ARGS="${RESTIC_SSH_ARGS:--F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15}"

# --prune 是给我们的语法糖：forget 完顺手 prune
PRUNE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--prune" ]; then PRUNE=1; else ARGS+=("$a"); fi
done

"$HOME/.local/bin/restic" -o sftp.args="$SSH_ARGS" "${ARGS[@]}"
rc=$?
if [ "$PRUNE" = "1" ] && [ "$rc" = "0" ] && [ "${ARGS[0]:-}" = "forget" ]; then
  echo "--- prune 清理未引用数据 ---"
  "$HOME/.local/bin/restic" -o sftp.args="$SSH_ARGS" prune
fi
exit "$rc"
