#!/bin/sh
# 只允许 tailscale0（和 lo）进 SSH 22，其余接口丢弃。
# 幂等：可反复执行；iptables/ip6tables 各自维护一条专用链。
# 注意：应用后公网 22 立即不可达，Tailscale 断了只能走阿里云 VNC 控制台。
set -eu

for cmd in iptables ip6tables; do
  command -v "$cmd" >/dev/null 2>&1 || continue
  chain="DSH_SSH_TAILNET"
  "$cmd" -N "$chain" 2>/dev/null || true
  "$cmd" -F "$chain"
  "$cmd" -A "$chain" -i tailscale0 -p tcp --dport 22 -j ACCEPT
  "$cmd" -A "$chain" -i lo -p tcp --dport 22 -j ACCEPT
  "$cmd" -A "$chain" -p tcp --dport 22 -j DROP
  "$cmd" -C INPUT -j "$chain" 2>/dev/null || "$cmd" -I INPUT 1 -j "$chain"
done
