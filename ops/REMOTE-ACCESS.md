# 远程访问 DSH（Tailscale / 公司 VPN）

DSH 本体始终只监听 `127.0.0.1:3080`，外部入口都是**反代**。

## 现状（2026-11-05 收敛）

**只保留路径三（自建 tailnet 中继）**，其余两条已下线：

| 路径 | 状态 | 入口 |
|---|---|---|
| 三、自建中继（VPS） | ✅ **唯一在用** | `http://100.109.125.37:22022/go` |
| 一、Tailscale 直连 | ❌ 已停（抖动大） | `dsh-entry.service` 已 disable |
| 二、公司 VPN | ❌ 已停（避免公司侧意见） | 防火墙规则 `DSH over VPN` 已删除 |

配套的收紧：
- `dsh-remote-entry` 改为 `DSH_REMOTE_BIND=127.0.0.1`，**只有 SSH 隧道能访问**；
- 3099（Tailscale 入口）不再监听；
- PC 侧不再有对 `10.8.0.0/24` 的入站放行。

---

## 路径一：Tailscale（默认，在家/外网用）

```
手机/平板 ──https──> ygy12.tailef4f13.ts.net/go
                         │  (tailscale serve --set-path=/go)
                         ▼
                   127.0.0.1:3099  dsh-entry.service
                         │  302 /?token=<当前 token>
                         ▼
                   127.0.0.1:3080  DSH
```

- 走 Tailscale DERP 中继（东京），实测 **250–300ms**，有抖动。
- 优点：任何网络都能用，不需要公司 VPN。

---

## 路径二：公司 VPN（通勤推荐，实测 ~35ms）

```
手机/平板 ──OpenVPN(TCP 1194)──> 123.56.101.143（阿里云北京）
                                      │  VPN 子网 10.8.0.0/24
                                      ▼
                             PC 10.8.0.x ← 由 dsh-remote-entry 提供入口
                                      │  Host/Origin 改写为 127.0.0.1:3080
                                      ▼
                                127.0.0.1:3080  DSH
```

- 入口：`http://<PC 在 VPN 里的地址>:3098/go`（例：`http://10.8.0.42:3098/go`）
- 服务：`dsh-remote-entry.service`（systemd --user，已 enable）
- 实测：**首字节 ~0.5s 内开始逐字流式输出**，无抖动；明显优于 Tailscale。

### PC 侧需要的东西

| 项 | 值 |
|---|---|
| VPN 地址 | 每次连接从服务端分配，`ip -4 -o addr show \| awk '$4 ~ /^10\.8\./'` 查 |
| 监听 | `0.0.0.0:3098`（DSH 本身不动） |
| 防火墙 | 入站 TCP `9911,3080,3098` 仅允许 `10.8.0.0/24`（规则名 `DSH over VPN`） |
| 允许来源 | 回环 / `10.8.0.0/24` / `100.64.0.0/10`，其余 403 |

> ⚠️ 为什么不让 DSH 直接绑 `0.0.0.0`：上游 `webserver.host` **明确拒绝**通配地址
> （注释写着“绑所有网卡等于把 RCE 暴露到网络”），只接受具体 IP。而 VPN 地址每次可能变，
> 绑定会导致 VPN 一断就起不来 —— 所以用反代，不碰 DSH 的监听配置。

### Profile 说明

| 文件 | 用途 | 关键行 |
|---|---|---|
| `caikuai02-split-PC.ovpn` | 电脑 | `route-nopull` + `route 10.8.0.0/24` |
| `caikuai03-split-phone.ovpn` | 手机/平板 | 同上 |

- 原始配置的 `tls-cipher` 写的是 **ECDSA** 套件，但服务端证书是 **RSA 2048** →
  OpenVPN 2.7（ics-openvpn）严格遵守该行，必然握手失败（日志表现：
  `TLS: Initial packet …` 紧跟 `Connection reset`）。改成
  `TLS-ECDHE-RSA-WITH-AES-128-GCM-SHA256` 即可。
  OpenVPN Connect 会**忽略**该行，所以电脑端一直能连——这个坑藏了很久。
- 必须加 `route-nopull`：服务端推 `redirect-gateway def1`（全隧道），
  否则所有流量（含 SSR 出境）都会走阿里云北京出口，表现为“掉下墙”。

---

---

## 路径三：自建 tailnet 中继（VPS，2026-11-05 上线）

```
手机 ──Tailscale(WireGuard)──▸ 阿里云 VPS(100.109.125.37) ──SSH 反向隧道──▸ PC:3098
        直连实测 ~34ms                     VPS→PC ~14–26ms
```

