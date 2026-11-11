#!/usr/bin/env bash
# 每日 03:00（早于 03:30 的 PC 备份）清理**陈旧**锁。
#
# 为什么需要：restic 进程被 kill -9 / 机器重启时会留下锁，之后所有备份都会报
# "repository is already locked"。`restic unlock`（不带 --remove-all）只删除
# 超过 30 分钟的锁，不会碰到正在进行的备份，所以可以安全地每天跑。
#
# 2026-11-11 实测踩到一次：prune 服务结束后残留了一把锁，直接把后续 forget
# 挡死了。prune/check 脚本现在也各自在结束时清理，这里再兜一层。
set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/srv/backup/dsh}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/restic/repo-password}"
export RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/var/cache/restic}"
RESTIC_BIN="${RESTIC_BIN:-/usr/local/bin/restic}"

if [ ! -r "$RESTIC_PASSWORD_FILE" ]; then
  echo "❌ 读不到仓库密码：$RESTIC_PASSWORD_FILE" >&2
  exit 2
fi

echo "[$(date -Is)] 清理陈旧锁（>30min）"
"$RESTIC_BIN" unlock
rc=$?
remaining=$(ls -1 "$RESTIC_REPOSITORY/locks" 2>/dev/null | wc -l)
echo "[$(date -Is)] 完成 rc=$rc，剩余锁 $remaining 个"
exit "$rc"
