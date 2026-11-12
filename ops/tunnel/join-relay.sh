#!/usr/bin/env bash
# 把「另一台 PC」接进自建中继（VPS 上每个 PC 独占一个 220xx 端口）。
#
#   手机 ──Tailscale──▸ VPS:2202x ──SSH 反向隧道──▸ 本机 3098 ──▸ DSH 3080
#
# 在**要新增的那台 PC** 上执行：
#   bash join-relay.sh                    # 自动挑一个空闲的 220xx 端口
#   bash join-relay.sh --remote-port 22023
#   bash join-relay.sh --dry-run          # 只检查+打印，不写文件不重启服务
#
# 前置条件：
#   1) 本机 DSH 已在跑（127.0.0.1:3080，日志 ~/dsh/logs/web-run.log）；
#   2) 本机 Tailscale 已登录同一 tailnet（能 ping 通 VPS 的 100.x 地址）；
#   3) 本机 SSH 公钥已写进 VPS 的 /root/.ssh/authorized_keys（脚本会打印公钥）；
#   4) 有 systemd user session（Linux / WSL2 均可；Windows 原生 DSH 不适用）。
#
# 重复执行是幂等的：只会重写 tunnel.env 和两个 unit，然后重启服务。
set -euo pipefail

VPS_TS="${VPS_TS:-100.109.125.37}"
# VPS 的 ed25519 主机指纹，用于首次写入 known_hosts 时校验（防止 tailnet 内被顶替）。
VPS_FP="${VPS_FP:-SHA256:yKBUS7Fv4Nn1zZ8Gn0wMkEUWD/65uapg/TEGeOCVszA}"

REMOTE_PORT=""
LOCAL_PORT=3098
DSH_HOME="${DSH_HOME:-$HOME/dsh}"
PACK_DIR="${PACK_DIR:-}"
DRY_RUN=0
NO_START=0
UNIT_DIR="$HOME/.config/systemd/user"

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

选项：
  --remote-port N   VPS 上的监听端口（默认自动挑一个空闲的 22020–22099）
  --local-port N    本机反代端口（默认 3098，与 DSH 3080 区分）
  --dsh-home DIR    本机 DSH_HOME（默认 ~/dsh）
  --pack-dir DIR    guava pack 路径（默认 <DSH_HOME>/playground/themes/dsh-guava-pack）
  --vps IP          VPS 的 tailnet 地址（默认 100.109.125.37）
  --dry-run         只检查并打印，不落盘、不重启
  --no-start        写好配置但不启动服务
  -h, --help        本帮助
EOF
}

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --remote-port) REMOTE_PORT="${2:?缺端口}"; shift 2 ;;
    --local-port)  LOCAL_PORT="${2:?缺端口}"; shift 2 ;;
    --dsh-home)    DSH_HOME="${2:?缺路径}"; shift 2 ;;
    --pack-dir)    PACK_DIR="${2:?缺路径}"; shift 2 ;;
    --vps)         VPS_TS="${2:?缺地址}"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --no-start)    NO_START=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "未知参数: $1（-h 看用法）" ;;
  esac
done

# 默认从脚本自身位置反推 pack 目录（<pack>/ops/tunnel/join-relay.sh），
# 这样两台机器布局不同也不用传 --pack-dir：
#   第一台: <DSH_HOME>/playground/themes/dsh-guava-pack
#   第二台: 同样在 <DSH_HOME>/playground/themes/dsh-guava-pack（2026-11-12 起两台一致）
SELF_PACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACK_DIR="${PACK_DIR:-$SELF_PACK}"
if [ ! -f "$PACK_DIR/ops/dsh-remote-entry.mjs" ]; then
  # 兜底：老的固定布局
  PACK_DIR="$DSH_HOME/playground/themes/dsh-guava-pack"
fi
ENTRY_MJS="$PACK_DIR/ops/dsh-remote-entry.mjs"

SSH_OPTS=(-F /dev/null -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes)

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

