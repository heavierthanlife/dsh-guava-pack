#!/bin/sh
# 安装"手机 tailnet 全自动"的两块拼图（可重复执行，幂等）：
#
#   ① WSL 开机/登录自启：Windows 计划任务在用户登录时静默 `wsl.exe -d <发行版>`，
#      配合 systemd user linger，把 dsh.service 一起带起来 —— 不需要你手动开终端。
#   ② 固定入口：dsh-entry.service（127.0.0.1:3099）读 DSH 启动日志里的当前 token，
#      再由 `tailscale serve --set-path /go` 暴露成 https://<tailnet>/go。
#      手机只收藏这个地址，DSH 重启换 token 也不用重新复制链接。
#
# 用法：sh ops/install-tailnet-autostart.sh [--check]
#   --check  只打印将要做的事，不改任何东西
#
# 前提：本机已装 node、systemd user 服务可用、Windows 侧 Tailscale 在运行。
set -eu

BASEDIR=$(cd "$(dirname "$0")/.." && pwd)
DSH_HOME=${DSH_HOME:-$HOME/dsh}
UNIT_DIR="$HOME/.config/systemd/user"
ENTRY_UNIT="$UNIT_DIR/dsh-entry.service"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say() { printf '%s\n' "$*"; }
run() {
  if [ "$CHECK_ONLY" = 1 ]; then say "  [check] $*"; else "$@"; fi
}

# ── 1) 固定入口的 systemd user 服务 ─────────────────────────────────────
say "① 固定入口服务（127.0.0.1:3099，读 $DSH_HOME/logs/web-run.log）"
if [ "$CHECK_ONLY" = 1 ]; then
  say "  [check] 写 $ENTRY_UNIT（替换 @@PACK@@/@@DSH_HOME@@）"
  say "  [check] systemctl --user daemon-reload && enable --now dsh-entry.service"
else
  mkdir -p "$UNIT_DIR"
  sed -e "s|@@PACK@@|$BASEDIR|g" -e "s|@@DSH_HOME@@|$DSH_HOME|g" \
    "$BASEDIR/ops/dsh-entry.service" > "$ENTRY_UNIT"
  systemctl --user daemon-reload
  systemctl --user enable dsh-entry.service >/dev/null
  systemctl --user restart dsh-entry.service
  say "  ✓ systemctl --user status dsh-entry.service"
fi

