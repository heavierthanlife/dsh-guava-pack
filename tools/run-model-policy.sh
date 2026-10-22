#!/bin/sh
# model-policy 定时任务的入口。
#
# ## 为什么需要这层壳
#
# systemd 不能 `eval`，而同步工具需要两组环境变量：
#   1. **provider key** —— 用户可能填在 DSH 凭证库里（`<DSH_HOME>/.credentials.yaml`
#      的 refs 段），而定时任务是独立进程，只读环境变量；
#   2. **每台机器的 DSH_* 设置** —— 例如 `DSH_SSR_PROXY`（端口每台机器不同）、
#      `DSH_GUAVA_PACK`。这些通常写在 `~/.bashrc`，systemd 也不读。
#
# 两个都缺时任务不会崩，但会**静默少探测一批模型**（key 缺失 → 全部 401 →
# 免费模型被"保守保留"），是很隐蔽的失效。所以这里统一补齐。
#
# node 路径也不写死 `/usr/bin/node`：nvm / npm-global 装机上那个路径不存在，
# 定时任务会天天失败却没人看日志。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x /usr/bin/node ]; then
  NODE_BIN=/usr/bin/node
elif [ -x "$HOME/.npm-global/bin/node" ]; then
  NODE_BIN="$HOME/.npm-global/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "[model-policy] 找不到 node，无法运行同步工具" >&2
  exit 1
fi

# 1) 每台机器的 DSH_* 设置（非交互 shell 不读 .bashrc，必须显式载入）
if [ -f "$HOME/.bashrc" ]; then
  eval "$(grep -E '^export DSH_[A-Z_]+=' "$HOME/.bashrc" 2>/dev/null)"
fi

# 2) 凭证库里的 provider key（只走 stdout，不落盘、不写日志）
if [ -f "$HERE/export-provider-keys.mjs" ]; then
  eval "$("$NODE_BIN" "$HERE/export-provider-keys.mjs" 2>/dev/null)"
fi

exec "$NODE_BIN" "$HERE/sync-model-policy.mjs" "$@"