- VPS：Debian 12，`dsh-relay`，tailnet `100.109.125.37`，公网 `112.126.90.114`（**公网 22 已收口，仅 tailnet 可 SSH**）；
- PC：`dsh-tunnel.service`（systemd --user，断线 5 秒重连，主机指纹固定）；
- 手机：开 Tailscale → `http://100.109.125.37:22022/go`；
- 多台 PC（2026-11-09）：每台各占一个 VPS 端口（主力 22022、第二台 22023），
  手机/平板开两个标签页即可任选一台；接入用 `ops/tunnel/join-relay.sh`，
  步骤见 [`ops/tunnel/README.md`](tunnel/README.md) 的「多台 PC 同时接入」。

**关键前置**：阿里云安全组必须放行 **UDP 41641**，否则 Tailscale 退回东京 DERP
（国内 VPS 连海外 DERP 均 148ms+），表现为“抖动又回来了”。

详细步骤、自检脚本、已知短板见 [`ops/tunnel/README.md`](tunnel/README.md)。

## VPS 暴露面（2026-11-05 定稿）

阿里云安全组只保留必要规则：

| 协议/端口 | 来源 | 用途 | 必须保留 |
|---|---|---|---|
| UDP 41641 | 0.0.0.0/0 | Tailscale 直连（不放行就退回东京 DERP，抖动） | ✅ |
| TCP 22 | 公网 0.0.0.0/0 → 主机 iptables 丢弃；安全组保留 **100.104.0.0/16** | tailnet 内 SSH + 控制台 Workbench 实例登录 | ✅（`PasswordAuthentication no`，仅密钥） |
| ICMP | 0.0.0.0/0 | 系统默认，无害 | 可选 |
| ~~TCP 3389 (RDP)~~ | ~~0.0.0.0/0~~ | 外网扫描已 closed；按清理项删除 | ✅ 已关 |

加固现状：

- **SSH 只允许 tailscale0**：`dsh-ssh-tailnet.service` 用 iptables 链 `DSH_SSH_TAILNET`
  放行 `tailscale0`/`lo` 的 22，其余接口 DROP；公网扫描确认 `:22` 已不可达。
  安装/回滚见 [`ops/vps/README.md`](vps/README.md)；VNC 控制台兜底；
- `PasswordAuthentication no` —— 只能密钥登录；
- `authorized_keys` 仅 1 把（PC 的 WSL 密钥）；
- `GatewayPorts clientspecified` —— 反向隧道只绑 tailnet 地址，公网看不到 22022；
- PC 侧反代 `DSH_REMOTE_BIND=127.0.0.1` —— 外部完全无法直连 3098；
- 元数据/云助手：Tailscale 的 `ts-input` 会把源地址 `100.64.0.0/10` 的非 tailscale 包
  丢掉，而阿里云元数据 `100.100.100.200` 正好在这个段里 → `dsh-aliyun-metadata.service`
  在 ts-input 之前显式放行它（否则云助手/免密登录一直异常），详见 `ops/vps/README.md`。

进阶（未实施）：PC 加入 tailnet 后，22 端口可从安全组整体删除，
公网只剩 UDP 41641（WireGuard 对未授权探测静默，扫描器看不到任何东西）。
代价是 PC 必须常驻 Tailscale，隧道依赖它。

## VPS 上的附加服务（2026-11-11 更新）

端口/凭据的权威表：[`tunnel/PORTS.md`](tunnel/PORTS.md)。

| 服务 | 监听 | 用途 | 资源 |
|---|---|---|---|
| tailscaled | UDP 41641 | 手机直连入口 | ~65MB |
| sshd | TCP 22 + tailnet 22022/22023 | PC 反向隧道 + 管理 | ~10MB |
| rest-server | **tailnet :3000**（append-only + basic auth） | restic 仓库的 HTTP 接入 | ~10MB |
| uptime-kuma | **tailnet :3001** | 监控面板 + push 接收 | ~150MB |
| ntfy | **tailnet :8080** | 手机推送（Kuma 告警经它落地） | ~20MB |
| miniserve | **tailnet :8081** | 手机↔PC 文件中转（basic auth） | ~10MB |
| restic 仓库 | /srv/backup/dsh | DSH 每日加密备份 | 磁盘 ~1.0GB（8 份快照，去重） |
| git 裸镜像 | /srv/git-mirror | 两个仓库的 `--mirror` 备份 | ~5MB |

定时任务、以及"为什么 prune/forget 只能在 VPS 做"，见 [`backup/README.md`](backup/README.md)
与 [`vps/README.md`](vps/README.md) 的「附加服务」一节。

**监控闭环**：Kuma 里 6 个监控项（隧道/公网 IP/DSH 根/DSH `/go`/备份新鲜度/VPS 健康），
通知统一走自建 ntfy；状态变化会在手机上收到 "VPS 健康 Down/Up" 这类消息。

