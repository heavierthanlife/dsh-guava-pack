# VPS 加固：SSH 只允许 tailnet

## 目的

公网 `:22` 是 VPS 上唯一还开着的管理入口。这里用 iptables 把 22 收口到
`tailscale0` 接口：公网 eth0 上的 SSH 直接 DROP，只有 tailnet 内能连。

> 兜底：阿里云 **VNC 控制台**。Tailscale 挂了 / 规则写错时，用控制台登录，
> 执行 `systemctl stop dsh-ssh-tailnet && iptables -F DSH_SSH_TAILNET` 回滚。

## 安装（在 VPS 上，root）

```bash
# 从 PC 拷过去（PC 已经能通过 tailnet SSH）
scp -F /dev/null -o StrictHostKeyChecking=yes \
  ops/vps/ssh-tailnet-only.sh ops/vps/ssh-tailnet-only.service \
  root@100.109.125.37:/tmp/

ssh -F /dev/null -o StrictHostKeyChecking=yes root@100.109.125.37 '
  install -m 755 /tmp/ssh-tailnet-only.sh /usr/local/sbin/dsh-ssh-tailnet.sh
  install -m 644 /tmp/ssh-tailnet-only.service /etc/systemd/system/dsh-ssh-tailnet.service
  systemctl daemon-reload
  systemctl enable --now dsh-ssh-tailnet.service
'
```

验证：

```bash
# 公网应超时/拒绝
timeout 5 bash -c 'echo >/dev/tcp/112.126.90.114/22' || echo blocked
# tailnet 应正常
ssh -F /dev/null -o StrictHostKeyChecking=yes root@100.109.125.37 true
iptables -S DSH_SSH_TAILNET   # 应有 tailscale0/lo ACCEPT + DROP
```

## 回滚

```bash
systemctl disable --now dsh-ssh-tailnet.service
iptables -D INPUT -j DSH_SSH_TAILNET
iptables -F DSH_SSH_TAILNET && iptables -X DSH_SSH_TAILNET
ip6tables -D INPUT -j DSH_SSH_TAILNET 2>/dev/null || true
ip6tables -F DSH_SSH_TAILNET 2>/dev/null || true
```

## 为什么不用安全组

tailnet 流量在 VPS 上是**解密后**从 `tailscale0` 进来，阿里云安全组看到的是
UDP 41641 的加密流量，没法按 tailnet 源 IP 过滤 22。所以在主机侧按**接口**过滤
才是正解；安全组里 22 可以留着（公网包到主机后被 DROP）。
