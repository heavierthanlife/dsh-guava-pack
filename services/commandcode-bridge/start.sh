#!/usr/bin/env bash
# 启动 commandcode-bridge（常驻，供 DSH 通过 OpenAI 兼容接口使用 $1 Go 套餐）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$HERE/bridge.pid"
PORT="${BRIDGE_PORT:-8317}"

# 从 ~/.bashrc 载入 key（与 dsh 启动器同一套约定）
if [ -z "${COMMANDCODE_API_KEY:-}" ]; then
  eval "$(grep -E '^export COMMANDCODE_API_KEY=' "$HOME/.bashrc" 2>/dev/null)"
fi
if [ -z "${COMMANDCODE_API_KEY:-}" ]; then
  echo "错误：COMMANDCODE_API_KEY 未设置（~/.bashrc 里也没有）" >&2
  exit 1
fi

# x-command-code-version 必须跟随已安装的 CLI
if [ -z "${CC_CLI_VERSION:-}" ]; then
  CC_CLI_VERSION="$(node -p "require('$HOME/.npm-global/lib/node_modules/command-code/package.json').version" 2>/dev/null \
    || npx --no-install command-code --version 2>/dev/null | tr -dc '0-9.' \
    || echo '1.72.4')"
fi
export CC_CLI_VERSION COMMANDCODE_API_KEY BRIDGE_PORT="$PORT"

# 幂等：端口已在服务就直接退出（覆盖 pidfile 丢失/过期的情况）
if curl -sS -m 2 --noproxy '*' "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "已在运行 (port $PORT)"
  exit 0
fi
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "进程 $(cat "$PIDFILE") 还在但端口无响应，重启它"
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 0.5
fi

cd "$HERE"
setsid nohup node server.mjs >> "$HERE/bridge.out" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
sleep 1.5

if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "已启动 pid=$(cat "$PIDFILE") port=$PORT cli=$CC_CLI_VERSION"
  curl -sS -m 5 --noproxy '*' "http://127.0.0.1:$PORT/health" 2>/dev/null && echo
else
  echo "启动失败，看 $HERE/bridge.out" >&2
  tail -20 "$HERE/bridge.out" >&2
  exit 1
fi
