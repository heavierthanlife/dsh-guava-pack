#!/usr/bin/env bash
# DSH Arcade 安装 / 升级脚本（幂等，可重复执行）
#
#   sudo bash install.sh
#
# 做的事：
#   1. 建系统用户 dsh-arcade（nologin、无家目录；服务以它运行，非 root）
#   2. 安装程序到 /opt/dsh-arcade/{server.mjs,public/}
#   3. 首次生成 /etc/dsh-arcade/token（600；已存在则绝不改动）
#   4. 写 systemd 单元 dsh-arcade.service 并 enable --now
#   5. 自检：单元 active、tailnet:8091 监听、无令牌访问返回 404
#
# 与 dsh-console 完全独立：不碰其中任何一个文件、不重启任何既有服务。

set -euo pipefail

APP_NAME="dsh-arcade"
APP_DIR="/opt/dsh-arcade"
ETC_DIR="/etc/dsh-arcade"
TOKEN_FILE="$ETC_DIR/token"
UNIT_FILE="/etc/systemd/system/dsh-arcade.service"
NODE_BIN="/usr/local/bin/node"
BIND_ADDR="100.109.125.37"
PORT="8091"
SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] 错误：%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "必须以 root 运行"
[ -x "$NODE_BIN" ] || die "找不到 Node：$NODE_BIN"
[ -f "$SRC_DIR/server.mjs" ] || die "缺少 $SRC_DIR/server.mjs"
[ -d "$SRC_DIR/public" ] || die "缺少 $SRC_DIR/public"
command -v openssl >/dev/null 2>&1 || die "需要 openssl 生成随机令牌"
command -v curl >/dev/null 2>&1 || die "需要 curl 做自检"

# 端口占用检查：撞端口时给明确报错，而不是让 systemd 反复重启
if ss -ltn 2>/dev/null | grep -Fq "${BIND_ADDR}:${PORT}"; then
  if ! systemctl is-active --quiet "$APP_NAME.service"; then
    die "端口 ${BIND_ADDR}:${PORT} 已被别的进程占用（不是本服务）"
  fi
fi

# ---------------------------------------------------------------- 1. 系统用户
if id -u "$APP_NAME" >/dev/null 2>&1; then
  log "系统用户 $APP_NAME 已存在，跳过"
else
  useradd --system --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin --comment "DSH Arcade" "$APP_NAME"
  log "已创建系统用户 $APP_NAME"
fi

# ---------------------------------------------------------------- 2. 程序文件
install -d -m 0755 -o root -g root "$APP_DIR"
install -m 0644 -o root -g root "$SRC_DIR/server.mjs" "$APP_DIR/server.mjs"
# public/ 用 install -d + 逐文件：不能 rm -rf，避免升级时误删以后手放进去的东西
install -d -m 0755 -o root -g root "$APP_DIR/public"
while IFS= read -r -d '' file; do
  rel="${file#"$SRC_DIR/public/"}"
  target="$APP_DIR/public/$rel"
  install -d -m 0755 -o root -g root "$(dirname "$target")"
  install -m 0644 -o root -g root "$file" "$target"
done < <(find "$SRC_DIR/public" -type f -print0)
PUBLIC_COUNT="$(find "$SRC_DIR/public" -type f | wc -l)"
log "程序已安装到 $APP_DIR（server.mjs + public/ 共 $PUBLIC_COUNT 个文件）"

# ---------------------------------------------------------------- 3. 路径令牌
install -d -m 0755 -o root -g root "$ETC_DIR"
if [ -s "$TOKEN_FILE" ]; then
  log "令牌文件已存在，保持不变：$TOKEN_FILE"
else
  OLD_UMASK="$(umask)"
  umask 077
  TMP_TOKEN="$(mktemp "$ETC_DIR/.token.XXXXXX")"
  # 32 位十六进制（128 bit）；只用 [0-9a-f]，URL 里不需要转义
  openssl rand -hex 16 > "$TMP_TOKEN"
  chown root:root "$TMP_TOKEN"
  chmod 0600 "$TMP_TOKEN"
  mv -f "$TMP_TOKEN" "$TOKEN_FILE"
  umask "$OLD_UMASK"
  log "已生成路径令牌：$TOKEN_FILE（600 root；本脚本不显示内容）"
fi
[ -s "$TOKEN_FILE" ] || die "令牌文件为空：$TOKEN_FILE"
chown root:root "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"

