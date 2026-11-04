# 远程访问 DSH（Tailscale / 公司 VPN）

两条独立的路子，可并存。DSH 本体始终只监听 `127.0.0.1:3080`，外部入口都是**反代**。

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
