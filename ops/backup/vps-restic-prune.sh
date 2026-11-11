#!/usr/bin/env bash
# 在 VPS 上直接操作仓库目录做 prune（2026-11-11 起）。
#
# 为什么挪到 VPS：
#   rest-server 以 --append-only 运行 —— 客户端（PC）只能追加，不能删除任何对象，
#   连 `restic forget` 都会被 403。回收必须在**能直接读写仓库目录**的一侧完成，
#   也就是 VPS 本地，用仓库文件系统路径而不是 HTTP。
#
# 语义与旧版保持一致：**只 prune，不 forget**（保留全部快照历史）。
# 想启用保留策略时，取消下面 FORGET_POLICY 的注释即可（默认关闭，避免误删历史）。
#
# 密码：/etc/restic/repo-password（600 restic:restic，由 PC 的 ~/.restic-pass 拷来）。
set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/srv/backup/dsh}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/restic/repo-password}"
export RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/var/cache/restic}"
RESTIC_BIN="${RESTIC_BIN:-/usr/local/bin/restic}"
# PC 侧 --limit-upload 是为了让带宽；VPS 本地 prune 不占外网，只限 CPU/IO。
NICE_CMD="nice -n 19 ionice -c3"

FORGET_POLICY="${FORGET_POLICY:-}"

if [ ! -r "$RESTIC_PASSWORD_FILE" ]; then
  echo "❌ 读不到仓库密码：$RESTIC_PASSWORD_FILE" >&2
  exit 2
fi
if [ ! -f "$RESTIC_REPOSITORY/config" ]; then
  echo "❌ 仓库路径不对：$RESTIC_REPOSITORY（没有 config 文件）" >&2
  exit 2
fi

echo "[$(date -Is)] prune 开始：$RESTIC_REPOSITORY"
# 上一次异常退出可能留下**陈旧**锁；只删 >30min 的锁（不带 --remove-all），
# 避免把 03:30 那份可能还在跑的备份的锁删掉。
$NICE_CMD "$RESTIC_BIN" unlock >/dev/null 2>&1 || true

if [ -n "$FORGET_POLICY" ]; then
  echo "[$(date -Is)] forget 策略：$FORGET_POLICY"
  # shellcheck disable=SC2086
  $NICE_CMD "$RESTIC_BIN" forget $FORGET_POLICY --prune
else
  $NICE_CMD "$RESTIC_BIN" prune
fi
rc=$?
# 收尾：如果仍留有锁，只清陈旧锁，并把剩余数量写进日志（健康检查会读它）。
"$RESTIC_BIN" unlock >/dev/null 2>&1 || true
left=$(ls -1 "$RESTIC_REPOSITORY/locks" 2>/dev/null | wc -l)
echo "[$(date -Is)] prune 结束 rc=$rc（剩余锁 $left）"
if [ "$rc" -eq 0 ]; then
  "$RESTIC_BIN" -r "$RESTIC_REPOSITORY" snapshots --no-lock --json 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"快照数 {len(d)}，最新 {d[-1][\"time\"] if d else \"—\"}")' 2>/dev/null || true
  du -sh "$RESTIC_REPOSITORY" 2>/dev/null || true
fi
exit "$rc"
