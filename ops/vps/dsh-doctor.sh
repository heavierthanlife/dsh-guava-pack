#!/usr/bin/env bash
# VPS 一键诊断（只读，不改任何东西）。2026-11-11 随 C2「应急手册」一起加。
#
# 用法：在 VPS 上 root 执行
#   bash /usr/local/sbin/dsh-doctor.sh          # 全量
#   bash /usr/local/sbin/dsh-doctor.sh --short  # 只列 FAIL 与关键行
#
# 什么时候用：手机连不上 DSH、监控报警、备份可疑、改过 iptables/安全组之后。
# 它按"排障顺序"检查：基础资源 → 服务 → 端口 → tailnet → 隧道 → 备份 → 监控。
set -uo pipefail

SHORT=0
[ "${1:-}" = "--short" ] && SHORT=1

fails=0
checks=0
say() { [ "$SHORT" = "1" ] && return 0; printf '%s\n' "$*"; }
ok()  { checks=$((checks + 1)); printf '  ✅ %s\n' "$*"; }
bad() { checks=$((checks + 1)); printf '  ❌ %s\n' "$*"; fails=$((fails + 1)); }
warn(){ printf '  ⚠️  %s\n' "$*"; }

section() { [ "$SHORT" = "1" ] || printf '\n== %s ==\n' "$*"; }

section "基础资源"
load=$(cut -d' ' -f1-3 /proc/loadavg)
say "  load: $load"
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
mem_avail=$(( $(awk '/MemAvailable/{print $2}' /proc/meminfo) / 1024 ))
[ "$disk" -lt 85 ] && ok "根分区 ${disk}%" || bad "根分区 ${disk}%（>85%）"
[ "$mem_avail" -gt 120 ] && ok "可用内存 ${mem_avail}MiB" || bad "可用内存 ${mem_avail}MiB（<120MiB）"

section "关键服务"
for svc in tailscaled ssh rest-server ntfy uptime-kuma miniserve; do
  st=$(systemctl is-active "$svc" 2>/dev/null || true)
  [ "$st" = "active" ] && ok "$svc" || bad "$svc = ${st:-unknown}"
done

section "监听端口（应只绑 tailnet，22 除外）"
for port in 22 22022 3000 3001 8080 8081; do
  addr=$(ss -ltn 2>/dev/null | awk -v p=":${port}$" '$4 ~ p {print $4; exit}')
  if [ -z "$addr" ]; then
    case "$port" in
      22022) warn "22022 没有监听（PC 的 dsh-tunnel 没连上？）" ;;
      *)     warn "$port 没有监听" ;;
    esac
  else
    ok "$port → $addr"
  fi
done

section "Tailnet"
ts_state=$(tailscale status 2>/dev/null | head -1)
[ -n "$ts_state" ] && ok "tailscale: $(printf '%s' "$ts_state" | cut -c1-80)" || bad "tailscale status 无输出"
[ "$SHORT" = "1" ] || tailscale status 2>/dev/null | head -8

section "SSH 收口规则"
if iptables -S DSH_SSH_TAILNET 2>/dev/null | grep -q "dport 22 -j DROP"; then
  ok "公网 22 已 DROP（tailnet/Workbench 放行）"
else
  bad "DSH_SSH_TAILNET 链缺失/未 DROP：公网 22 可能暴露"
fi

section "反向隧道"
ssh_sessions=$(ss -tn 2>/dev/null | awk '$4 ~ /:22$/ || $4 ~ /:22022$/' | wc -l)
[ "$ssh_sessions" -gt 0 ] && ok "SSH/隧道会话 $ssh_sessions 条" || warn "没有 SSH 会话"
if ss -ltn 2>/dev/null | grep -q ':22022'; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 6 http://100.109.125.37:22022/go 2>/dev/null || true)
  case "$code" in
    200|302|401) ok "经隧道访问 DSH /go → $code" ;;
    *) bad "经隧道访问 DSH /go → ${code:-timeout}（PC 上 dsh-remote-entry / DSH 是否在跑？）" ;;
  esac
fi

section "备份仓库"
REPO=/srv/backup/dsh
if [ -f "$REPO/config" ]; then
  ok "仓库存在：$(du -sh "$REPO" 2>/dev/null | cut -f1)"
  locks=$(find "$REPO/locks" -maxdepth 1 -type f 2>/dev/null | wc -l)
  [ "$locks" -eq 0 ] && ok "无锁" || bad "有 $locks 把锁（备份会失败；systemctl start restic-lock-janitor.service）"
  if [ -r /etc/restic/repo-password ]; then
    newest=$(runuser -u restic -- env RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD_FILE=/etc/restic/repo-password \
      RESTIC_CACHE_DIR=/var/cache/restic /usr/local/bin/restic snapshots --no-lock --json 2>/dev/null \
      | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[-1]["time"] if d else "")' 2>/dev/null || true)
    [ -n "$newest" ] && ok "最新快照：$newest" || bad "读不到快照"
  else
    warn "没有 /etc/restic/repo-password"
  fi
else
  bad "仓库路径不存在：$REPO"
fi

section "异地镜像（A3）"
OFFSITE_CFG=/etc/rclone/rclone.conf
OFFSITE_STAMP=/srv/backup/.offsite-last-run
if [ -r "$OFFSITE_CFG" ] && ! grep -q 'CHANGE_ME' "$OFFSITE_CFG" 2>/dev/null; then
  if [ -f "$OFFSITE_STAMP" ]; then
    offsite_age_h=$(( ( $(date +%s) - $(stat -c %Y "$OFFSITE_STAMP") ) / 3600 ))
    [ "$offsite_age_h" -le 48 ] && ok "异地镜像 ${offsite_age_h}h 前（$(cat "$OFFSITE_STAMP")）" \
      || bad "异地镜像 ${offsite_age_h}h 未更新（systemctl start offsite-sync.service）"
  else
    bad "异地镜像从未成功（systemctl start offsite-sync.service）"
  fi
else
  warn "异地镜像未配置：填 /etc/rclone/rclone.conf（见 ops/backup/README.md 的 A3）"
fi

section "监控 / 推送"
kuma=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://100.109.125.37:3001/ 2>/dev/null || true)
case "$kuma" in 200|302|401) ok "uptime-kuma HTTP $kuma" ;; *) bad "uptime-kuma HTTP ${kuma:-timeout}" ;; esac
ntfy=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://100.109.125.37:8080/v1/health 2>/dev/null || true)
case "$ntfy" in 200) ok "ntfy health 200" ;; *) bad "ntfy health ${ntfy:-timeout}" ;; esac
[ -f /srv/git-mirror/.last-run ] && ok "git 镜像：$(cat /srv/git-mirror/.last-run)" || warn "git 镜像从未成功"

section "最近 15 分钟错误日志"
errs=$(journalctl --since '-15min' -p err -q --no-pager 2>/dev/null | grep -vE 'audit|aegis' | head -5)
[ -z "$errs" ] && ok "无 err 级日志" || { warn "有 err 级日志："; [ "$SHORT" = "1" ] || printf '%s\n' "$errs"; }

printf '\n'
if [ "$fails" -eq 0 ]; then
  printf '✅ 诊断完成：没有发现硬故障（%d 项检查）\n' "$checks"
  exit 0
fi
printf '❌ 诊断完成：%d 个硬故障。先看上面的 ❌；恢复步骤见 ops/tunnel/BREAK-GLASS.md\n' "$fails"
exit 1
