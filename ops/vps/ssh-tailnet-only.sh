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
  # 阿里云 Workbench / 实例登录（免密登录）从内网 100.104.0.0/16 连私网 IP:22；
  # 不放行它，控制台的“实例登录”会被这条链 DROP（实例本身没问题）。
  # 这是 IPv4 网段，不能喂给 ip6tables。
  if [ "$cmd" = iptables ]; then
    "$cmd" -A "$chain" -s 100.104.0.0/16 -p tcp --dport 22 -j ACCEPT
  fi
  "$cmd" -A "$chain" -p tcp --dport 22 -j DROP
  "$cmd" -C INPUT -j "$chain" 2>/dev/null || "$cmd" -I INPUT 1 -j "$chain"
done
