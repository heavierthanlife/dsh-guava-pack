#!/usr/bin/env bash
# restic 便捷封装：省掉每次都要敲 -o sftp.args 和一堆环境变量。
#
# 2026-11-11 起仓库由 VPS 上的 rest-server 以 **append-only** 提供：
#   · 本地能做的（只读）：snapshots / ls / stats / diff / check / restore / find
#   · 需要删除的（forget / unlock / prune）会被 append-only 拒绝，所以这里自动
#     转到 VPS 上以 restic 用户执行（它直接读仓库目录，不走 HTTP）。
#
#   restic-ctl.sh snapshots                 # 看快照
#   restic-ctl.sh ls latest                 # 列某快照内容
#   restic-ctl.sh stats                     # 仓库统计
#   restic-ctl.sh check                     # 完整性校验（只读，本地跑）
#   restic-ctl.sh restore ...               # 恢复（先到 /tmp！）
#   restic-ctl.sh forget <id> [--prune]     # 删快照（在 VPS 上执行）
#   restic-ctl.sh unlock                    # 清理陈旧锁（在 VPS 上执行）
#   restic-ctl.sh prune                     # 回收未引用数据（VPS 侧 oneshot）
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$HOME/.restic-pass}"

LEGACY_REPO="sftp:root@100.109.125.37:/srv/backup/dsh"
REPO_FILE="${RESTIC_REPO_FILE:-$HOME/.restic-repo-url}"
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  :
elif [ -s "$REPO_FILE" ]; then
  RESTIC_REPOSITORY="$(head -n 1 "$REPO_FILE")"
else
  RESTIC_REPOSITORY="$LEGACY_REPO"
fi
export RESTIC_REPOSITORY

SSH_ARGS="${RESTIC_SSH_ARGS:--F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15}"
VPS_HOST="${VPS_SSH_HOST:-root@100.109.125.37}"
REMOTE_REPO="/srv/backup/dsh"
REMOTE_PASSWORD="/etc/restic/repo-password"

# 本地调用：sftp 后端才需要 -o sftp.args
restic_local() {
  case "$RESTIC_REPOSITORY" in
    sftp:*) "$HOME/.local/bin/restic" -o "sftp.args=$SSH_ARGS" "$@" ;;
    *)      "$HOME/.local/bin/restic" "$@" ;;
  esac
}

# 远端以 restic 用户执行（直接文件系统访问，绕过 append-only）
restic_remote() {
  # shellcheck disable=SC2029,SC2086
  ssh $SSH_ARGS "$VPS_HOST" "runuser -u restic -- env RESTIC_REPOSITORY='$REMOTE_REPO' RESTIC_PASSWORD_FILE='$REMOTE_PASSWORD' RESTIC_CACHE_DIR='/var/cache/restic' /usr/local/bin/restic $*"
}


CMD="${1:-}"
case "$CMD" in
  "")
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  prune)
    echo "→ 在 VPS 上运行 restic prune（append-only 模式下只能这样做）"
    # shellcheck disable=SC2029
    ssh $SSH_ARGS "$VPS_HOST" 'systemctl start restic-prune.service && journalctl -u restic-prune -n 25 --no-pager -o cat'
    exit $?
    ;;
  unlock)
    echo "→ 在 VPS 上清理陈旧锁"
    restic_remote "unlock --remove-all"
    exit $?
    ;;
  forget)
    shift
    PRUNE=0
    ARGS=()
    for a in "$@"; do
      if [ "$a" = "--prune" ]; then PRUNE=1; else ARGS+=("$a"); fi
    done
    printf -v QUOTED '%q ' ${ARGS[@]+"${ARGS[@]}"}
    echo "→ 在 VPS 上执行 restic forget $QUOTED"
    restic_remote "forget $QUOTED"
    rc=$?
    if [ "$PRUNE" = "1" ] && [ "$rc" = "0" ]; then
      echo "--- prune 清理未引用数据（VPS 侧） ---"
      # shellcheck disable=SC2029
      ssh $SSH_ARGS "$VPS_HOST" 'systemctl start restic-prune.service && journalctl -u restic-prune -n 15 --no-pager -o cat'
    fi
    exit "$rc"
    ;;
  *)
    restic_local "$@"
    ;;
esac
