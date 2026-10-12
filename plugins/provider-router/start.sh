#!/usr/bin/env bash
# Start the dsh-provider-router proxy idempotently (health-checked).
#
# Handles three start conditions:
#   1. alive + healthy          -> nothing to do
#   2. alive but unhealthy      -> kill it, then start fresh (else the port stays bound)
#   3. not alive / no pid file  -> start fresh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/router.pid"
LOG_FILE="$DIR/router.log"
# 与 router.mjs 用同一套环境变量，云端换端口/监听地址不必改脚本。
# setsid 会继承环境，所以这里的变量会原样传给 node 进程。
PORT="${DSH_ROUTER_PORT:-8318}"
HOST="${DSH_ROUTER_HOST:-127.0.0.1}"
HEALTH_URL="http://$HOST:$PORT/health"

healthy() { curl -sf "$HEALTH_URL" >/dev/null 2>&1; }

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    if healthy; then
      echo "[dsh-provider-router] already running (pid $OLD_PID)"
      exit 0
    fi
    echo "[dsh-provider-router] pid $OLD_PID is alive but unhealthy — restarting"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# setsid 是必须的：裸 nohup 起的进程仍挂在调用它的 shell 会话上，会话一收就被
# 一起带走 —— 这正是 router 曾在 DSH 重启后"消失"、3080/8317/8318 三个端口全空
# 的原因。commandcode-bridge/start.sh 用的是同一写法，保持一致。
setsid nohup node "$DIR/lib/router.mjs" >"$LOG_FILE" 2>&1 < /dev/null &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

for _ in $(seq 1 20); do
  if healthy; then
    echo "[dsh-provider-router] started (pid $NEW_PID)"
    exit 0
  fi
  sleep 0.5
done

# Leave no stale pid file behind, or every later start would try to reuse it.
rm -f "$PID_FILE"
echo "[dsh-provider-router] failed to become healthy — see $LOG_FILE" >&2
exit 1
