#!/usr/bin/env bash
# A3：把 restic 仓库的**加密文件**镜像到异地对象存储（2026-11-11）。
#
# 为什么不是 `restic copy`：目标端如果是「S3 兼容存储」，restic 需要目标端提供
# 兼容的 REST/S3 语义；阿里云 OSS 虽然兼容 S3 协议，但不同版本行为有差异。
# 这里选更稳的做法：仓库本身已经是**加密的**（AES-256 + Poly1305），
# 直接把 `/srv/backup/dsh` 的密文按文件镜像过去，灾难恢复时用 rclone 拉回来即可，
# 完全不依赖目标端是否"懂 restic"。
#
# 方向：VPS 本地 → 远端（rclone `copy`，只增不删）：
#   · 不用 `sync`：prune 删掉的旧 pack 在异地留着没有坏处（restic 会忽略未引用对象），
#     而 `sync` 一旦配置写错（比如 bucket 指错）有误删风险；
#   · 内容寻址文件不可变，`copy` 天然幂等。
#
# 配置：/etc/rclone/rclone.conf（600 root），形如
#   [offsite]
#   type = s3
#   provider = Alibaba
#   endpoint = oss-cn-beijing.aliyuncs.com
#   access_key_id = <RAM 用户 AK>
#   secret_access_key = <RAM 用户 SK>
#
# 未配置 / 仍是占位符时：**明确退出 3**，不静默成功（健康自检也会据此提示）。
set -uo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"
CONFIG="${RCLONE_CONFIG:-/etc/rclone/rclone.conf}"
SRC="${RESTIC_REPO:-/srv/backup/dsh}"
REMOTE="${OFFSITE_REMOTE:-offsite:dsh-backup/dsh}"
STAMP="${OFFSITE_STAMP:-/srv/backup/.offsite-last-run}"
BW="${OFFSITE_BWLIMIT:-8M}"

if [ ! -d "$SRC" ]; then
  echo "❌ 本地仓库不存在：$SRC" >&2
  exit 2
fi
if [ ! -r "$CONFIG" ]; then
  echo "❌ 未配置异地存储：$CONFIG 不存在（见 ops/backup/README.md 的 A3 一节）" >&2
  exit 3
fi
if grep -q 'CHANGE_ME' "$CONFIG" 2>/dev/null; then
  echo "❌ $CONFIG 里还有 CHANGE_ME 占位符：把 OSS bucket / RAM AK / SK 填好再跑" >&2
  exit 3
fi
command -v rclone >/dev/null || { echo "❌ 没装 rclone" >&2; exit 2; }

echo "[$(date -Is)] rclone copy $SRC → $REMOTE（bwlimit=$BW）"
rclone --config "$CONFIG" copy "$SRC" "$REMOTE" \
  --transfers 4 --checkers 8 --fast-list \
  --bwlimit "$BW" \
  --stats 30s --stats-one-line
rc=$?
if [ "$rc" -eq 0 ]; then
  date -Is > "$STAMP"
  local_size=$(du -sh "$SRC" 2>/dev/null | cut -f1)
  echo "[$(date -Is)] 完成 rc=0（本地 $local_size 已镜像）"
else
  echo "[$(date -Is)] rclone 失败 rc=$rc（下次重试；失败不会删除远端已有数据）" >&2
fi
exit "$rc"
