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

# 载入每台机器的 DSH_* 设置（DSH_SSR_PROXY 等）。
#
# 为什么必须在脚本里做：这些值放在 ~/.bashrc，而**非交互 shell 不读 .bashrc**。
# 从启动器 / systemd 起时，启动器已经 eval 过一遍，所以一直没暴露；但手动跑
# start.sh 时环境是空的 → router 落到默认 2080，而另一台机器的 SSR 在 2099 →
# **所有 SSR 请求 ECONNREFUSED**（真踩过）。自己加载一遍就两种起法都对了。
if [ -f "$HOME/.bashrc" ]; then
  eval "$(grep -E '^export DSH_[A-Z_]+=' "$HOME/.bashrc" 2>/dev/null)"
fi

# 端口必须可覆盖：另一台机器 / 多实例调试时会换端口，硬编码 8318 会让健康检查
# 永远打在错误的地址上，表现为"明明起来了却一直重启"。
PORT="${DSH_ROUTER_PORT:-8318}"
HEALTH_URL="http://127.0.0.1:$PORT/health"

# mode.json 三方共用（launcher 会导出一份绝对路径）。没导出时按布局找一个存在的，
# 找不到就在本插件目录下建一份默认 —— 让面板开关至少有个可写的位置。
if [ -z "${DSH_ROUTER_MODE_FILE:-}" ]; then
  for _cand in "$DIR/mode.json" "$DIR/../../../../playground/themes/provider-router/mode.json"; do
    [ -f "$_cand" ] && DSH_ROUTER_MODE_FILE="$_cand" && break
  done
  [ -z "${DSH_ROUTER_MODE_FILE:-}" ] && DSH_ROUTER_MODE_FILE="$DIR/mode.json"
  export DSH_ROUTER_MODE_FILE
fi
mkdir -p "$(dirname "$DSH_ROUTER_MODE_FILE")" 2>/dev/null || true

{
  echo "[dsh-provider-router] PORT=$PORT"
  echo "[dsh-provider-router] DSH_SSR_PROXY=${DSH_SSR_PROXY:-（未设置，用默认 2080）}"
  echo "[dsh-provider-router] HEADER_TIMEOUT_MS=${DSH_ROUTER_HEADER_TIMEOUT_MS:-（未设置，用默认 60000）}"
  echo "[dsh-provider-router] MODE_FILE=$DSH_ROUTER_MODE_FILE"
} >>"$LOG_FILE"

healthy() { curl -sf "$HEALTH_URL" >/dev/null 2>&1; }

# `--force`：**改了代码要重启**时用。
#
# 默认是幂等的（健康就什么都不做），这在启动器里是对的，但会把"改了 router.mjs
# 却还在跑旧代码"变成一个几乎无法自察的坑 —— 进程健康、端口正常，就是行为没变。
# 加了 --force 就先按 pidfile / 监听端口把老进程收掉，再起新的。
FORCE=0
for _a in "$@"; do [ "$_a" = "--force" ] && FORCE=1; done
if [ "$FORCE" = "1" ]; then
  OLD=""
  [ -f "$PID_FILE" ] && OLD="$(cat "$PID_FILE" 2>/dev/null)"
  if [ -f /usr/bin/fuser ] || command -v fuser >/dev/null 2>&1; then
    # 端口上真正的监听者（pidfile 可能已过期，见"多来源启动"问题）
    PORT_PIDS="$(fuser -n tcp "$PORT" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)"
    [ -n "$PORT_PIDS" ] && OLD="$PORT_PIDS"
  fi
  if [ -n "$OLD" ]; then
    echo "[dsh-provider-router] --force：停止 $OLD"
    kill $OLD 2>/dev/null || true
    sleep 1
    kill -9 $OLD 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

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
