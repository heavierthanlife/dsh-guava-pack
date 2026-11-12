#!/usr/bin/env bash
# 把 ~/dsh（会话历史、workspace、插件源码）增量备份到 VPS 的 restic 仓库。
# 带宽受限：默认 200KB/s（约 1.6Mbps），给 DSH 隧道留出余量。
#
# 2026-11-11 起仓库走 rest-server（append-only，HTTP + basic auth），地址存在
# ~/.restic-repo-url（600，含口令，别提交进 git）。老地址（sftp:root@…）仍可用：
# 显式设 RESTIC_REPOSITORY=... 即可回退。
#
# 用法：restic-backup.sh [--dry-run]
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$HOME/.restic-pass}"

LEGACY_REPO="sftp:root@100.109.125.37:/srv/backup/dsh"
REPO_FILE="${RESTIC_REPO_FILE:-$HOME/.restic-repo-url}"
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  : # 调用方显式指定，优先
elif [ -s "$REPO_FILE" ]; then
  RESTIC_REPOSITORY="$(head -n 1 "$REPO_FILE")"
else
  RESTIC_REPOSITORY="$LEGACY_REPO"
fi
export RESTIC_REPOSITORY

SSH_ARGS="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15"
LIMIT="${RESTIC_LIMIT_KB:-200}"

# 机器标识 tag（2026-11-12）：
# 两台 PC（YGY12 主力 / MSI）备份到**同一个仓库、同一路径、同一用户名**，只靠
# `--host` 区分。`restic ls latest` / `restore latest` 会随机命中另一台 —— 实测踩过。
# 这里额外打一个 `host-<短主机名>` tag，恢复时可以 `--tag host-MSI` 精确锁定。
# 兼容：老快照没有这个 tag，但一律带 `dsh-nightly`，历史不受影响。
HOST_TAG="host-$(hostname -s 2>/dev/null || hostname | cut -d. -f1)"
HOST_TAG="$(printf '%s' "$HOST_TAG" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-' )"
HOST_TAG="${HOST_TAG%-}"

# 只有 sftp 后端才需要这几个 ssh 参数；rest: 走 HTTP，传了也没用。
OPTS=()
case "$RESTIC_REPOSITORY" in
  sftp:*) OPTS+=(-o "sftp.args=$SSH_ARGS") ;;
esac

"$HOME/.local/bin/restic" ${OPTS[@]+"${OPTS[@]}"} backup "$HOME/dsh" \
  --compression max \
  --limit-upload "$LIMIT" \
  --exclude 'node_modules' \
  --exclude 'cache' \
  --exclude '*.log' \
  --exclude '.git' \
  --exclude '.shots' \
  --exclude '__pycache__' \
  --exclude '.cache' \
  --tag dsh-nightly \
  --tag "$HOST_TAG" \
  "$@"
rc=$?

# 备份成功后顺带把本机 git 仓库镜像到 VPS（2026-11-11）。
# 只真实备份（不带参数）时做；失败只告警，不改变备份的退出码。
if [ "$rc" -eq 0 ] && [ "$#" -eq 0 ]; then
  MIRROR="$HOME/dsh/playground/themes/dsh-guava-pack/ops/backup/git-mirror-push.sh"
  if [ -x "$MIRROR" ]; then
    "$MIRROR" || echo "⚠️ git 镜像失败（备份本身成功，见上）" >&2
  fi
fi
exit "$rc"
