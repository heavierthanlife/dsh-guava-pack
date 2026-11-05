#!/usr/bin/env bash
# 把 ~/dsh（会话历史、workspace、插件源码）增量备份到 VPS 的 restic 仓库。
# 带宽受限：默认 200KB/s（约 1.6Mbps），给 DSH 隧道留出余量。
#
# 用法：restic-backup.sh [--dry-run]
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$HOME/.restic-pass}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-sftp:root@112.126.90.114:/srv/backup/dsh}"
SSH_ARGS="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15"
LIMIT="${RESTIC_LIMIT_KB:-200}"

exec "$HOME/.local/bin/restic" -o sftp.args="$SSH_ARGS" backup "$HOME/dsh" \
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
  "$@"
