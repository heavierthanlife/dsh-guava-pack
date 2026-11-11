#!/usr/bin/env bash
# VPS 健康自检 → 推给 Uptime Kuma 的 push 监控（"VPS 健康"）。
#
# 触发频率：每 30 分钟（timer 见 dsh-health-push.timer），Kuma 侧期望 1 次/小时。
# 检查项都是"会静默坏掉、但没人会主动看"的东西：
#   · 根分区使用率 > 85%
#   · 可用内存 < 120 MiB（2C2G 上再低就会触发 OOM/swap 抖动）
#   · restic 仓库里有锁（陈旧锁会让每晚备份全部失败）
#   · 关键服务（tailscaled / rest-server / ntfy / uptime-kuma / sshd）不是 active
#   · 有待重启的更新（只写进消息，不判 down）
#
# 令牌在 /etc/kuma/push-tokens.env（由 ops/vps/kuma-configure.py 生成）。
set -uo pipefail

KUMA_URL="${KUMA_URL:-http://100.109.125.37:3001}"
ENV_FILE="${KUMA_TOKEN_FILE:-/etc/kuma/push-tokens.env}"
LOCKS_DIR="${RESTIC_LOCKS_DIR:-/srv/backup/dsh/locks}"
DISK_LIMIT="${DISK_LIMIT:-85}"
MEM_MIN_MB="${MEM_MIN_MB:-120}"

problems=()
notes=()

if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

push() {
  local status="$1" msg="$2"
  local token="${KUMA_PUSH_HEALTH:-}"
  if [ -z "$token" ]; then
    echo "❌ 没有 KUMA_PUSH_HEALTH 令牌（$ENV_FILE）" >&2
    exit 2
  fi
  curl -fsS -m 10 -o /dev/null \
    --get "$KUMA_URL/api/push/$token" \
    --data-urlencode "status=$status" \
    --data-urlencode "msg=$msg" \
    --data-urlencode "ping=1" || echo "⚠️ 推送 Kuma 失败（$KUMA_URL）" >&2
  echo "[$(date -Is)] push $status: $msg"
}

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "${disk:-0}" -gt "$DISK_LIMIT" ]; then
  problems+=("根分区 ${disk}% (>${DISK_LIMIT}%)")
fi

mem_avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
mem_avail_mb=$(( ${mem_avail_kb:-0} / 1024 ))
if [ "$mem_avail_mb" -lt "$MEM_MIN_MB" ]; then
  problems+=("可用内存 ${mem_avail_mb}MiB (<${MEM_MIN_MB}MiB)")
fi

locks=$(find "$LOCKS_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l)
if [ "$locks" -gt 0 ]; then
  problems+=("restic 有 ${locks} 把锁（备份会失败）")
fi

for svc in tailscaled rest-server ntfy uptime-kuma miniserve sshd; do
  state=$(systemctl is-active "$svc" 2>/dev/null || true)
  if [ "$state" != "active" ]; then
    problems+=("$svc=${state:-unknown}")
  fi
done

# git 镜像：超过 48h 没更新 = 定时任务悄悄坏了。
STAMP="${GIT_MIRROR_STAMP:-/srv/git-mirror/.last-run}"
if [ -f "$STAMP" ]; then
  mirror_age_h=$(( ( $(date +%s) - $(stat -c %Y "$STAMP") ) / 3600 ))
  if [ "$mirror_age_h" -gt 48 ]; then
    problems+=("git 镜像 ${mirror_age_h}h 未更新")
  else
    notes+=("git 镜像 ${mirror_age_h}h 前")
  fi
else
  problems+=("git 镜像从未成功运行")
fi

# A3 异地镜像：填好 AK/SK 后才算"应有"；48h 没成功 = 异地副本已经过期。
OFFSITE_CFG="${OFFSITE_CONFIG:-/etc/rclone/rclone.conf}"
OFFSITE_STAMP="${OFFSITE_STAMP_FILE:-/srv/backup/.offsite-last-run}"
if [ -r "$OFFSITE_CFG" ] && ! grep -q 'CHANGE_ME' "$OFFSITE_CFG" 2>/dev/null; then
  if [ -f "$OFFSITE_STAMP" ]; then
    offsite_age_h=$(( ( $(date +%s) - $(stat -c %Y "$OFFSITE_STAMP") ) / 3600 ))
    if [ "$offsite_age_h" -gt 48 ]; then
      problems+=("异地镜像 ${offsite_age_h}h 未更新")
    else
      notes+=("异地镜像 ${offsite_age_h}h 前")
    fi
  else
    problems+=("异地镜像从未成功")
  fi
else
  notes+=("异地镜像未配置")
fi

[ -f /var/run/reboot-required ] && notes+=("需要重启（内核/库更新）")
# 只数安全更新，避免把 186 个普通待升级包当成告警噪音。
updates=$(apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null | grep -ci '^Inst.*security' || true)
[ "${updates:-0}" -gt 0 ] && notes+=("${updates} 个安全更新待装")

load=$(cut -d' ' -f1 /proc/loadavg)
notes+=("load ${load} / disk ${disk}% / mem ${mem_avail_mb}MiB / locks ${locks}")

if [ "${#problems[@]}" -gt 0 ]; then
  msg="❌ $(IFS='; '; echo "${problems[*]}")"
  [ "${#notes[@]}" -gt 0 ] && msg="$msg | $(IFS='; '; echo "${notes[*]}")"
  push down "$msg"
  exit 1
fi

push up "$(IFS='; '; echo "${notes[*]}")"
exit 0
