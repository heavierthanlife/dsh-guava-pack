#!/usr/bin/env bash
# 在**新机器**上把 dsh 装到与本机一致（幂等；sudo 步骤会先问）。
#   DSH_REPO_URL=git@github.com:<you>/<repo>.git ./bootstrap-machine.sh
set -uo pipefail
say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[warn] %s\033[0m\n' "$*"; }
ask_sudo() {  # ask_sudo <说明> <命令...>
  local desc="$1"; shift
  printf '\033[1m[sudo] %s\033[0m\n   想执行：%s\n   现在执行吗？[y/N] ' "$desc" "$*"
  read -r a </dev/tty || a=n
  case "$a" in y|Y) sudo "$@" ;; *) warn "跳过：$desc"; return 1 ;; esac
}

# ── WSL interop 探测：Windows 的 node/npm 透传进来时，它装的包 WSL 跑不了 ──
# 决定性判据：直接问 node 自己的可执行文件路径（Windows 的会返回 C:\...）
node_is_windows() {
  local exe; exe="$(node -p 'process.execPath' 2>/dev/null)" || return 1
  case "$exe" in [A-Za-z]:[\\/]*) return 0 ;; esac
  return 1
}
# 兜底启发式（node 跑不起来时用）：.exe/.cmd/.bat/.ps1 或 PE(MZ) 头
is_interop() {
  local p; p="$(command -v "$1" 2>/dev/null)" || return 1
  case "$p" in *.exe|*.cmd|*.bat|*.ps1) return 0 ;; esac
  head -c2 "$p" 2>/dev/null | grep -q 'MZ' && return 0
  return 1
}
npm_prefix_is_windows() { case "$("$NPM" prefix -g 2>/dev/null)" in [A-Za-z]:*) return 0 ;; *) return 1 ;; esac; }
# PATH 里可能有 Windows 的 npm 排在前面（WSL interop）-> 一律用 Linux node 旁边的那个
resolve_npm() {
  local nd; nd="$(command -v node 2>/dev/null)" || return 1
  if [ -x "${nd%/*}/npm" ]; then NPM="${nd%/*}/npm"; else NPM="npm"; fi
  case "$("$NPM" prefix -g 2>/dev/null)" in [A-Za-z]:*) return 1 ;; esac
  return 0
}
linux_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node_is_windows && return 1
  is_interop node && return 1
  local v maj; v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  maj="${v%%.*}"; [ "${maj:-0}" -ge 22 ] 2>/dev/null || return 1
  return 0
}

REPO_URL="${DSH_REPO_URL:-}"
TARGET="${DSH_HOME:-$HOME/dsh}"
KEYS="MIMO_API_KEY XIAOMI_TOKEN_PLAN_CN_API_KEY DEEPSEEK_API_KEY OPENCODE_GO_API_KEY COMMANDCODE_API_KEY ANTIGRAVITY_API_KEY AGENTROUTER_API_KEY"

# ── 1) WSL: systemd + 默认用户 ────────────────────────────────────────
if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  say "启用 WSL systemd"
  ask_sudo "写入 /etc/wsl.conf" tee /etc/wsl.conf < machine/wsl.conf.example >/dev/null
  warn "改 /etc/wsl.conf 后需要 wsl --shutdown 再进（在 Windows 里执行）"
fi
command -v systemctl >/dev/null && systemctl --user >/dev/null 2>&1 && say "systemd --user 可用 ✓" || warn "systemd --user 不可用（上面那步没生效？）"

# ── 2) Node / pnpm / CLI ─────────────────────────────────────────────
if linux_node_ok; then
  say "node $(node -v)（Linux 原生 ✓）  路径 $(command -v node)"
else
  warn "没有可用的 **Linux** Node >= 22.19"
  warn "  当前 node: $(command -v node 2>/dev/null || echo 无)  版本 $(node -v 2>/dev/null || echo -)"
  warn "  PATH 里的 npm: $(command -v npm 2>/dev/null || echo 无) → 前缀 $(npm prefix -g 2>/dev/null || echo -)"
  if is_interop node || npm_prefix_is_windows; then
    warn "  ↑ 检测到 WSL 透传了 Windows 的 node/npm —— 它们装的包 WSL 里跑不起来，必须装 Linux 版"
  fi
  ask_sudo "装 Linux Node 22 (NodeSource)" bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs'
  hash -r 2>/dev/null || true
  linux_node_ok || { warn "Linux Node 仍不可用，终止（先手动装好再重跑）"; exit 1; }
  say "node $(node -v)（Linux 原生 ✓）"
fi