# ---------- 1. 本机前置检查 ----------
say "本机检查"
case "$REMOTE_PORT" in ''|*[!0-9]*) : ;; *) [ "$REMOTE_PORT" -ge 1024 ] && [ "$REMOTE_PORT" -le 65535 ] || die "remote-port 越界: $REMOTE_PORT" ;; esac
case "$LOCAL_PORT" in *[!0-9]*) die "local-port 非法: $LOCAL_PORT" ;; esac

command -v node >/dev/null || die "没装 node（DSH 本身也需要）"
[ -f "$ENTRY_MJS" ] || die "找不到 $ENTRY_MJS —— 用 --pack-dir 指定 pack 路径"
command -v ssh >/dev/null || die "没装 ssh"
command -v curl >/dev/null || die "没装 curl"
command -v systemctl >/dev/null || die "没有 systemd（Windows 原生 DSH 不适用，需在 WSL2 里跑）"
command -v ss >/dev/null || die "没装 iproute2（ss 命令）"

dsh_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:3080/" 2>/dev/null || true)"
case "$dsh_code" in
  000|'') warn "127.0.0.1:3080 没有响应 —— DSH 没在跑？先启动 DSH 再执行本脚本" ;;
  *)      ok "DSH 在跑（根路径 HTTP $dsh_code，需要 token 属正常）" ;;
esac
[ -s "$DSH_HOME/logs/web-run.log" ] || warn "找不到 $DSH_HOME/logs/web-run.log，/go 将无法取 token"

if command -v tailscale >/dev/null; then
  tailscale status >/dev/null 2>&1 || die "tailscale 未登录 —— 先 tailscale up 并加入同一 tailnet"
  ok "tailscale CLI 正常"
else
  # WSL2 镜像网络模式下 tailscale 跑在 Windows 宿主机上，Linux 侧没有 CLI。
  if ip route get "$VPS_TS" >/dev/null 2>&1; then
    ok "无 tailscale CLI（WSL 镜像模式），$VPS_TS 有路由"
  else
    die "到 $VPS_TS 没有路由 —— Tailscale 没开 / 不在同一 tailnet"
  fi
fi
ok "node / ssh / curl 就绪"

if [ "$LOCAL_PORT" = "3080" ]; then die "local-port 不能是 3080（那是 DSH 自己）"; fi
if ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:${LOCAL_PORT}\b"; then
  lp_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${LOCAL_PORT}/go" || true)"
  case "$lp_code" in
    302|401|403) warn "127.0.0.1:${LOCAL_PORT} 已被占用（看着像已在跑的 dsh-remote-entry，将重启它）" ;;
    *)           die "127.0.0.1:${LOCAL_PORT} 被别的程序占用（HTTP $lp_code），换 --local-port" ;;
  esac
fi

# ---------- 2. 信任 VPS 主机键 ----------
say "校验 VPS 主机键"
if ssh-keygen -F "$VPS_TS" -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then
  ok "known_hosts 里已有 $VPS_TS"
else
  scan="$(ssh-keyscan -t ed25519 -p 22 "$VPS_TS" 2>/dev/null || true)"
  [ -n "$scan" ] || die "ssh-keyscan 拿不到 $VPS_TS 的主机键（tailnet 通吗？）"
  got="$(printf '%s\n' "$scan" | ssh-keygen -lf - | awk '{print $2}')"
  [ "$got" = "$VPS_FP" ] || die "主机指纹不匹配：期望 $VPS_FP，实际 $got —— 中止"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] 追加主机键到 ~/.ssh/known_hosts（指纹已校验）\n'
  else
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    printf '%s\n' "$scan" >> "$HOME/.ssh/known_hosts"
  fi
  ok "指纹 $got 匹配，已信任"
fi

# ---------- 3. SSH 免密 + 公钥指引 ----------
say "SSH 到 VPS"
if ssh "${SSH_OPTS[@]}" "root@$VPS_TS" true 2>/dev/null; then
  ok "免密登录正常"
else
  [ -f "$HOME/.ssh/id_ed25519.pub" ] || run ssh-keygen -t ed25519 -N '' -C "$(whoami)@$(hostname)-dsh-relay" -f "$HOME/.ssh/id_ed25519"
  cat <<EOF

  还没有这台机器的登录权限。把下面这行公钥加到 VPS 的 /root/.ssh/authorized_keys：

