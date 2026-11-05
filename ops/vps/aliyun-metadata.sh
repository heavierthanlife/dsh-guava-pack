#!/bin/sh
# 放行阿里云元数据/DNS 的源地址，绕过 Tailscale 的 CGNAT 防伪造规则。
#
# 背景：Tailscale 在 INPUT 里挂 ts-input，含
#   -A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP
# 阿里云元数据 100.100.100.200（以及内网 DNS 100.100.2.136/138）正好落在这个段里，
# 响应包从 eth0 回来就被 DROP：metadata 超时 → 云助手异常、DNS 不可用。
# 这里在 ts-input 之前显式 ACCEPT 这几个 /32（必须每条 -I INPUT 1）。
set -eu

for cmd in iptables; do
  command -v "$cmd" >/dev/null 2>&1 || continue
  for src in 100.100.100.200/32 100.100.2.136/32 100.100.2.138/32; do
    "$cmd" -C INPUT -s "$src" -j ACCEPT 2>/dev/null || "$cmd" -I INPUT 1 -s "$src" -j ACCEPT
  done
done
