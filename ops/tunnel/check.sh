#!/usr/bin/env bash
# A 方案自检：VPS 侧监听 + 手机是否直连 + 经隧道访问耗时
# 用法: bash check.sh <VPS公网IP> <VPS tailnet IP> [手机 tailnet IP]
set -uo pipefail

VPS_PUB="${1:?用法: check.sh <VPS公网IP> <VPS tailnet IP> [手机 tailnet IP]}"
VPS_TS="${2:?缺少 VPS tailnet IP}"
PHONE_TS="${3:-}"
SSH_OPTS="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8"

echo "== VPS 侧监听（应只绑 ${VPS_TS}）=="
ssh $SSH_OPTS "root@${VPS_PUB}" "ss -ltn | grep 22022 || echo '  ❌ 没监听（PC 上的 dsh-tunnel.service 没起？）'"

echo
echo "== 手机连接方式 =="
if [ -n "$PHONE_TS" ]; then
  ssh $SSH_OPTS "root@${VPS_PUB}" "tailscale status | grep ${PHONE_TS} || echo '  手机不在线'"
else
  ssh $SSH_OPTS "root@${VPS_PUB}" "tailscale status | grep -E 'android|iphone|ipad' || echo '  没有移动设备在线'"
fi

echo
echo "== 经隧道访问 DSH（3 次）=="
ssh $SSH_OPTS "root@${VPS_PUB}" "for i in 1 2 3; do curl -so /dev/null -w '  %{http_code}  %{time_total}s\n' --max-time 8 http://${VPS_TS}:22022/go; done"

echo
echo "判据：tailscale status 里手机那行"
echo "  active; direct <ip:port>  → 正常"
echo "  active; relay \"tok\"      → 走了东京中继，先查安全组 UDP 41641"
