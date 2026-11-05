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


## 附加坑：Tailscale 把阿里云元数据/DNS 当成 CGNAT 伪造包丢了

症状：控制台“云助手”状态异常，实例内 `curl http://100.100.100.200/latest/meta-data/`
**TCP 超时**（不是 403/404）；阿里云内网 DNS 100.100.2.136/138 也时好时坏。

原因：Tailscale 在 `INPUT` 挂了 `ts-input`，其中有

```
-A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP
```

阿里云元数据 `100.100.100.200`、内网 DNS `100.100.2.136/138`、云助手内网端点
（如 `100.100.45.106`）都在 `100.64.0.0/10` 里，响应包从 `eth0` 回来就被 DROP。
控制台的“实例元数据访问”开着也没用。

修复：`dsh-aliyun-metadata.service` 在 `ts-input` 之前显式 ACCEPT **`100.100.0.0/16`**
（元数据 100.100.100.200、内网 DNS 100.100.2.136/138、云助手内网端点都在这个段里）
（`ops/vps/aliyun-metadata.sh`），并重启 `aliyun.service` 让它重新注册。
安装：

```bash
scp -F /dev/null -o StrictHostKeyChecking=yes \
  ops/vps/aliyun-metadata.sh ops/vps/aliyun-metadata.service \
  root@100.109.125.37:/tmp/
ssh -F /dev/null -o StrictHostKeyChecking=yes root@100.109.125.37 '
  install -m 755 /tmp/aliyun-metadata.sh /usr/local/sbin/dsh-aliyun-metadata.sh
  install -m 644 /tmp/aliyun-metadata.service /etc/systemd/system/dsh-aliyun-metadata.service
  systemctl daemon-reload && systemctl enable --now dsh-aliyun-metadata.service
'
curl -s http://100.100.100.200/latest/meta-data/instance-id   # 应返回 i-xxxx
```

注意：如果以后 Tailscale 升级/重启后云助手又异常，先
`systemctl restart dsh-aliyun-metadata.service` 把 ACCEPT 规则重新提到最前面。