# ── 2) tailscale serve：把 /go 指到固定入口（Windows 侧 Tailscale）───────
say ""
say "② tailscale serve 增加 /go 路径"
TS_WIN="/mnt/c/Program Files/Tailscale/tailscale.exe"
if [ -x "$TS_WIN" ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    say "  [check] \"$TS_WIN\" serve --bg --https=443 --set-path=/go http://127.0.0.1:3099"
  else
    if "$TS_WIN" serve --bg --https=443 --set-path=/go http://127.0.0.1:3099 >/dev/null 2>&1; then
      say "  ✓ serve 配置已加 /go（若失败请用管理员 PowerShell 执行同一命令）"
    else
      say "  ⚠️ tailscale serve 失败（多半需要管理员）。请在【管理员 PowerShell】执行："
      say "     \"$TS_WIN\" serve --bg --https=443 --set-path=/go http://127.0.0.1:3099"
    fi
  fi
else
  say "  ⚠️ 没找到 Windows Tailscale（$TS_WIN）—— 手机走 tailnet 的前提是 Windows 侧 Tailscale"
fi

# ── 3) Windows 登录时自动拉起 WSL（→ dsh.service 自动起）───────────────
#
# 两种方式，按"免管理员优先"：
#   a) Windows 计划任务（Register-ScheduledTask）—— **需要管理员**，失败就降级；
#   b) 启动文件夹里放一个隐藏窗口的 VBS —— 普通用户权限即可，登录时自动跑。
# 之所以要 `sleep infinity`：wsl.exe 的短命令退出后 WSL 可能被回收；留一个常驻
# 进程能保证 systemd（以及 linger 拉起的 dsh.service / dsh-entry.service）一直在。
say ""
say "③ Windows 登录时自动拉起 WSL（发行版自动探测）"
WSL_EXE="/mnt/c/Windows/System32/wsl.exe"
if [ -x "$WSL_EXE" ]; then
  DISTRO=$("$WSL_EXE" -l -q 2>/dev/null | tr -d '\0\r' | grep -vi docker | head -1)
  [ -n "$DISTRO" ] || DISTRO=Ubuntu
  say "  发行版=$DISTRO"

  PS='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  WSL_WIN='C:\\Windows\\System32\\wsl.exe'
  registered=0
  if [ -x "$PS" ] && [ "$CHECK_ONLY" != 1 ]; then
    WIN_TMP=$(WINPATH=$("$PS" -NoProfile -Command '$env:TEMP' 2>/dev/null | tr -d '\r'); \
              wslpath -u "$WINPATH" 2>/dev/null || printf '/mnt/c/Windows/Temp')
    mkdir -p "$WIN_TMP" 2>/dev/null || true
    PS1_PATH="$WIN_TMP/dsh-wsl-autostart.ps1"
    cat > "$PS1_PATH" <<EOF
\$ErrorActionPreference = 'Stop'
\$task = 'DSH Autostart (WSL)'
\$action = New-ScheduledTaskAction -Execute '$WSL_WIN' -Argument '-d $DISTRO --exec /bin/sh -c "sleep infinity"'
\$trigger = New-ScheduledTaskTrigger -AtLogOn
\$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
\$principal = New-ScheduledTaskPrincipal -UserId "\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName \$task -Action \$action -Trigger \$trigger -Settings \$settings -Principal \$principal -Force | Out-Null
EOF
    WIN_PS1=$(wslpath -w "$PS1_PATH")
    if "$PS" -NoProfile -ExecutionPolicy Bypass -File "$WIN_PS1" >"$WIN_TMP/.dsh-task.log" 2>&1; then
      say "  ✓ 已注册计划任务（管理员权限）"
      registered=1
    else
      say "  ℹ️  计划任务需要管理员，降级为启动文件夹方案（免管理员）"
    fi
  fi

  if [ "$registered" = 0 ] && [ "$CHECK_ONLY" != 1 ]; then
    STARTUP=$(WINPATH=$("$PS" -NoProfile -Command '[Environment]::GetFolderPath("Startup")' 2>/dev/null | tr -d '\r'); wslpath -u "$WINPATH" 2>/dev/null || true)
    if [ -n "$STARTUP" ] && [ -d "$STARTUP" ]; then
      VBS="$STARTUP/dsh-wsl-autostart.vbs"
      # WScript.Shell.Run 第二参 0 = 隐藏窗口；不阻塞登录。
      #
      # 必须写成 CRLF + UTF-16LE(BOM)：VBScript 解析器按 UTF-16 读取 .vbs，
      # 且不认 LF-only 换行 —— 纯 LF 时第 3 行会被并进上面那行注释里，
      # `Set sh = ...` 根本没执行，第 4 行 `sh.Run` 直接报
      # 「缺少对象: 'sh'（800A01A8）」。
      # 2026-11-12 在 Windows 上实测踩到（脚本生成的文件 CR=0、只有 4 个 LF）。
      # 用 printf 拼 CRLF 再 iconv 转 UTF-16LE，避免 heredoc 把换行/编码写坏。
      {
        printf "' 由 dsh-guava-pack/ops/install-tailnet-autostart.sh 生成：登录时静默拉起 WSL\r\n"
        printf "' （WSL 起来后 systemd user linger 会自动启动 dsh.service 与 dsh-entry.service）\r\n"
        printf 'Set sh = CreateObject("WScript.Shell")\r\n'
        printf 'sh.Run "%s -d %s --exec /bin/sh -c ""sleep infinity""", 0, False\r\n' "$WSL_WIN" "$DISTRO"
      } | iconv -f UTF-8 -t UTF-16LE > "$VBS.utf16.tmp" 2>/dev/null || {
        # 没有 iconv 就退回"UTF-8 + CRLF"（多数现代 Windows 也能跑，只是不保证中文注释）
        say "  ⚠️ 没有 iconv，改用 UTF-8 + CRLF 写入"
        {
          printf "' 由 dsh-guava-pack/ops/install-tailnet-autostart.sh 生成：登录时静默拉起 WSL\r\n"
          printf "' （WSL 起来后 systemd user linger 会自动启动 dsh.service 与 dsh-entry.service）\r\n"
          printf 'Set sh = CreateObject("WScript.Shell")\r\n'
          printf 'sh.Run "%s -d %s --exec /bin/sh -c ""sleep infinity""", 0, False\r\n' "$WSL_WIN" "$DISTRO"
        } > "$VBS.utf16.tmp"
      }
      # UTF-16LE 需要 BOM（FF FE），否则照样解析失败
      { printf '\377\376'; cat "$VBS.utf16.tmp"; } > "$VBS"
      rm -f "$VBS.utf16.tmp"
      # 自检：BOM 必须是 FF FE，且不能有裸 LF（否则 VBScript 报「缺少对象: 'sh'」）。
      vbs_bom=$(head -c 2 "$VBS" | od -An -tx1 | tr -d ' \n')
      vbs_bare_lf=$(python3 - "$VBS" <<'VPY'
import sys
d = open(sys.argv[1], 'rb').read()
print(d.count(b'\n\x00') - d.count(b'\r\x00\n\x00'))
VPY
)
      if [ "$vbs_bom" = "fffe" ] && [ "$vbs_bare_lf" = "0" ]; then
        say "  ✓ 已写入启动文件夹：$VBS（UTF-16LE + CRLF 自检通过，登录时隐藏运行，无需管理员）"
      else
        say "  ⚠️ VBS 自检不通过：BOM=$vbs_bom（应为 fffe）、裸 LF=$vbs_bare_lf（应为 0）"
        say "     该文件在 Windows 登录时会报「缺少对象: 'sh'（800A01A8）」"
      fi
    else
      say "  ⚠️ 找不到启动文件夹，跳过。手动把下列命令放进『启动』文件夹快捷方式："
      say "     $WSL_WIN -d $DISTRO --exec /bin/sh -c \"sleep infinity\""
    fi
  fi
else
  say "  ⚠️ 找不到 wsl.exe —— 跳过"
fi

say ""
say "完成。手机只需收藏： https://<你的 MagicDNS 名>/go"
say "验证：curl -s http://127.0.0.1:3099/health   # 应 {\"ok\":true}"
