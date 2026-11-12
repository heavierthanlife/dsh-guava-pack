#!/usr/bin/env bash
# A 方案自检：VPS 侧监听 + 手机是否直连 + 经隧道访问耗时
# 用法: bash check.sh <VPS tailnet IP> [手机 tailnet IP]
set -uo pipefail

VPS_TS="${1:?用法: check.sh <VPS tailnet IP> [手机 tailnet IP]}"
PHONE_TS="${2:-}"
SSH_OPTS="-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8"

# 本机的隧道端口：来自 config/machines.json（按主机名匹配），缺失时回退 22022。
# 两台机器端口不同（主力机 22022 / MSI 22023），写死会让另一台自检永远报"没监听"。
PORT="${DSH_TUNNEL_PORT:-$(node -e '
try {
  const os = require("os"), fs = require("fs");
  const file = process.env.HOME + "/dsh/playground/themes/dsh-guava-pack/config/machines.json";
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const host = os.hostname().toLowerCase();
  const list = cfg.machines || [];
  const mine = list.find((m) => String(m.host || "").toLowerCase() === host) || list[0] || {};
  process.stdout.write(String(mine.tunnel_port || 22022));
} catch { process.stdout.write("22022"); }
' 2>/dev/null)}"
PORT="${PORT:-22022}"

echo "== VPS 侧监听 :${PORT}（应只绑 ${VPS_TS}）=="
ssh $SSH_OPTS "root@${VPS_TS}" "ss -ltn | grep ":${PORT} " || echo '  ❌ 没监听（PC 上的 dsh-tunnel.service 没起？）'"

echo
echo "== 手机连接方式 =="
if [ -n "$PHONE_TS" ]; then
  ssh $SSH_OPTS "root@${VPS_TS}" "tailscale status | grep ${PHONE_TS} || echo '  手机不在线'"
else
  ssh $SSH_OPTS "root@${VPS_TS}" "tailscale status | grep -E 'android|iphone|ipad' || echo '  没有移动设备在线'"
fi

echo
echo "== 经隧道访问 DSH（3 次）=="
ssh $SSH_OPTS "root@${VPS_TS}" "for i in 1 2 3; do curl -so /dev/null -w '  %{http_code}  %{time_total}s\n' --max-time 8 http://${VPS_TS}:${PORT}/go; done"

echo
echo "判据：tailscale status 里手机那行"
echo "  active; direct <ip:port>  → 正常"
echo "  active; relay \"tok\"      → 走了东京中继，先查安全组 UDP 41641"
