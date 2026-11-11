#!/usr/bin/env bash
# DSH Console 安装 / 升级脚本（幂等，可重复执行）
#
#   sudo bash install.sh
#
# 做的事：
#   1. 建系统用户 dsh-console（服务本身以 root 运行，见 README 说明）
#   2. 安装 /opt/dsh-console/{server.mjs,index.html,README.md}
#   3. 首次生成 /etc/dsh-console/password（600 root；已存在则绝不改动）
#   4. 建 restic 读快照用的独立缓存目录 /var/cache/dsh-console/restic
#   5. 写 systemd 单元 dsh-console.service 并 enable --now
#   6. 本机自检：单元 active、tailnet:8090 在监听、未认证返回 401
#
# 不碰任何既有服务、不重启 DSH、不写仓库目录。

set -euo pipefail

APP_NAME="dsh-console"
APP_DIR="/opt/dsh-console"
ETC_DIR="/etc/dsh-console"
PASSWORD_FILE="$ETC_DIR/password"
UNIT_FILE="/etc/systemd/system/dsh-console.service"
NODE_BIN="/usr/local/bin/node"
BIND_ADDR="100.109.125.37"
PORT="8090"
CACHE_DIR="/var/cache/dsh-console/restic"
SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] 错误：%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "必须以 root 运行"
[ -x "$NODE_BIN" ] || die "找不到 Node：$NODE_BIN"
[ -f "$SRC_DIR/server.mjs" ] || die "缺少 $SRC_DIR/server.mjs"
[ -f "$SRC_DIR/index.html" ] || die "缺少 $SRC_DIR/index.html"
command -v openssl >/dev/null 2>&1 || die "需要 openssl 生成随机口令"
command -v curl >/dev/null 2>&1 || die "需要 curl 做自检"
id -u restic >/dev/null 2>&1 || die "系统用户 restic 不存在（restic 仓库属主），请先确认环境"

# ---------------------------------------------------------------- 1. 系统用户
if id -u "$APP_NAME" >/dev/null 2>&1; then
  log "系统用户 $APP_NAME 已存在，跳过"
else
  useradd --system --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin --comment "DSH Console" "$APP_NAME"
  log "已创建系统用户 $APP_NAME"
fi

# ---------------------------------------------------------------- 2. 程序文件
install -d -m 0755 -o root -g root "$APP_DIR"
install -m 0644 -o root -g root "$SRC_DIR/server.mjs" "$APP_DIR/server.mjs"
install -m 0644 -o root -g root "$SRC_DIR/index.html" "$APP_DIR/index.html"
if [ -f "$SRC_DIR/README.md" ]; then
  install -m 0644 -o root -g root "$SRC_DIR/README.md" "$APP_DIR/README.md"
fi
log "程序已安装到 $APP_DIR（server.mjs + index.html）"

# ---------------------------------------------------------------- 3. 口令文件
install -d -m 0750 -o root -g root "$ETC_DIR"
if [ -s "$PASSWORD_FILE" ]; then
  log "口令文件已存在，保持不变：$PASSWORD_FILE"
else
  OLD_UMASK="$(umask)"
  umask 077
  TMP_PASS="$(mktemp "$ETC_DIR/.password.XXXXXX")"
  # 32 个十六进制字符（128 bit），只含 0-9a-f，手机输入友好
  openssl rand -hex 16 > "$TMP_PASS"
  chown root:root "$TMP_PASS"
  chmod 0600 "$TMP_PASS"
  mv -f "$TMP_PASS" "$PASSWORD_FILE"
  umask "$OLD_UMASK"
  log "已生成新口令：$PASSWORD_FILE（600 root；本脚本不显示内容）"
fi
[ -s "$PASSWORD_FILE" ] || die "口令文件为空：$PASSWORD_FILE"
chown root:root "$PASSWORD_FILE"
chmod 0600 "$PASSWORD_FILE"

# 一次性登录令牌（可选，但强烈建议）：一次点开 `/?k=<token>` 就种 cookie，
# 手机/平板不用再手打 Basic 口令。文件不存在时 server 会自动禁用该入口。
TOKEN_FILE="$ETC_DIR/token"
if [ -s "$TOKEN_FILE" ]; then
  log "令牌文件已存在，保持不变：$TOKEN_FILE"
