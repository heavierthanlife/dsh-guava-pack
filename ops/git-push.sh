#!/usr/bin/env bash
# 唯一的推送入口：先 rebase 再推。
#
# 为什么需要：两台 PC 共用同一个仓库的 master 分支。谁先 push 谁赢，后推的一方
# 会收到 `! [rejected] ... non-fast-forward`。手工补 `git pull --rebase` 容易漏，
# 用这个脚本一步做完；冲突时**自动回滚**到原状，不会把工作区搞成半截状态。
#
#   bash ops/git-push.sh              # 提交完直接跑这个
#   bash ops/git-push.sh --dry-run    # 只看会做什么，不推
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

cd "$(git rev-parse --show-toplevel)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# 1) 脏工作区直接拒绝：自动 stash 只会让人忘了恢复（历史教训）。
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区有未提交的改动，先提交再推："
  git status --short | head -20
  exit 1
fi

# 2) 拉取并 rebase。
echo "→ git fetch --prune origin"
git fetch --prune origin

echo "→ git pull --rebase origin $BRANCH"
if ! git pull --rebase origin "$BRANCH"; then
  git rebase --abort 2>/dev/null || true
  cat <<'EOF'
✗ rebase 冲突，已回滚到推送前的状态（什么都没坏）。
  手工处理：
    git pull --rebase origin <branch>
    # 逐个解决冲突 → git add <file> → git rebase --continue
    bash ops/git-push.sh
EOF
  exit 1
fi

# 3) 推送。
if [ "$DRY" = "1" ]; then
  echo "→ (dry-run) 将要推送："
  git log --oneline "origin/$BRANCH..HEAD" | head -20
  exit 0
fi

echo "→ git push origin $BRANCH"
git push origin "$BRANCH"
git log -1 --format='✓ 已推送 %h  %s'
