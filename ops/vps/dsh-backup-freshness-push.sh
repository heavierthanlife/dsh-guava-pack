#!/usr/bin/env bash
# 备份新鲜度自检 → Uptime Kuma push 监控（"DSH 备份新鲜度"）。
#
# 为什么单独一个：备份失败是**静默**的 —— PC 上 journal 没人看，而 restic 每天
# 03:30 跑一次。超过 26 小时没有新快照（每天一次 + 2 小时容差）就判 down 并推送。
#
# 触发频率：每 6 小时（Kuma 侧期望 24 小时内至少一次）。
set -uo pipefail

KUMA_URL="${KUMA_URL:-http://100.109.125.37:3001}"
ENV_FILE="${KUMA_TOKEN_FILE:-/etc/kuma/push-tokens.env}"
REPO="${RESTIC_REPOSITORY:-/srv/backup/dsh}"
PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/restic/repo-password}"
CACHE_DIR="${RESTIC_CACHE_DIR:-/var/cache/restic}"
RESTIC_BIN="${RESTIC_BIN:-/usr/local/bin/restic}"
MAX_AGE_H="${MAX_AGE_HOURS:-26}"

if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

push() {
  local status="$1" msg="$2"
  local token="${KUMA_PUSH_BACKUP:-}"
  if [ -z "$token" ]; then
    echo "❌ 没有 KUMA_PUSH_BACKUP 令牌（$ENV_FILE）" >&2
    exit 2
  fi
  curl -fsS -m 10 -o /dev/null \
    --get "$KUMA_URL/api/push/$token" \
    --data-urlencode "status=$status" \
    --data-urlencode "msg=$msg" \
    --data-urlencode "ping=1" || echo "⚠️ 推送 Kuma 失败（$KUMA_URL）" >&2
  echo "[$(date -Is)] push $status: $msg"
}

if [ ! -r "$PASSWORD_FILE" ]; then
  push down "❌ 读不到仓库密码：$PASSWORD_FILE"
  exit 1
fi

json=$(runuser -u restic -- env \
  RESTIC_REPOSITORY="$REPO" \
  RESTIC_PASSWORD_FILE="$PASSWORD_FILE" \
  RESTIC_CACHE_DIR="$CACHE_DIR" \
  "$RESTIC_BIN" snapshots --no-lock --json 2>/dev/null) || json=""

if [ -z "$json" ]; then
  push down "❌ 读不到仓库快照（$REPO）"
  exit 1
fi

read -r count newest latest_epoch <<EOF
$(printf '%s' "$json" | python3 -c '
import json, sys
try:
    snaps = json.load(sys.stdin)
except Exception:
    print("0 0 0"); raise SystemExit
if not snaps:
    print("0 0 0"); raise SystemExit
last = snaps[-1]["time"]
# 2026-11-11T03:31:00.660924654+08:00 → epoch
import datetime
t = datetime.datetime.fromisoformat(last)
print(f"{len(snaps)} {last} {int(t.timestamp())}")
')
EOF

if [ "${count:-0}" -eq 0 ]; then
  push down "❌ 仓库里没有任何快照"
  exit 1
fi

age_h=$(( ( $(date +%s) - latest_epoch ) / 3600 ))
if [ "$age_h" -gt "$MAX_AGE_H" ]; then
  push down "❌ 最新快照 ${newest} 已是 ${age_h}h 前（阈值 ${MAX_AGE_H}h），备份可能失败"
  exit 1
fi

push up "✓ ${count} 份快照，最新 ${age_h}h 前（${latest_epoch}）"
exit 0
