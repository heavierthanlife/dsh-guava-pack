#!/usr/bin/env bash
# PC 侧健康自检 → 推给 Uptime Kuma 的 push 监控（每台 PC 一条）。
#
# 为什么需要：Kuma 从**外部**探 `http://VPS:<REMOTE_PORT>/go` 只能发现
# 「隧道 + 入口代理 + DSH」整体挂掉；如果 DSH 自己崩了而入口代理还在，
# 外部探测仍然 302（入口代理只是转发 3080），告警不会响。这里从**内部**查。
#
# 检查项（都是"会静默坏掉、但没人会主动看"的）：
#   · DSH 本体             127.0.0.1:3080         期望 200/401
#   · commandcode 桥接      127.0.0.1:8317/v1/models 期望 200（未启用则跳过）
#   · 供应商路由代理        127.0.0.1:8318/health   期望 200
#   · 中继入口反代          127.0.0.1:3098/go      期望 302/401（未接入则跳过）
#   · VPS 上的隧道端口      http://$VPS:$REMOTE_PORT/go 期望 302/401
#   · 根分区使用率          < DISK_LIMIT%
#
# 配置：~/.config/dsh/pc-health.env（600），由 install.sh 写入
#   KUMA_URL=http://100.109.125.37:3001
#   KUMA_PUSH_TOKEN=<本机专属令牌>
#   VPS=100.109.125.37
#   REMOTE_PORT=22023
#
# 退出码：0=全部正常（已推 up），1=有问题（已推 down），2=配置缺失/推送失败
set -uo pipefail

ENV_FILE="${PC_HEALTH_ENV:-$HOME/.config/dsh/pc-health.env}"
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

VPS="${VPS:-100.109.125.37}"
KUMA_URL="${KUMA_URL:-http://100.109.125.37:3001}"
DISK_LIMIT="${DISK_LIMIT:-90}"
TOKEN="${KUMA_PUSH_TOKEN:-}"
REMOTE_PORT="${REMOTE_PORT:-}"

problems=()
notes=()

http_code() { curl -s -o /dev/null -m 6 -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

check() { # <名称> <url> <允许的状态码（空格分隔）> [可选=1]
  local name="$1" url="$2" ok="$3" optional="${4:-0}" code
  code=$(http_code "$url")
  case " $ok " in
    *" $code "*) ;;
    *)
      if [ "$optional" = "1" ] && [ "$code" = "000" ]; then
        notes+=("$name 未启用")
      else
        problems+=("$name HTTP $code")
      fi
      ;;
  esac
}

# ── 内部服务 ───────────────────────────────────────────────────────────
check "DSH(3080)"       "http://127.0.0.1:3080/"            "200 401"
check "桥接(8317)"      "http://127.0.0.1:8317/v1/models"   "200" 1
check "路由代理(8318)"  "http://127.0.0.1:8318/health"      "200" 1
check "入口反代(3098)"  "http://127.0.0.1:3098/go"          "302 401" 1

# ── 隧道（从 VPS 上探自己的端口）───────────────────────────────────────
if [ -n "$REMOTE_PORT" ]; then
  check "隧道($REMOTE_PORT)" "http://$VPS:$REMOTE_PORT/go" "302 401" 1
fi

# ── 磁盘 ───────────────────────────────────────────────────────────────
disk=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "${disk:-}" ] && [ "$disk" -ge "$DISK_LIMIT" ]; then
  problems+=("根分区 ${disk}%")
fi

# ── 汇总并推送 ─────────────────────────────────────────────────────────
if [ ${#problems[@]} -gt 0 ]; then
  status="down"; msg="异常：$(IFS=', '; echo "${problems[*]}")"
else
  status="up"
  msg="正常：DSH/桥接/路由/入口/隧道 均可达，磁盘 ${disk:-?}%"
  [ ${#notes[@]} -gt 0 ] && msg="$msg（跳过：$(IFS=', '; echo "${notes[*]}")）"
fi

echo "[$(date -Is)] $status — $msg"

if [ -z "$TOKEN" ]; then
  echo "❌ 没有 KUMA_PUSH_TOKEN（$ENV_FILE）—— 先跑 ops/pc-health/install.sh --token <令牌>" >&2
  exit 2
fi

curl -fsS -m 10 -o /dev/null \
  --get "$KUMA_URL/api/push/$TOKEN" \
  --data-urlencode "status=$status" \
  --data-urlencode "msg=$msg" \
  --data-urlencode "ping=1" || { echo "⚠️ 推送 Kuma 失败（$KUMA_URL）" >&2; exit 2; }

[ "$status" = "up" ] && exit 0 || exit 1
