# 方案 A：自建 tailnet 中继（手机 → VPS → PC）

```
手机 ──WireGuard(Tailscale, 加密)──▸ VPS(100.x) ──SSH 反向隧道(加密)──▸ PC:3098 ──▸ DSH:3080
        ↑ 直连时 ~34ms                    ↑ ~14ms RTT
```

## 为什么需要它

- **公司 VPN 路径**：快，但流量经公司服务器，且依赖公司网络；
- **Tailscale 直连 PC**：端到端加密，但公司是对称 NAT，直连打不通 → 只能走东京 DERP（150–250ms + 抖动）；
- **方案 A**：把中继换成自己国内 VPS。手机直连 VPS（不是 DERP），VPS 再通过 SSH 反向隧道到 PC。

实测（2026-11-05）：

| 段 | 数值 |
|---|---|
| 手机 → VPS（Tailscale direct） | **34ms** |
| VPS → PC（SSH 隧道） | 14–26ms |
| 经隧道请求 `/go`（12 次） | 最小 76 / 中位 106 / 最大 212ms |

## 前置条件（VPS 侧，一次性）

```bash
# 1) 装 Tailscale 并加入 tailnet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname=dsh-relay
tailscale ip -4                     # 记下 100.x.y.z

# 2) 允许反向隧道绑定「指定地址」（只绑 tailnet，不暴露公网）
grep -q "GatewayPorts clientspecified" /etc/ssh/sshd_config \
  || echo "GatewayPorts clientspecified" >> /etc/ssh/sshd_config
systemctl restart ssh
```

**⚠️ 最容易漏的一步：阿里云安全组必须放行 UDP 41641**

```
协议：UDP   端口：41641/41641   授权对象：0.0.0.0/0
```

不放行时 Tailscale 无法直连，会退到 DERP 中继。国内 VPS 连 Tailscale 的海外 DERP 全在
150ms 以上（`tailscale netcheck` 实测：Nearest DERP = Nuremberg 148ms），表现为「回到
东京中继那种抖动」。

## PC 侧

1. 公钥写进 VPS 的 `~/.ssh/authorized_keys`；
2. 固定主机指纹：`ssh-keyscan -p 22 <VPS公网IP> >> ~/.ssh/known_hosts`；
3. 装 systemd 单元（见本目录 `dsh-tunnel.service`）：

```bash
mkdir -p ~/.config/systemd/user
cp dsh-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-tunnel.service
```

单元里的 `-F /dev/null` 不是多余的：本机系统 `ssh_config` 里有一个坏属主的
`/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`，不绕过会直接报
`Bad owner or permissions`。

## PC → VPS

`dsh-tunnel.service` 的 `VPS_PUBLIC_IP` 现在填 **tailnet 地址**（`100.109.125.37`）：
公网 22 已由 VPS 侧 `dsh-ssh-tailnet.service` 用 iptables 丢弃，只有 `tailscale0` 能进 22。
VNC 控制台是唯一兜底。

## 手机侧

打开 Tailscale（这是唯一 VPN 槽，公司 OpenVPN 要关掉），访问：

```
http://<VPS tailnet IP>:22022/go
```

## 自检

```bash
bash ops/tunnel/check.sh <VPS tailnet IP>
```

关键判据是 `tailscale status` 里手机那行：

- `active; direct 1.2.3.4:xxxxx` → 正常（快）；
- `active; relay "tok"` → 走了东京中继（慢），先查安全组 UDP 41641。

## 已知短板：TCP 套 TCP

链路是 `手机─TCP─VPS─SSH(TCP)─PC`，浏览器 TCP 终止在 VPS、再由 SSH 重新发起到 PC，
丢包时两条 TCP 各自重传，抖动会被放大。

要根治得把 VPS↔PC 换成 WireGuard（站点到站点），让端到端 TCP 一直贯通。
截至 2026-11-05 未实施——先看实际手感，够用就不加复杂度。
