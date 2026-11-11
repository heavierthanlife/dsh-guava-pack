#!/bin/sh
# 在 Tailscale 的 ts-input 之前放行阿里云内网来源（元数据/DNS/云助手 + Workbench）。
#
# 背景：Tailscale 在 INPUT 挂了 ts-input，含
#   -A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP
# 而阿里云的这些内网地址都落在 100.64.0.0/10 里：
#   · 元数据/DNS/云助手：100.100.0.0/16（控制台免密登录、云助手依赖它）
#   · Workbench「实例登录」：100.104.0.0/16（从控制台连实例私网 22）
# 只要 ts-input 排在前面，这些包就会被 DROP，表现为：
#   curl 100.100.100.200 超时、云助手异常、控制台「实例登录失败」。
#
# 2026-11-11 实测事故：重启后顺序变成 ts-input → DSH_SSH_TAILNET → 100.100，
# 元数据与 Workbench 同时失效。根因是旧脚本 `-C || -I INPUT 1`：规则已存在时
# **不会**把它挪到最前面，顺序一旦被别的服务打乱就再也修不回来。
#
# 现在的做法（幂等、可反复执行）：
#   1. 先删掉这两条的**所有**旧副本（不管它们在哪）；
#   2. 再 `-I INPUT 1` 重新插到最顶；
#   3. 由 aliyun-metadata.timer 每 5 分钟兜底重排一次（tailscaled 重启会重插自己的链）。
set -eu

# 并发保护：timer、开机单元和手工重启可能撞在一起；两个实例同时"删+插"会产生重复规则。
exec 9>/run/dsh-aliyun-metadata.lock
# 用 -w 等锁而不是跳过：跳过会让"重排"偶发不生效（2026-11-11 实测留下重复规则）。
if ! flock -w 10 9; then
  echo "warn: 等锁超时，跳过本次"
  exit 0
fi

ensure_top() {
  # 删除所有匹配的旧副本（同一 match 可能被重复添加过）
  while iptables -D INPUT "$@" 2>/dev/null; do :; done
  iptables -I INPUT 1 "$@"
}

# 元数据 / 内网 DNS / 云助手
ensure_top -s 100.100.0.0/16 -j ACCEPT
# Workbench 实例登录（默认连实例私网 IP:22）
ensure_top -s 100.104.0.0/16 -p tcp --dport 22 -j ACCEPT

# 顺序自检：两条 ACCEPT 必须都在 ts-input 之前；否则打印警告（方便 journal 里发现）。
# 只按源地址匹配：iptables 打印时选项顺序会被规范化（-p/-s/-m 的先后不固定），
# 之前用「整段字面量」匹配会在某些渲染下失配（2026-11-11 14:57 实测 wb 匹配为空）。
pos_meta=$(iptables -S INPUT | grep -n -- "-s 100.100.0.0/16" | head -1 | cut -d: -f1)
pos_wb=$(iptables -S INPUT | grep -n -- "-s 100.104.0.0/16" | head -1 | cut -d: -f1)
pos_ts=$(iptables -S INPUT | grep -n -- "-j ts-input" | head -1 | cut -d: -f1)
if [ -n "$pos_ts" ]; then
  if [ -z "$pos_meta" ] || [ "$pos_meta" -gt "$pos_ts" ] || [ -z "$pos_wb" ] || [ "$pos_wb" -gt "$pos_ts" ]; then
    # 只告警、不失败：失败会让每 5 分钟的 timer 在 journal 里刷错误，
    # 而这套规则本身对"能上网"不是必需品（元数据/Workbench 才是）。
    echo "warn: 阿里云内网 ACCEPT 仍排在 ts-input 之后（meta=$pos_meta wb=$pos_wb ts=$pos_ts）" >&2
    exit 0
  fi
fi
echo "ok: 100.100.0.0/16 与 100.104.0.0/16:22 都在 ts-input 之前"