else
  OLD_UMASK="$(umask)"
  umask 077
  TMP_TOKEN="$(mktemp "$ETC_DIR/.token.XXXXXX")"
  openssl rand -hex 16 > "$TMP_TOKEN"
  chown root:root "$TMP_TOKEN"
  chmod 0600 "$TMP_TOKEN"
  mv -f "$TMP_TOKEN" "$TOKEN_FILE"
  umask "$OLD_UMASK"
  log "已生成登录令牌：$TOKEN_FILE（600 root；本脚本不显示内容）"
fi
chown root:root "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"

# ---------------------------------------------------------------- 4. restic 缓存
# 只给控制台读快照用，独立于既有的 /var/cache/restic，
# 避免改变 restic-prune / restic-check 的既有行为。
install -d -m 0750 -o root -g restic /var/cache/dsh-console
install -d -m 0750 -o restic -g restic "$CACHE_DIR"
log "restic 只读缓存目录：$CACHE_DIR"

# ---------------------------------------------------------------- 5. systemd
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=DSH Console - unified tailnet entry (${BIND_ADDR}:${PORT})
Documentation=file:${APP_DIR}/README.md
After=network-online.target tailscaled.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
# 以 root 运行：需要 systemctl start oneshot 与 runuser -u restic。
# 没有 sudo / shell 暴露；动作硬编码，见 README「为什么是 root」。
User=root
Group=root
ExecStart=${NODE_BIN} ${APP_DIR}/server.mjs
WorkingDirectory=${APP_DIR}
Environment=DSH_CONSOLE_BIND=${BIND_ADDR}
Environment=DSH_CONSOLE_PORT=${PORT}
Environment=DSH_CONSOLE_PASSWORD_FILE=${PASSWORD_FILE}
# 1.6 GB 小机器：压小 V8 新生代，降低常驻 RSS（预算 60 MB）
Environment=NODE_OPTIONS=--max-semi-space-size=2
Restart=always
RestartSec=3
TimeoutStopSec=10
# ---- 沙箱 ----
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=/var/cache/dsh-console
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
LockPersonality=yes
UMask=0077
LimitNOFILE=4096
SyslogIdentifier=dsh-console

[Install]
WantedBy=multi-user.target
UNIT
chown root:root "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable "$APP_NAME.service" >/dev/null 2>&1
systemctl restart "$APP_NAME.service"
log "已 enable + restart $APP_NAME.service"

# ---------------------------------------------------------------- 6. 自检
LISTEN_OK=0
AUTH_OK=0
for _ in $(seq 1 40); do
  sleep 0.5
  if ss -ltn 2>/dev/null | grep -Fq "${BIND_ADDR}:${PORT}"; then LISTEN_OK=1; fi
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://${BIND_ADDR}:${PORT}/" || true)"
  if [ "$CODE" = "401" ]; then AUTH_OK=1; fi
  if [ "$LISTEN_OK" -eq 1 ] && [ "$AUTH_OK" -eq 1 ]; then break; fi
done

if [ "$LISTEN_OK" -ne 1 ] || [ "$AUTH_OK" -ne 1 ]; then
  echo "----- systemctl status -----" >&2
  systemctl status "$APP_NAME.service" --no-pager -l | tail -n 20 >&2 || true
  echo "----- journal (last 40) -----" >&2
  journalctl -u "$APP_NAME.service" --no-pager -n 40 >&2 || true
  die "自检失败：listen=${LISTEN_OK} auth401=${AUTH_OK}"
fi

if ! systemctl is-active --quiet "$APP_NAME.service"; then
  die "$APP_NAME.service 不是 active"
fi

echo
log "安装完成 ✅"
printf '  监听        : http://%s:%s （仅 tailnet）\n' "$BIND_ADDR" "$PORT"
printf '  认证        : HTTP Basic，用户名 dsh\n'
printf '  口令文件    : %s（600 root）\n' "$PASSWORD_FILE"
printf '  查看口令    : sudo cat %s\n' "$PASSWORD_FILE"
printf '  一键登录    : cat %s，然后打开 http://%s:%s/?k=<令牌>\n' "$TOKEN_FILE" "$BIND_ADDR" "$PORT"
printf '  服务状态    : systemctl status %s\n' "$APP_NAME"
printf '  日志        : journalctl -u %s -f\n' "$APP_NAME"
printf '  回滚        : systemctl disable --now %s && rm -f %s && rm -rf %s\n' \
  "$APP_NAME" "$UNIT_FILE" "$APP_DIR"
echo
