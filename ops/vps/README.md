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

> **控制台「实例登录 / 免密登录」还需要一条例外**：阿里云 Workbench 从内网
> `100.104.0.0/16` 连实例私网 IP:22。本单元已在链里放行该网段的 22，否则控制台会报
> “实例登录失败”（实例本身没毛病）。安全组同时要保留 TCP 22 ← 100.104.0.0/16。

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

---

## 附加服务（2026-11-11 上线）

端口与凭据的权威表在 [`../tunnel/PORTS.md`](../tunnel/PORTS.md)。下面只写"为什么"和安装/回滚。

### 1. ntfy（自建推送，tailnet-only）

`/etc/ntfy/server.yml` → `listen-http: 100.109.125.37:8080`；单元 `ntfy.service`（User=ntfy）。
topic 在 `/etc/ntfy/topic`（等同令牌，别外传）。手机装 ntfy App → 添加服务器
`http://100.109.125.37:8080` → 订阅该 topic。

回滚：`systemctl disable --now ntfy.service`（Kuma 的通知会失败，但监控本身不受影响）。

### 2. uptime-kuma 的监控项与通知（脚本改 DB）

Kuma 1.23 没有「建监控/建通知」的公开 API，所以用
[`kuma-configure.py`](kuma-configure.py) 按表结构写库：**先停服务 + 备份 DB**，
写完启动并校验，异常自动回滚。幂等，可重复跑。

```bash
# 首次 / 修改监控定义后
python3 kuma-configure.py --dry-run     # 先看一眼要做什么
python3 kuma-configure.py
```

它会做三件事：建 `ntfy (VPS)` 通知并设为默认、建 `DSH /go`（HTTP）与两个 push 监控、
把所有监控关联到通知。push 令牌写 `/etc/kuma/push-tokens.env`。

> 踩过的坑：Kuma 的 ntfy provider 会**无条件**把 `monitor.url` 塞进消息里的
> 「打开」按钮；push 监控没有 url 时 ntfy 返回 `400 actions invalid`。所以两个
> push 监控的 url 填成 `http://100.109.125.37:3001`（只是按钮目标，不影响探测）。

### 3. 健康自检 / 备份新鲜度（推给 Kuma）

| 单元 | 频率 | 检查 |
|---|---|---|
| `dsh-health-push.timer` | 30 分钟 | 根分区 >85%、可用内存 <120MiB、restic 有锁、关键服务挂了、git 镜像 >48h 没更新 |
| `dsh-backup-freshness.timer` | 6 小时 | restic 最新快照 >26h → down |

单位是 oneshot + 推 Kuma push 端点；状态变化时 Kuma 会经 ntfy 推到手机。
手动触发：`systemctl start dsh-health-push.service`。

### 4. miniserve（文件中转，tailnet-only + **令牌路径**）

`/srv/exchange`（User=exchange）；访问 `http://100.109.125.37:8081/<PREFIX>/`，
PREFIX 在 `/etc/miniserve/env`（600）。支持上传、**删除（每行 ✗）**、建目录（`--mkdir`）、禁符号链接、隐藏版本页脚；删除是立即生效、没有回收站，只能删 `/srv/exchange` 内的东西。

> 为什么不用 HTTP Basic：手机上 Basic 认证要手动输入，Android 用户名框还会
> 自动首字母大写，实测反复 `Invalid credentials for HTTP authentication`。
> 改为高熵随机路径前缀当令牌：点链接即用，仍然只绑 tailnet。
> 代价：拿到链接的人就能读写该目录（等价于一个 capability URL），别截图外传。

回滚：`systemctl disable --now miniserve.service`（旧的 basic auth 版本见 git 历史）。

### 5. rest-server（append-only 仓库）+ 维护任务

见 [`../backup/README.md`](../backup/README.md) 的「append-only」一节。

#### 5.5 重建所需单元文件（都在本目录）

`ntfy.service` / `rest-server.service` / `miniserve.service` 的原样副本，以及
`ntfy-server.yml.example`、`miniserve.env.example`。重建 VPS 时：

```bash
# 单元
install -m 644 ops/vps/{ntfy,rest-server,miniserve}.service /etc/systemd/system/
# 配置示例（改掉占位符）
install -m 640 ops/vps/ntfy-server.yml.example /etc/ntfy/server.yml
install -m 600 ops/vps/miniserve.env.example /etc/miniserve/env   # 填 PREFIX
systemctl daemon-reload && systemctl enable --now ntfy rest-server miniserve
```

rest-server 的认证文件用 `python3 -c` + `crypt.mksalt(crypt.METHOD_BLOWFISH)` 生成
（格式 `restic:$2b$...`，见首次安装记录），不放仓库。

## 6. 统一入口 dsh-console（`:8090`）

一个页面看全部：DSH 入口（22022/22023）、Kuma、ntfy、miniserve、备份状态与动作、doctor。
实现与运维见 [`../console/README.md`](../console/README.md)；口令在 `/etc/dsh-console/password`。
动作白名单只有 `prune` / `check` / `unlock` / `doctor`，二次确认 + CSRF 头，不接受任意命令。

### 7. BBR + 自动安全更新

- `/etc/sysctl.d/99-dsh-bbr.conf`：`net.core.default_qdisc=fq`、`net.ipv4.tcp_congestion_control=bbr`
  （实测中继/备份走的移动网络吞吐更稳；`sysctl --system` 立即生效，重启保持）；
- `unattended-upgrades` + `/etc/apt/apt.conf.d/51-dsh-unattended`：**只自动装安全更新**，
  不自动重启；需要重启时 `dsh-health-push` 会在消息里写「需要重启」。