$(cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || echo '（dry-run：公钥将在非 dry-run 时生成）')

  方便的做法：在主力机（已能 SSH 上 VPS 的那台）执行

    ssh root@$VPS_TS 'echo "上面这行公钥" >> /root/.ssh/authorized_keys'

  然后回到本机重跑：bash join-relay.sh

EOF
  exit 1
fi
ok "公钥已在 VPS"

# ---------- 4. 选端口 ----------
say "分配 VPS 端口"
# 幂等：本机已有 tunnel.env 且命令行没指定端口时，沿用旧端口（重跑不会换入口）
if [ -z "$REMOTE_PORT" ] && [ -f "$DSH_HOME/tunnel.env" ]; then
  REMOTE_PORT="$(sed -n 's/^REMOTE_PORT=//p' "$DSH_HOME/tunnel.env" | tail -1)"
  if [ -n "$REMOTE_PORT" ]; then ok "沿用已有 tunnel.env 的端口 $REMOTE_PORT"; fi
  case "$REMOTE_PORT" in *[!0-9]*) die "tunnel.env 里的 REMOTE_PORT 非法: $REMOTE_PORT" ;; esac
fi

used="$(ssh "${SSH_OPTS[@]}" "root@$VPS_TS" "ss -ltnH | awk '{print \$4}'" 2>/dev/null || true)"
if [ -z "$REMOTE_PORT" ]; then
  for p in $(seq 22020 22099); do
    if ! grep -qE ":${p}$" <<<"$used"; then REMOTE_PORT="$p"; break; fi
  done
  [ -n "$REMOTE_PORT" ] || die "22020–22099 全被占用，手动 --remote-port"
  ok "自动选中 $REMOTE_PORT"
else
  if grep -qE ":${REMOTE_PORT}$" <<<"$used"; then
    warn "VPS 上 :$REMOTE_PORT 已被监听（若是本机旧的隧道，重启后会复用）"
  else
    ok "VPS 上 :$REMOTE_PORT 空闲"
  fi
fi

# ---------- 5. 写配置 ----------
say "写入配置"
TUNNEL_ENV="$DSH_HOME/tunnel.env"
if [ "$DRY_RUN" = 0 ]; then mkdir -p "$DSH_HOME" "$UNIT_DIR"; fi

if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] %s:\n' "$TUNNEL_ENV"
  printf '    VPS_PUBLIC_IP=%s\n    VPS_TAILNET_IP=%s\n    REMOTE_PORT=%s\n    LOCAL_PORT=%s\n' \
    "$VPS_TS" "$VPS_TS" "$REMOTE_PORT" "$LOCAL_PORT"
else
  umask 077
  cat > "$TUNNEL_ENV" <<EOF
# 本机 → VPS 反向隧道；REMOTE_PORT 每台 PC 必须不同（手机用 :\$REMOTE_PORT/go 区分）
VPS_PUBLIC_IP=$VPS_TS
VPS_TAILNET_IP=$VPS_TS
REMOTE_PORT=$REMOTE_PORT
LOCAL_PORT=$LOCAL_PORT
EOF
  chmod 600 "$TUNNEL_ENV"
  ok "$TUNNEL_ENV"
fi

write_unit() { # $1=路径  stdin=内容
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s:\n' "$1"
    sed 's/^/    /' >&2
  else
    cat > "$1"
    ok "$1"
  fi
}

write_unit "$UNIT_DIR/dsh-remote-entry.service" <<EOF
[Unit]
Description=DSH remote entry (relay reverse proxy, local ${LOCAL_PORT})
Documentation=file://${ENTRY_MJS}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${PACK_DIR}
Environment=DSH_HOME=${DSH_HOME}
Environment=DSH_REMOTE_PORT=${LOCAL_PORT}
# 只监听回环：外部只能经 SSH 隧道（VPS → 127.0.0.1）进入
Environment=DSH_REMOTE_BIND=127.0.0.1
ExecStart=/usr/bin/env node ${ENTRY_MJS}
Restart=always
RestartSec=3
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF

if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] %s:\n' "$UNIT_DIR/dsh-tunnel.service"
  sed 's/^/    /' >&2 <<'EOF'
