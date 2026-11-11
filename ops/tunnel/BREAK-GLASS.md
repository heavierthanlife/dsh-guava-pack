# 应急手册（break-glass）— VPS / 隧道 / 备份

> 2026-11-11 新增（C2）。**不新开任何公网端口**；按场景走 VPS 控制台或现有 tailnet 通道。
> 端口与凭据位置见 [`PORTS.md`](PORTS.md)。先跑诊断，再动手。

## 0. 第一件事：诊断

```bash
ssh -F /dev/null root@100.109.125.37 'bash /usr/local/sbin/dsh-doctor.sh'
# 或只看 FAIL：  ... --short
```

它会按顺序检查：资源 → 服务 → 端口 → tailnet → SSH 收口 → 反向隧道 → 备份 → 监控 → 错误日志，
最后给「硬故障数」。**先看 ❌，再决定走下面哪个场景。**

## 1. 手机连不上 DSH，但别的都正常

```bash
# VPS：隧道在不在？
ssh -F /dev/null root@100.109.125.37 'ss -ltn | grep -E ":22(022|023)"'
# 有监听 → 说明隧道的 VPS 端在；测一下 DSH 页面
curl -s -o /dev/null -w '%{http_code}\n' -m 8 http://100.109.125.37:22022/go
```

| 现象 | 处理 |
|---|---|
| 22022 没监听 | PC 上 `systemctl --user status dsh-tunnel.service`；`journalctl --user -u dsh-tunnel -n 30 --no-pager`；常见原因是 `~/dsh/tunnel.env` 的 IP/端口改了，或 PC 的 tailscale 掉线 |
| 监听在，但 `/go` 超时 | PC 上确认 DSH 本体：`systemctl --user status dsh.service`；再看 `dsh-remote-entry.service`（它把 3098 暴露给隧道） |
| `/go` 返回 5xx | 是 DSH 自己有问题，看 PC 上 `journalctl --user -u dsh.service -n 50`，跟 VPS 无关 |

## 2. Tailscale 有问题（手机显示 relay / offline）

```bash
ssh -F /dev/null root@100.109.125.37 '
  tailscale status | head
  systemctl is-active tailscaled
'
```

- 手机与 VPS 显示 `relay` 而不是 `direct`：安全组 **UDP 41641** 被删了 —— 阿里云控制台加回
  `UDP 41641 ← 0.0.0.0/0`，然后 `tailscale ping 100.109.125.37` 验证。
- VPS 上 `tailscaled` 挂了：`systemctl restart tailscaled`，再 `tailscale status`。
- 需要重新登录：`tailscale up --hostname=dsh-relay`（会打印登录链接，用手机/PC 打开授权）。

## 3. VPS 完全进不去（SSH 也连不上）

1. 阿里云控制台 → 实例 → **远程连接 / VNC**（root 密码见密码管理器，2026-11-05 设的）；
2. 或者用 **Workbench 实例登录**（需要安全组保留 `TCP 22 ← 100.104.0.0/16`，主机 iptables 也放行该段）；
3. 进去后先跑诊断脚本，再按结论修。

> 注意：`dsh-ssh-tailnet.service` 会把公网 22 DROP，只放行 tailnet/lo/Workbench 段。
> 如果这条链写坏了，控制台进去后执行：
> ```bash
> systemctl stop dsh-ssh-tailnet
> iptables -F DSH_SSH_TAILNET
> ```
> 修好再 `systemctl start dsh-ssh-tailnet`。

## 4. 备份相关

| 现象 | 处理 |
|---|---|
| 备份报 `repository is already locked` | `systemctl start restic-lock-janitor.service`（只清 >30 分钟旧锁）；仍不行看 `journalctl -u restic-lock-janitor -n 30` |
| Kuma 报「备份新鲜度 Down」 | 先确认 PC 上昨晚备份是否跑了：`journalctl --user -u dsh-backup -n 50 --no-pager`；再 `bash ops/backup/restic-ctl.sh snapshots` |
| `restic prune` 失败 | 只能在 VPS 跑：`systemctl start restic-prune.service`，看 `journalctl -u restic-prune -n 50` |
| 想删某个坏快照 | append-only 拒绝客户端删除；`bash ops/backup/restic-ctl.sh forget <id>`（自动转 VPS 执行） |
| 异地镜像红 | `systemctl start offsite-sync.service`，看 `journalctl -u offsite-sync -n 30`；若提示 CHANGE_ME，说明 AK/SK 还没填 |
| 磁盘紧张（>85%） | `journalctl --vacuum-size=200M`；`apt-get clean`；确认 prune 最近成功；必要时调大磁盘 |

## 5. 监控不响 / 收不到推送

```bash
# ntfy 自检（VPS 本机发一条）
ssh -F /dev/null root@100.109.125.37 '
  TOPIC=$(cat /etc/ntfy/topic)
  curl -fsS -d "break-glass test $(date -Is)" "http://100.109.125.37:8080/$TOPIC" && echo sent
'
```

- 手机收不到：ntfy App 里确认服务器是 `http://100.109.125.37:8080`、订阅了 `/etc/ntfy/topic` 里的 topic，
  且手机当时连着 Tailscale（ntfy **只绑 tailnet**）；
- Kuma 不推：面板里 `通知 → ntfy (VPS)` 点测试；再看 `journalctl -u uptime-kuma -n 30 | grep -i notification`。

## 6. 最坏情况：VPS 重建

数据都在 PC 上（备份在 VPS 是副本），重建只需要重做"接入"：

1. 新实例：Debian 12；安全组放行 `UDP 41641`、`TCP 22 ← 100.104.0.0/16`；
2. 装 Tailscale（`curl -fsSL https://tailscale.com/install.sh | sh`，`tailscale up --hostname=dsh-relay`）；
3. 装 sshd 收口：`ops/vps/ssh-tailnet-only.sh` + `.service`、`ops/vps/aliyun-metadata.sh` + `.service`；
4. PC 上改 `~/dsh/tunnel.env` 的 `VPS_TAILNET_IP`，`systemctl --user restart dsh-tunnel.service`；
5. 备份恢复：`ops/backup/README.md`（restic 仓库在旧盘上，新实例需要从对象存储/本地副本恢复；
   当前**没有异地方案**——这是已知单点，见 README「已知限制」）。

## 7. 恢复顺序（快速版）

```
① VPS 能 SSH（控制台兜底） → ② doctor 全绿或知道哪个 ❌
→ ③ tailscale 正常、22022 在监听 → ④ 手机能开 DSH
→ ⑤ 备份/监控不红
```