# ---------------------------------------------------------------- 4. systemd
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=DSH Arcade - tailnet mini-game pages (${BIND_ADDR}:${PORT})
Documentation=file:${APP_DIR}/README.md
After=network-online.target tailscaled.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
# 非 root：本服务只发静态文件，不需要任何特权。被攻破也拿不到
# restic/systemctl —— 这正是它不跟 dsh-console 合并的理由。
User=${APP_NAME}
Group=${APP_NAME}
ExecStart=${NODE_BIN} ${APP_DIR}/server.mjs
WorkingDirectory=${APP_DIR}
Environment=DSH_ARCADE_BIND=${BIND_ADDR}
Environment=DSH_ARCADE_PORT=${PORT}
Environment=DSH_ARCADE_ROOT=${APP_DIR}/public
# 1.6 GB 小机器：压小 V8 新生代，让常驻 RSS 停在 40 MB 上下
Environment=NODE_OPTIONS=--max-semi-space-size=2
Restart=always
RestartSec=3
TimeoutStopSec=10
# ---- 沙箱 ----
# 令牌文件是 600 root，而服务以 dsh-arcade 运行 —— 直接读会 EACCES。
# LoadCredential 让 systemd（root）读出来，再以只读 fd 交给服务进程
# （路径 %d/<name>，systemd 会自动 chown 到服务用户）。这是唯一正确的做法：
# 不能用 chmod 644/unreadable 或给服务加 RestrictFileSystems 规避。
LoadCredential=dsh-arcade-token:${TOKEN_FILE}
Environment=DSH_ARCADE_TOKEN_FILE=%d/dsh-arcade-token
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryMax=192M
UMask=0077
LimitNOFILE=4096
SyslogIdentifier=dsh-arcade

[Install]
WantedBy=multi-user.target
UNIT
chown root:root "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable "$APP_NAME.service" >/dev/null 2>&1
systemctl restart "$APP_NAME.service"
log "已 enable + restart $APP_NAME.service"

# ---------------------------------------------------------------- 5. 自检
# 未带令牌访问必须 404：如果这里返回 200，等于把页面公开给整个 tailnet。
LISTEN_OK=0
DENY_OK=0
for _ in $(seq 1 40); do
  sleep 0.5
  if ss -ltn 2>/dev/null | grep -Fq "${BIND_ADDR}:${PORT}"; then LISTEN_OK=1; fi
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://${BIND_ADDR}:${PORT}/" || true)"
  if [ "$CODE" = "404" ]; then DENY_OK=1; fi
  if [ "$LISTEN_OK" -eq 1 ] && [ "$DENY_OK" -eq 1 ]; then break; fi
done

if [ "$LISTEN_OK" -ne 1 ] || [ "$DENY_OK" -ne 1 ]; then
  echo "----- systemctl status -----" >&2
  systemctl status "$APP_NAME.service" --no-pager -l | tail -n 20 >&2 || true
  echo "----- journal (last 40) -----" >&2
  journalctl -u "$APP_NAME.service" --no-pager -n 40 >&2 || true
  die "自检失败：listen=${LISTEN_OK} deny404=${DENY_OK}"
fi

# 带令牌访问必须 200（否则"安装成功"其实是坏的）
TOKEN="$(cat "$TOKEN_FILE")"
PAGE_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://${BIND_ADDR}:${PORT}/${TOKEN}/" || true)"
if [ "$PAGE_CODE" != "200" ]; then
  journalctl -u "$APP_NAME.service" --no-pager -n 20 >&2 || true
  die "带令牌访问首页不是 200（实际 ${PAGE_CODE}）"
fi

if ! systemctl is-active --quiet "$APP_NAME.service"; then
  die "$APP_NAME.service 不是 active"
fi

# 路径穿越自检：**必须加 --path-as-is**。curl 默认会在发送前把 `..` 规范化，
# 不加这个参数就只是请求了 `/etc/passwd`，测不到服务端自己的防护。
PRESS_CODE="$(curl -s -o /dev/null --path-as-is -w '%{http_code}' --max-time 3 \
  "http://${BIND_ADDR}:${PORT}/../../etc/passwd" || true)"
if [ "$PRESS_CODE" = "200" ]; then
  die "路径穿越自检失败：/../../etc/passwd 返回了 200"
fi

echo
log "安装完成 ✅"
printf '  监听      : http://%s:%s （仅 tailnet）\n' "$BIND_ADDR" "$PORT"
printf '  访问方式  : 随机路径令牌（点一次记住，之后访问 / 也行）\n'
printf '  令牌文件  : %s（600 root）\n' "$TOKEN_FILE"
printf '  拿到链接  : sudo cat %s   → 打开 http://%s:%s/<令牌>/\n' "$TOKEN_FILE" "$BIND_ADDR" "$PORT"
printf '  服务状态  : systemctl status %s\n' "$APP_NAME"
printf '  日志      : journalctl -u %s -f\n' "$APP_NAME"
printf '  回滚      : systemctl disable --now %s && rm -f %s && rm -rf %s\n' \
  "$APP_NAME" "$UNIT_FILE" "$APP_DIR"
echo