[Unit]
# 把本机 127.0.0.1:${LOCAL_PORT}（dsh-remote-entry）反向上报到 VPS。
# 变量来自 tunnel.env（每台 PC 的 REMOTE_PORT 不同）。
Description=DSH reverse tunnel to relay
After=network-online.target dsh-remote-entry.service

[Service]
Type=simple
EnvironmentFile=@ENV_FILE@
# -F /dev/null：绕开系统 ssh_config 里坏属主的 include
ExecStart=/usr/bin/ssh -F /dev/null -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes \
  -R ${VPS_TAILNET_IP}:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT} \
  root@${VPS_PUBLIC_IP}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
else
  sed -e "s|@ENV_FILE@|${TUNNEL_ENV}|g" > "$UNIT_DIR/dsh-tunnel.service" <<'EOF'
[Unit]
# 把本机 127.0.0.1:${LOCAL_PORT}（dsh-remote-entry）反向上报到 VPS。
# 变量来自 tunnel.env（每台 PC 的 REMOTE_PORT 不同）。
Description=DSH reverse tunnel to relay
After=network-online.target dsh-remote-entry.service

[Service]
Type=simple
EnvironmentFile=@ENV_FILE@
# -F /dev/null：绕开系统 ssh_config 里坏属主的 include
ExecStart=/usr/bin/ssh -F /dev/null -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes \
  -R ${VPS_TAILNET_IP}:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT} \
  root@${VPS_PUBLIC_IP}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  ok "$UNIT_DIR/dsh-tunnel.service"
fi

# ---------- 6. 启动 ----------
if [ "$NO_START" = 1 ]; then
  say "已跳过启动（--no-start）"
else
  say "启动服务"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [ "$DRY_RUN" = 0 ]; then
    systemctl --user daemon-reload
    systemctl --user enable dsh-remote-entry.service dsh-tunnel.service >/dev/null 2>&1 || true
    systemctl --user restart dsh-remote-entry.service
    systemctl --user restart dsh-tunnel.service
    ok "已 enable + restart"
  else
    printf '  [dry-run] systemctl --user daemon-reload; enable --now dsh-remote-entry dsh-tunnel\n'
  fi
  if command -v loginctl >/dev/null && ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    warn "Linger 未开启：注销后隧道会停。建议 sudo loginctl enable-linger $USER"
  fi
fi

# ---------- 7. 验证 ----------
if [ "$DRY_RUN" = 1 ]; then
  printf '\n  [dry-run] 完成后入口应为: http://%s:%s/go\n' "$VPS_TS" "$REMOTE_PORT"
  exit 0
fi

if [ "$NO_START" = 1 ]; then
  printf '\n已写入配置但未启动。启动：systemctl --user daemon-reload && systemctl --user enable --now dsh-remote-entry dsh-tunnel\n入口：http://%s:%s/go\n' "$VPS_TS" "$REMOTE_PORT"
  exit 0
fi

say "验证"
sleep 2
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${LOCAL_PORT}/go" || true)"
case "$code" in
  302) ok "本机 /go → 302（token 正常）" ;;
  503) warn "本机 /go 返回 503：DSH 没打印 token，检查 ~/dsh/logs/web-run.log" ;;
  *)   warn "本机 /go 返回 ${code:-无响应}，检查 systemctl --user status dsh-remote-entry" ;;
esac

if ssh "${SSH_OPTS[@]}" "root@$VPS_TS" "ss -ltnH | awk '{print \$4}' | grep -q ':${REMOTE_PORT}\$'" 2>/dev/null; then
  ok "VPS :${REMOTE_PORT} 已监听（只绑 ${VPS_TS}）"
else
  warn "VPS 上还没看到 :${REMOTE_PORT}，等 5 秒重试：ssh root@$VPS_TS 'ss -ltn | grep ${REMOTE_PORT}'"
fi

printf '\n\033[1;32m完成。\033[0m手机/平板收藏（token 会自动跟随）：\n\n  http://%s:%s/go\n\n两台 DSH 是不同端口 = 不同 origin：登录态、localStorage、PWA 都各自独立，\n可以同时开两个标签页/两个主屏图标，互不干扰。\n' "$VPS_TS" "$REMOTE_PORT"
