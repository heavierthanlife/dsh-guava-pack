#!/bin/sh
# 打印当前 dsh web 的访问地址（本机 + 手机/平板经 tailscale serve）
# token 每次 dsh 重启都会变，所以用这个脚本取最新的。
set -u

LOG="${DSH_LOG:-$HOME/dsh/logs/web-run.log}"

# MagicDNS 名字：hostname + resolv.conf 里的 search 域
SUFFIX=$(sed -n 's/^search[[:space:]]*//p' /etc/resolv.conf 2>/dev/null | awk '{print $1; exit}')
HOST="$(hostname 2>/dev/null | tr 'A-Z' 'a-z')${SUFFIX:+.$SUFFIX}"

if [ ! -f "$LOG" ]; then
  echo "找不到日志 $LOG —— dsh web 是否在跑？" >&2
  exit 1
fi

TOK=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
if [ -z "$TOK" ]; then
  echo "日志里没有 token —— 先在另一个终端启动 dsh web" >&2
  exit 1
fi

PORT=$(grep -o 'http://127\.0\.0\.1:[0-9]\+' "$LOG" 2>/dev/null | tail -1 | sed 's|.*:||')
PORT="${PORT:-3080}"

echo "本机浏览器:   http://127.0.0.1:$PORT/?token=$TOK"
echo "手机/平板:    https://$HOST/?token=$TOK"
echo
echo "（token 每次 dsh 重启都会变；手机打开链接后会下发 30 天有效的 cookie，"
echo "  之后直接访问 https://$HOST/ 即可）"
