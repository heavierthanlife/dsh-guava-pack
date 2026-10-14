#!/bin/sh
# restart-dsh.sh — 重启 DSH。
#
# DSH 现在是一个 systemd 用户服务（~/.config/systemd/user/dsh.service），
# 所以正确的重启方式就是交给 systemd：
#     systemctl --user restart dsh.service
# 不需要任何「脱离调用会话」的技巧 —— systemd 自己就是发起者。
#
# 注意「野生实例」：在服务出现之前手动起的 DSH 不被 systemd 管理，却占着
# 3080，服务会因端口被占而起不来。所以这里先停服务、再清野生实例、最后启动。
#
# 用法：
#   ~/dsh/restart-dsh.sh
#   systemctl --user status dsh.service      # 看状态
#   journalctl --user -u dsh.service -f      # 看日志

SERVICE=dsh.service
# 目标 DSH 安装目录：与 bootstrap-machine.sh 同一套约定（DSH_HOME > ~/dsh）。
DSH_HOME="${DSH_HOME:-$HOME/dsh}"

if systemctl --user is-enabled "$SERVICE" >/dev/null 2>&1; then
  echo "[restart] 停止服务"
  systemctl --user stop "$SERVICE" 2>/dev/null
  echo "[restart] 清理不受 systemd 管理的野生 dsh 实例（否则占着 3080）"
  pkill -f "@deepseek-ai/dsh/lib/bin.js web" 2>/dev/null
  sleep 3
  echo "[restart] 启动服务"
  exec systemctl --user start "$SERVICE"
fi

# ── 回退：没有服务时，用 systemd 瞬时单元自举 ──────────────────────
# 直接从 shell 跑会随 DSH 死亡被一起带走 —— 那正是早先 18:40 / 18:46 / 20:27
# 三次「只杀不起」的原因。
if [ "${DSH_RESTART_IN_UNIT:-}" != "1" ]; then
  exec systemd-run --user --collect \
    --setenv=DSH_RESTART_IN_UNIT=1 \
    --setenv="DSH_HOME=$DSH_HOME" \
    --setenv="DSH_RESTART_DELAY=${DSH_RESTART_DELAY:-5}" \
    "$DSH_HOME/restart-dsh.sh"
fi

LOG="$DSH_HOME/logs/restart.log"
mkdir -p "$DSH_HOME/logs" 2>/dev/null

sleep "${DSH_RESTART_DELAY:-5}"

echo "[restart] $(date '+%F %T') 停止 dsh web" >> "$LOG"
pkill -f "@deepseek-ai/dsh/lib/bin.js web" 2>/dev/null
sleep 3

echo "[restart] $(date '+%F %T') 启动 dsh web（启动器会先拉起 commandcode 桥接 + provider-router）" >> "$LOG"
cd "$DSH_HOME" || exit 1
exec ./dsh web --no-open >> "$DSH_HOME/logs/web-run.log" 2>&1
