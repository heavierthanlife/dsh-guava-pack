#!/usr/bin/env bash
# 启动 commandcode-bridge（常驻，供 DSH 通过 OpenAI 兼容接口使用 $1 Go 套餐）
#
# 用法：
#   ./start.sh            # 幂等：活着且健康就什么都不做（启动器里用它）
#   ./start.sh --force    # 改过 server.mjs 后强制重启（否则会一直跑旧代码）
set -uo pipefail

# $0 而不是 BASH_SOURCE：被 `sh start.sh` 调用时 bash 专属变量会直接
# "Bad substitution" 退出（systemd / 别的 shell 里踩过）。
HERE="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$HERE/bridge.pid"
PORT="${BRIDGE_PORT:-8317}"

# 从 ~/.bashrc 载入 key（与 dsh 启动器同一套约定）
if [ -z "${COMMANDCODE_API_KEY:-}" ]; then
  eval "$(grep -E '^export COMMANDCODE_API_KEY=' "$HOME/.bashrc" 2>/dev/null)"
fi
# 回落到 DSH 凭证库：key 可能存在 <DSH_HOME>/.credentials.yaml 的 refs 段
# （用户在设置里填 key 时就走这里，不会写 .bashrc）。
if [ -z "${COMMANDCODE_API_KEY:-}" ]; then
  # ⚠️ pack 位置不能写死一个默认值：曾经写成 `$HOME/dsh-guava-pack`，而实际装在
  # `$HOME/dsh/playground/themes/dsh-guava-pack`。路径错了 → 导出 key 的 helper
  # 找不到 → 桥接启动即报"key 未设置"，而真正原因（路径）完全看不出来。
  for _cand in "${DSH_GUAVA_PACK:-}" \
               "$HOME/dsh/playground/themes/dsh-guava-pack" \
               "$HOME/dsh-guava-pack" \
               "$(cd "$HERE/../.." 2>/dev/null && pwd)"; do
    [ -n "$_cand" ] || continue
    _helper="$_cand/tools/export-provider-keys.mjs"
    if [ -f "$_helper" ] && command -v node >/dev/null 2>&1; then
      eval "$(node "$_helper" 2>/dev/null)"
      break
    fi
  done
fi
if [ -z "${COMMANDCODE_API_KEY:-}" ]; then
  echo "错误：COMMANDCODE_API_KEY 未设置（~/.bashrc 与 DSH 凭证库都没有）" >&2
  exit 1
fi

# x-command-code-version 必须跟随已安装的 CLI
if [ -z "${CC_CLI_VERSION:-}" ]; then
  CC_CLI_VERSION="$(node -p "require('$HOME/.npm-global/lib/node_modules/command-code/package.json').version" 2>/dev/null \
    || npx --no-install command-code --version 2>/dev/null | tr -dc '0-9.' \
    || echo '1.72.4')"
fi
export CC_CLI_VERSION COMMANDCODE_API_KEY BRIDGE_PORT="$PORT"

# `--force`：改过 server.mjs 要立即生效时用。
# 默认的"健康就退出"会把"代码改了但跑的还是旧的"变成一个毫无提示的坑。
FORCE=0
for _a in "$@"; do [ "$_a" = "--force" ] && FORCE=1; done
if [ "$FORCE" = "1" ]; then
  OLD=""
  [ -f "$PIDFILE" ] && OLD="$(cat "$PIDFILE" 2>/dev/null)"
  if command -v fuser >/dev/null 2>&1; then
    PORT_PIDS="$(fuser -n tcp "$PORT" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)"
    [ -n "$PORT_PIDS" ] && OLD="$PORT_PIDS"
  fi
  if [ -n "$OLD" ]; then
    echo "--force：停止 $OLD"
    kill $OLD 2>/dev/null || true
    sleep 1
    kill -9 $OLD 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PIDFILE"
fi

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