if ! resolve_npm; then
  warn "PATH 里的 npm 是 Windows 的（前缀 $("$NPM" prefix -g 2>/dev/null)）—— WSL 里装不了包"
  warn "  Linux node: $(command -v node)；它旁边有 npm 吗？ $( [ -x "$(dirname "$(command -v node)")/npm" ] && echo 有 || echo '没有（需 sudo apt-get install -y npm，或用 corepack）' )"
  warn "  临时绕过：export PATH=\"$(dirname "$(command -v node)"):\$PATH\"（让 Linux npm 排前面）后重跑"
  exit 1
fi
say "npm: $NPM（$("$NPM" --version 2>/dev/null || echo '?')）"
case "$(command -v npm)" in
  "$NPM") ;; *) warn "注意：PATH 里 'npm' 实际指向 $(command -v npm)，已自动改用 Linux 那份" ;;
esac
# ── 全局包安装：每次都用「真能跑起来」验证，且逐级降级 ───────────────
pnpm_ok() { command -v pnpm >/dev/null 2>&1 && pnpm -v >/dev/null 2>&1; }
export_local_bins() {
  mkdir -p "$HOME/.local/bin" "$HOME/.npm-global/bin" 2>/dev/null
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
  case ":$PATH:" in *":$HOME/.npm-global/bin:"*) ;; *) export PATH="$HOME/.npm-global/bin:$PATH" ;; esac
  hash -r 2>/dev/null || true
}

# ② npm 用户前缀（必须是「改完真的可写」，否则放弃这条路）
npm_user_prefix_ok() {
  local pfx; pfx="$("$NPM" prefix -g 2>/dev/null)" || return 1
  if [ ! -w "$pfx" ] 2>/dev/null; then
    mkdir -p "$HOME/.npm-global"
    "$NPM" config set prefix "$HOME/.npm-global" >/dev/null 2>&1 || true
    pfx="$("$NPM" prefix -g 2>/dev/null)"
    [ -w "$pfx" ] 2>/dev/null || { warn "npm 前缀改为用户目录没生效（仍是 $pfx）"; return 1; }
    say "npm 全局前缀 → $pfx"
  fi
  return 0
}

# corepack 的 shim 在 Node 22 上跑 `pnpm install` 会崩
# （ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING），且会盖住真 pnpm -> 直接清掉
drop_corepack_shims() {
  local f t
  mkdir -p "$HOME/.local/bin" 2>/dev/null
  for f in "$HOME/.local/bin/pnpm" "$HOME/.local/bin/pnpx"; do
    [ -e "$f" ] || continue
    t="$(readlink -f "$f" 2>/dev/null || echo "$f")"
    case "$t" in *corepack*) rm -f "$f" && say "移除不兼容的 corepack shim: $f" ;; esac
  done
  hash -r 2>/dev/null || true
}
prefer_real_pnpm() {   # pnpm 仍指向 corepack shim 但存在真 pnpm -> 把真 pnpm 的目录提前
  local cur; cur="$(readlink -f "$(command -v pnpm 2>/dev/null)" 2>/dev/null)"
  case "$cur" in *corepack*) ;;
    *) return 0 ;;
  esac
  local cand
  for cand in /usr/local/bin /usr/bin "$HOME/.npm-global/bin"; do
    if [ -x "$cand/pnpm" ] && ! readlink -f "$cand/pnpm" 2>/dev/null | grep -q corepack; then
      case ":$PATH:" in *":$cand:"*) ;; *) PATH="$cand:$PATH" ;; esac
      export PATH; hash -r 2>/dev/null || true; return 0
    fi
  done
  return 0
}
drop_corepack_shims
prefer_real_pnpm
if ! pnpm_ok; then
  if npm_prefix_is_windows; then
    warn "npm 全局前缀是 Windows 路径（$("$NPM" prefix -g)）—— 装出来 WSL 用不了"; exit 1
  fi
  if npm_user_prefix_ok; then
    say "装 pnpm@11（$NPM -g）"; "$NPM" i -g pnpm@11 >/dev/null 2>&1 || true
    export_local_bins
  fi
fi
if ! pnpm_ok; then                       # ③ 兜底：系统级安装（一条 sudo）
  warn "前两档都没成功，改用系统级安装"
  ask_sudo "全局装 pnpm@11（写 /usr/local）" "$NPM" i -g pnpm@11 && export_local_bins
fi
if ! pnpm_ok; then
  warn "pnpm 仍不可用 —— 手工跑： sudo $NPM i -g pnpm@11   然后重跑本脚本"; exit 1
fi
say "pnpm $(pnpm -v) / node $(node -v)"

