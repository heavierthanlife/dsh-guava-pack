#!/usr/bin/env bash
# 停止 commandcode-bridge
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$HERE/bridge.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    sleep 0.7
    kill -9 "$PID" 2>/dev/null || true
    echo "已停止 pid=$PID"
  else
    echo "pid $PID 已不在"
  fi
  rm -f "$PIDFILE"
else
  # 兜底：按命令行匹配
  PIDS="$(pgrep -f "commandcode-bridge/server.mjs" 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null; echo "已停止: $PIDS"; else echo "没有在运行"; fi
fi
