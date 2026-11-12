#!/usr/bin/env bash
# 在某一台 PC 上安装 dsh-pc-health（每 15 分钟自检 + 推 Kuma）。
#
# 用法：
#   bash ops/pc-health/install.sh --token <本机专属令牌> [--remote-port 22023]
#   bash ops/pc-health/install.sh --dry-run
#
# 令牌从哪来（在 VPS 上，root）：
#   grep -E 'KUMA_PUSH_PC' /etc/kuma/push-tokens.env
#   # 主力机(22022) 用 KUMA_PUSH_PC_MAIN，第二台(22023) 用 KUMA_PUSH_PC_MSI
#
# 幂等：重复执行只会覆盖 env 与两个 unit，然后重启 timer。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACK="$(cd "$HERE/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/dsh"
ENV_FILE="$ENV_DIR/pc-health.env"

VPS="${VPS:-100.109.125.37}"
KUMA_URL="${KUMA_URL:-http://$VPS:3001}"
REMOTE_PORT="${REMOTE_PORT:-}"
TOKEN=""
DRY=0

die() { echo "✗ $*" >&2; exit 1; }
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:?缺令牌}"; shift 2 ;;
    --remote-port) REMOTE_PORT="${2:?端口}"; shift 2 ;;
    --vps) VPS="${2:?IP}"; shift 2 ;;
    --kuma-url) KUMA_URL="${2:?URL}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[ -n "$TOKEN" ] || die "必须给 --token（从 VPS 的 /etc/kuma/push-tokens.env 取，见脚本头）"
[ -n "$REMOTE_PORT" ] || {
  # 从 ~/dsh/tunnel.env 猜
  if [ -r "$HOME/dsh/tunnel.env" ]; then
    REMOTE_PORT="$(sed -n 's/^REMOTE_PORT=//p' "$HOME/dsh/tunnel.env" | tail -1)"
  fi
}
[ -n "$REMOTE_PORT" ] || die "没给 --remote-port，且 ~/dsh/tunnel.env 里没有 REMOTE_PORT"

say "配置"
echo "  pack        : $PACK"
echo "  VPS         : $VPS"
echo "  Kuma        : $KUMA_URL"
echo "  REMOTE_PORT : $REMOTE_PORT"
echo "  令牌         : ${TOKEN:0:6}…（已隐藏）"

if [ "$DRY" = 1 ]; then
  echo "  [dry-run] 将写 $ENV_FILE 与 $UNIT_DIR/dsh-pc-health.{service,timer}"
  exit 0
fi

mkdir -p "$ENV_DIR" "$UNIT_DIR"
umask 077
cat > "$ENV_FILE" <<EOF
# 由 ops/pc-health/install.sh 生成；含 Kuma push 令牌，600。
KUMA_URL=$KUMA_URL
KUMA_PUSH_TOKEN=$TOKEN
VPS=$VPS
REMOTE_PORT=$REMOTE_PORT
EOF
chmod 600 "$ENV_FILE"
echo "  ✓ $ENV_FILE"

sed -e "s#^ExecStart=.*#ExecStart=$HERE/dsh-pc-health.sh#" \
    "$HERE/dsh-pc-health.service" > "$UNIT_DIR/dsh-pc-health.service"
cp "$HERE/dsh-pc-health.timer" "$UNIT_DIR/dsh-pc-health.timer"
echo "  ✓ $UNIT_DIR/dsh-pc-health.service"
echo "  ✓ $UNIT_DIR/dsh-pc-health.timer"

say "启用"
systemctl --user daemon-reload
systemctl --user enable --now dsh-pc-health.timer
echo "  ✓ dsh-pc-health.timer: $(systemctl --user is-active dsh-pc-health.timer)"

say "立即自检一次"
"$HERE/dsh-pc-health.sh" || true

echo
echo "完成。手机通知里这条监控叫「PC 健康 (…:${REMOTE_PORT})」。"
