#!/usr/bin/env bash
# 把本机仓库以 --mirror 推到 VPS 的裸仓库（2026-11-11）。
#
# 为什么由 PC 推而不是 VPS 拉：VPS → github.com 的 TLS 链路会偶发
# `GnuTLS recv error (-110)`（实测重试也常失败），而 PC 侧访问 GitHub 稳定、
# 且已经能免密 SSH 到 VPS。所以镜像方向改成 PC → VPS（tailnet）。
#
# 触发：由 restic-backup.sh 在每日备份成功后顺带执行（失败不影响备份结果），
# 也可以手动跑：bash ops/backup/git-mirror-push.sh
#
# 结果：每个仓库推到 /srv/git-mirror/<name>.git；成功后写 .last-run，
#       VPS 的健康自检会检查它是否超过 48h 没更新。
set -uo pipefail

VPS="${VPS_SSH_HOST:-root@100.109.125.37}"
MIRROR_ROOT="${MIRROR_ROOT:-/srv/git-mirror}"
SSH_ARGS="${GIT_MIRROR_SSH_ARGS:--F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15}"
export GIT_SSH_COMMAND="ssh $SSH_ARGS"

REPOS=(
  "$HOME/dsh/playground/themes/dsh-guava-pack"
  "$HOME/dsh/playground/themes/dsh-theme-cyberpunk2077"
)

fail=0
ok=0
for local in "${REPOS[@]}"; do
  [ -d "$local/.git" ] || { echo "· 跳过（不是 git 仓库）：$local"; continue; }
  name="$(basename "$local")"
  # 远端裸仓库不存在就建一个（--mirror 推送需要空仓库）。
  ssh $SSH_ARGS "$VPS" "git init --bare -q '$MIRROR_ROOT/$name.git' 2>/dev/null || true" || true
  if out=$(git -C "$local" push --mirror "ssh://$VPS$MIRROR_ROOT/$name.git" 2>&1); then
    head=$(git -C "$local" rev-parse --short HEAD)
    echo "✓ $name @ $head"
    ok=$((ok + 1))
  else
    echo "❌ $name 推送失败：$(printf '%s' "$out" | tail -2 | tr '\n' ' ')" >&2
    fail=$((fail + 1))
  fi
done

echo "[$(date -Is)] 完成：$ok 成功，$fail 失败"
if [ "$fail" -eq 0 ] && [ "$ok" -gt 0 ]; then
  ssh $SSH_ARGS "$VPS" "date -Is > '$MIRROR_ROOT/.last-run'" || true
  exit 0
fi
exit 1
