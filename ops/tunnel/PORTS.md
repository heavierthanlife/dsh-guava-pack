# VPS 端口表与凭据位置（2026-11-11）

> 原则：**除了 WireGuard（UDP 41641），其余一律只绑 tailnet 地址**（`100.109.125.37`），
> 公网扫描不到。新增服务前先看这张表，别撞端口、别绑 `0.0.0.0`。

## 端口

| 端口 | 协议 | 绑定 | 服务 | 用途 | 备注 |
|---|---|---|---|---|---|
| 41641 | UDP | `0.0.0.0` | tailscaled | WireGuard 直连 | **安全组必须放行**，否则退回东京 DERP |
| 22 | TCP | `0.0.0.0:22` | sshd | 管理 / PC 反向隧道 | iptables `DSH_SSH_TAILNET` 只放行 `tailscale0`、`lo`、`100.104.0.0/16`，其余 DROP |
| 22022 | TCP | tailnet | sshd（反向隧道） | 公司 ThinkPad T14p（YGY12）的 DSH → `127.0.0.1:3098` | `GatewayPorts clientspecified`，公网不可见 |
| 22023 | TCP | tailnet | sshd（反向隧道） | 家里 GE75（MSI）的 DSH | 两台对等；端口约定见 `ops/tunnel/` |
| 3000 | TCP | tailnet | rest-server | restic 仓库（HTTP，**append-only** + basic auth） | 仓库路径 `/srv/backup/dsh`，客户端只能追加 |
| 3001 | TCP | tailnet | uptime-kuma | 监控面板 + push 接收端 | `http://100.109.125.37:3001` |
| 8080 | TCP | tailnet | ntfy | 手机推送 | topic 在 `/etc/ntfy/topic` |
| 8090 | TCP | tailnet | dsh-console | **统一图形入口**（状态+动作+各服务跳转） | basic auth，用户名 `dsh` |
| 8081 | TCP | tailnet | miniserve | 手机↔PC 文件中转（可上传/删除/建目录） | **随机路径前缀当令牌**（Basic 在手机上会被键盘输入搞挂），目录 `/srv/exchange` |

## 凭据 / 密钥位置（都不进 git）

| 文件 | 权限 | 内容 | 谁用 |
|---|---|---|---|
| `/etc/rest-server/password` | 600 root | rest-server 的 basic auth 口令 | 仅 PC 初始化用（已存 `~/.restic-repo-url`） |
| `~/.restic-repo-url`（PC） | 600 | `rest:http://restic:…@100.109.125.37:3000/dsh/` | `restic-backup.sh` / `restic-ctl.sh` |
| `~/.restic-pass`（PC） | 600 | 仓库加密口令（丢了数据就没了） | restic |
| `/etc/restic/repo-password` | 640 root:restic | 同一把仓库口令（VPS 侧 prune/check 用） | `restic-prune` / `restic-check` / janitor |
| `/etc/miniserve/env` | 600 root | `PREFIX=` 令牌路径（访问 `http://100.109.125.37:8081/<PREFIX>/`） | 手机/平板直接点链接，无需输入 |
| `/etc/dsh-console/password` | 600 root | 控制台口令（用户名 `dsh`） | 手机/平板打开 `http://100.109.125.37:8090` |
| `/etc/dsh-console/token` | 600 root | 一键登录令牌（`/?k=<token>`，种 30 天 cookie） | 手机点链接即用，不用手打口令 |
| `/etc/ntfy/topic` | 640 root:ntfy | 推送 topic（等同访问令牌） | 手机 ntfy App 订阅 |
| `/etc/kuma/push-tokens.env` | 600 root | Kuma push 监控令牌 | `dsh-health-push.sh` / `dsh-backup-freshness-push.sh` |
| `/root/.ssh/gitmirror_ed25519` | 600 root | Deploy key（仅当以后要 VPS 直连私有仓库时用） | 当前未启用（镜像由 PC 推送） |

## PC 浏览器访问不到 100.x 时

Windows 侧若被公司 VPN/代理接管了路由，浏览器打不开 `http://100.109.125.37:8090` 是正常的
（请求根本没到 VPS）。两个办法：

1. 在 Windows 上 `Test-NetConnection 100.109.125.37 -Port 8090`；失败就是路由/代理问题，
   检查 Tailscale 是否 connected、`netsh winhttp show proxy`、浏览器代理设置；
2. **兜底（已在本机装好）**：WSL 里 `systemctl --user enable --now console-forward.service`
   （单元见 [`console-forward.service`](console-forward.service)），Windows 打开
   `http://localhost:8090` —— 走 WSL→VPS 的 22 端口转发，不经过浏览器代理。

## 定时任务（VPS）

| 时间 | 单元 | 做什么 |
|---|---|---|
| 每 30 分钟 | `dsh-health-push.timer` | 磁盘/内存/锁/服务/git 镜像新鲜度 → Kuma |
| 00/06/12/18:20 | `dsh-backup-freshness.timer` | restic 最新快照 >26h → 报警 |
| 每日 03:00 | `restic-lock-janitor.timer` | 清理 >30 分钟的陈旧锁（早于 PC 03:30 备份） |
| 每月 1 日 04:30 | `restic-prune.timer` | 仓库 prune（append-only 下只能在 VPS 做） |
| 每周日 05:00 | `restic-check.timer` | `restic check --read-data-subset=2%` |

PC 侧（`systemctl --user`）：

| 时间 | 单元 | 做什么 |
|---|---|---|
| 每日 03:30 | `dsh-backup.timer` | restic 备份；成功后顺带 `git-mirror-push.sh` |