# npm 全局 bin 写进 .bashrc（非交互脚本里 npm 的 bin 常常不在 PATH）
if npm_user_prefix_ok 2>/dev/null; then
  NPM_BIN="$("$NPM" prefix -g 2>/dev/null)/bin"
  if [ -n "$NPM_BIN" ] && [ -d "$NPM_BIN" ] && ! grep -q "dsh bootstrap: npm 全局 bin" "$HOME/.bashrc" 2>/dev/null; then
    printf '\nexport PATH="%s:$PATH"   # dsh bootstrap: npm 全局 bin\n' "$NPM_BIN" >> "$HOME/.bashrc"
    say "已把 $NPM_BIN 写进 ~/.bashrc"
  fi
fi

# command-code CLI（commandcode 桥要用）—— 同样的降级逻辑
if ! command -v command-code >/dev/null 2>&1; then
  say "装 command-code CLI"
  if npm_user_prefix_ok 2>/dev/null; then
    "$NPM" i -g command-code >/dev/null 2>&1 || ask_sudo "全局装 command-code" "$NPM" i -g command-code
  else
    ask_sudo "全局装 command-code" "$NPM" i -g command-code
  fi
  export_local_bins
fi

# ── 3) 仓库 ─────────────────────────────────────────────────────────
if [ -d "$TARGET/.git" ]; then
  say "仓库已存在：$TARGET"; git -C "$TARGET" pull --rebase --autostash
else
  [ -n "$REPO_URL" ] || { warn "请设 DSH_REPO_URL=<GitHub 私仓地址>"; exit 1; }
  say "clone $REPO_URL → $TARGET"; git clone "$REPO_URL" "$TARGET"
fi
cd "$TARGET" || exit 1
say "submodule update --init --recursive（赛博主题是独立仓库）"
git submodule update --init --recursive

# ── 3b) 用户名不同：profile 里是 link:/home/<user>/dsh/... 绝对路径 ──
if [ "$HOME" != "/home/guava5tar_" ]; then
  say "重写绝对路径 /home/guava5tar_ → $HOME（profiles/*/package.json 等）"
  sed -i "s#/home/guava5tar_#$HOME#g" profiles/*/package.json profiles/*/pnpm-lock.yaml restart-dsh.sh systemd/dsh.service 2>/dev/null
  warn "这会让本机工作区变脏；dsh-sync 会因此拒绝 pull —— 建议两台机器用同一个 Linux 用户名"
fi

# ── 4) 依赖 ─────────────────────────────────────────────────────────
pnpm_install_guard() {   # corepack shim 的典型崩法：能过 -v，过不了真活
  warn "pnpm 执行失败。若报 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING → 那是 corepack shim（与 Node 22 不兼容）："
  warn "  rm -f ~/.local/bin/pnpm ~/.local/bin/pnpx && hash -r && which pnpm   # 应变成 /usr/local/bin/pnpm"
  exit 1
}
say "pnpm install（root）"; pnpm install || pnpm_install_guard
[ -d profiles/web ] && { say "pnpm install（profiles/web）"; (cd profiles/web && pnpm install) || pnpm_install_guard; }

# ── 5) provider keys（不放进仓库）────────────────────────────────────
missing=""
for k in $KEYS; do grep -qE "^export $k=.+" "$HOME/.bashrc" 2>/dev/null || missing="$missing $k"; done
if [ -n "$missing" ]; then
  warn "~/.bashrc 缺少这些 key（需要你手填）：$missing"
  printf '   模板：%s\n' "$TARGET/machine/bashrc.dsh.example"
  printf '   追加：cat %s >> ~/.bashrc  # 然后填值\n' "$TARGET/machine/bashrc.dsh.example"
else
  say "~/.bashrc 里 7 把 key 齐了 ✓"
fi

# ── 6) systemd 服务 + linger ─────────────────────────────────────────
mkdir -p ~/.config/systemd/user
cp systemd/dsh.service ~/.config/systemd/user/dsh.service
sed -i "s#/home/guava5tar_#$HOME#g" ~/.config/systemd/user/dsh.service   # 用户名不同也能用
systemctl --user daemon-reload
systemctl --user enable --now dsh.service
say "dsh.service: $(systemctl --user is-active dsh.service)"
[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ] || ask_sudo "开启 linger（WSL 一启动就自起）" loginctl enable-linger "$USER"

# ── 7) 自检 ─────────────────────────────────────────────────────────
sleep 3
say "自检"
printf '   dsh --version : %s\n' "$(./dsh --version 2>&1 | tail -1)"
printf '   端口          : %s\n' "$(ss -tln 2>/dev/null | grep -cE ':3080|:8317|:8318') / 3"
printf '   启动错误      : %s\n' "$(grep -icE 'did not activate|startup failed' logs/web-run.log 2>/dev/null)"
./tailnet-url.sh 2>/dev/null | sed 's/^/   /' | head -6
