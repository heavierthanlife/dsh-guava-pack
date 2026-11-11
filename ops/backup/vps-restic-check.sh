#!/usr/bin/env bash
# VPS 侧仓库完整性校验（2026-11-11 起，周跑）。
#
# 只抽查一部分数据块（默认 2%），2 核小机器上不会把 CPU 打满；
# 想更彻底：RESTIC_CHECK_SUBSET=5% systemctl start restic-check.service
set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/srv/backup/dsh}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/restic/repo-password}"
export RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/var/cache/restic}"
RESTIC_BIN="${RESTIC_BIN:-/usr/local/bin/restic}"
SUBSET="${RESTIC_CHECK_SUBSET:-2%}"

if [ ! -r "$RESTIC_PASSWORD_FILE" ]; then
  echo "❌ 读不到仓库密码：$RESTIC_PASSWORD_FILE" >&2
  exit 2
fi

echo "[$(date -Is)] check 开始：$RESTIC_REPOSITORY（read-data-subset=$SUBSET）"
nice -n 19 ionice -c3 "$RESTIC_BIN" check --read-data-subset="$SUBSET"
rc=$?
left=$(ls -1 "$RESTIC_REPOSITORY/locks" 2>/dev/null | wc -l)
echo "[$(date -Is)] check 结束 rc=$rc（剩余锁 $left）"
exit "$rc"
