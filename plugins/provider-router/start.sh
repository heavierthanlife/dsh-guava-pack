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
PORT=8318
HEALTH_URL="http://127.0.0.1:$PORT/health"

# 载入每台机器的 DSH_* 设置（DSH_SSR_PROXY 等）。
#
# 为什么必须在脚本里做：这些值放在 ~/.bashrc，而**非交互 shell 不读 .bashrc**。
# 从启动器 / systemd 起时，启动器已经 eval 过一遍，所以一直没暴露；但手动跑
# start.sh 时环境是空的 → router 落到默认 2080，而本机 SSR 在 2099 →
# **所有 SSR 请求 ECONNREFUSED**（真踩过）。自己加载一遍就两种起法都对了。
if [ -f "$HOME/.bashrc" ]; then
  eval "$(grep -E '^export DSH_[A-Z_]+=' "$HOME/.bashrc" 2>/dev/null)"
fi
echo "[dsh-provider-router] DSH_SSR_PROXY=${DSH_SSR_PROXY:-（未设置，用默认 2080）}" >>"$LOG_FILE"

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