### Uptime Kuma 的特殊装法（重要）

**不要在这台机器上跑 vite 构建**：2C2G 上会把内存打满、swap 抖动，
sshd 连 banner 都发不出（实测发生过，只能控制台重启）。

正确流程：

```
PC:   拉源码 → npm ci --ignore-scripts → npm run build → 得到 dist（14MB）
传输: tar czf - dist | ssh root@VPS 'tar -C /opt/uptime-kuma -xzf -'
VPS:  npm ci --omit=dev（本地编译 sqlite 原生模块）
```

三个必踩的坑：

1. **node-gyp 下 headers 被墙** → `npm_config_disturl=https://registry.npmmirror.com/-/binary/node`；
2. **Cypress 二进制下不动** → `CYPRESS_INSTALL_BINARY=0`（构建不需要它）；
3. **npm 日志目录不可写**（受限环境）→ `npm_config_logs_dir` 指到可写目录。

单元里 `ProtectSystem=full` 要求 `ReadWritePaths` 路径已存在，故有 `ExecStartPre=mkdir`。

### restic 备份（2026-11-11：改成 append-only rest-server）

- 仓库：`rest:http://100.109.125.37:3000/dsh/`（basic auth，口令在 `~/.restic-repo-url`）；
  仓库加密口令仍在 `~/.restic-pass`（**丢了数据就没了**）；
- **append-only**：PC 只能追加，`forget`/`prune` 被服务端 403 拒绝 ——
  即使 PC 中招，历史快照也删不掉；
- 脚本 `ops/backup/restic-backup.sh`：`--compression max`、`--limit-upload 200`（留带宽给隧道），
  成功后顺带把两个 git 仓库 `push --mirror` 到 `/srv/git-mirror`；
- 回收/校验全部在 VPS：`restic-prune.timer`（每月 1 日 04:30）、`restic-check.timer`（每周日 05:00）、
  `restic-lock-janitor.timer`（每日 03:00 清陈旧锁）。PC 上原来的 `dsh-prune.timer` 已作废；
- `restic-ctl.sh prune|forget|unlock` 会自动转成 SSH 到 VPS 执行（见脚本注释）；
- **首次全量约 16 分钟 / 800MB**；增量很小（2026-11-11 实测仓库 1.0GB / 8 份快照）。

⚠️ 长任务不要用临时 shell 跑（会被回收），用 `systemctl --user start dsh-backup.service --no-block`。

## 新设备（平板）怎么接

1. 导入 `caikuai03-split-phone.ovpn`（与手机同一份即可）；
2. **同一时刻只用一台设备连 VPN** —— 服务端通常不开 `duplicate-cn`，
   同证书并发会把前一台踢下线；
3. 连上后确认拿到 `10.8.0.x`；
4. 浏览器打开 `http://<PC 的 VPN 地址>:3098/go`。

平板通常不会被识别为手机，于是走桌面布局（底栏不受手机 2×2 规则影响）——这是预期行为。

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面能开但侧栏为空、设置里 `no active Host connection` | 反代没改写 `Origin`，WS 升级被拒 | 升级后的反代已修；确认服务已重启 |
| `ERR_TIMED_OUT` 打不开 3098 | 防火墙没放行 / PC 的 VPN 断开 | 查规则 `DSH over VPN`；查 PC 的 `10.8.0.x` |
| 手机 9911 能通但 3098 不通 | 规则里漏了端口 | 规则应为 `9911,3080,3098` |
| VPN 连上后供应商全挂 | 用了全隧道 profile | 换 `-split-` 版本 |
| 电脑默认路由变成 `10.8.0.1` | 同上 | 确认 profile 里有 `route-nopull` |

---

## 常用命令

```sh
# PC 当前 VPN 地址
ip -4 -o addr show | awk '$4 ~ /^10\.8\./ {print $2, $4}'

# 反代状态 / 重启
systemctl --user status dsh-remote-entry.service
systemctl --user restart dsh-remote-entry.service

# 从 PC 自测入口
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3098/go
```

---

## 维护教训（2026-11-04）

`~/dsh/profiles/web/node_modules/<plugin>` 的软链**必须指向 pack**：

```
dsh-mobile-ui -> ../../../playground/themes/dsh-guava-pack/plugins/dsh-mobile-ui
```

曾经指向 `playground/themes/dsh-mobile-ui`（9-30 的独立旧副本），导致
“改 pack → 提交 → 推送”全部无效，线上跑的一直是旧代码。判断方法：

```sh
ls -l ~/dsh/profiles/web/node_modules/ | grep playground
```

指向 `dsh-guava-pack/plugins/...` 的才是对的；指向裸目录名的都是漂移源。
