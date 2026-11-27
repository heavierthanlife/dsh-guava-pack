# 应急手册（break-glass）— VPS / 隧道 / 备份

> 2026-11-11 新增（C2），2026-11-12 补充「踩坑速查」（第 8 节，全部来自实际事故）。
> **不新开任何公网端口**；按场景走 VPS 控制台或现有 tailnet 通道。
> 端口与凭据位置见 [`PORTS.md`](PORTS.md)。先跑诊断（第 0 节），再看场景；拿不准就翻第 8 节。

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

**先查「实例登录失败」最常见的原因**（2026-11-11 实际踩到）：Tailscale 的 `ts-input`
把阿里云内网包 DROP 了，元数据与 Workbench 一起失效。VPS 上（别的方式能进时）执行：

```bash
iptables -S INPUT | head -5      # 头两条必须是 100.104/16:22 与 100.100/16
curl -s -m 5 http://100.100.100.200/latest/meta-data/instance-id   # 超时=被挡
systemctl restart dsh-aliyun-metadata                              # 重排规则（幂等，注意是 restart）
systemctl start dsh-aliyun-metadata-reassert.timer                 # 兜底每 5 分钟
```

进不去时的入口（按可用性排序）：

1. 阿里云控制台 → 实例 → **远程连接 / VNC**（root 密码见密码管理器，2026-11-05 设的）；
2. **Workbench 实例登录**（需要安全组保留 `TCP 22 ← 100.104.0.0/16`，主机 iptables 也放行该段）；
3. 从 PC 走 tailnet：`ssh -F /dev/null root@100.109.125.37`（若 tailscale 正常）；
4. 进去后先跑诊断脚本，再按结论修。

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

## 8. 踩坑速查（全部来自真实事故，2026-11）

> 这一节是「症状 → 真因 → 处置」的备忘录。每条都对应一次实际故障，
> 不是理论清单。看到类似症状先来这里对一遍，能省掉大量乱猜。

### 8.1 Kuma 数据库看不到最新心跳（会误判成"没上报"）

**症状**：`PC 健康` 之类的 push 监控其实已经上报成功，但查库显示
`No heartbeat in the time window`，于是误以为定时器没跑。

**真因**：Kuma 的 `kuma.db` 是 **WAL 模式**，最新的 heartbeat 先落在 `kuma.db-wal` 里。
用 `sqlite3 'file:...?immutable=1'` 打开会**忽略 WAL**，只能看到旧数据。

**正确读法**（不要加 `immutable=1`）：

```bash
ssh -F /dev/null root@100.109.125.37 '
  python3 - <<"PY"
import sqlite3
con = sqlite3.connect("file:/opt/uptime-kuma/data/kuma.db?mode=ro", uri=True)
for mid in (9, 10):
    print(mid, con.execute(
        "select status,msg,time from heartbeat where monitor_id=? order by id desc limit 3",
        (mid,)).fetchall())
PY'
```

**判据**：`status=1` 是 UP、`0` 是 DOWN。只有 `mode=ro`（带 WAL）读到的才是真相。
如果确实没有心跳，再去查 `systemctl --user status dsh-pc-health.service`。

### 8.2 restic 管道用法会「留一把锁」，把后续备份全堵死

**症状**：`restic snapshots --json | python3 …` 之类的取数命令跑完后，
后续 `forget`/`backup` 全部报
`repository is already locked by PID … on … by restic`。

**真因**：restic 在被管道提前关闭 stdout 时，**来不及走正常退出路径删掉自己的锁文件**。
（2026-11-11 实测：`dsh-restic-prune.sh` 收尾统计快照数就把仓库锁住了。）

**处置**：

```bash
# 只清 >30 分钟的陈旧锁（不碰正在进行的备份）
systemctl start restic-lock-janitor.service
```

**预防**：任何**只读**取数都加 `--no-lock`：

```bash
restic snapshots --no-lock --json | python3 -c '…'
```

改锁相关脚本时，用 `unlock`（不带 `--remove-all`）而不是暴力清空 `locks/`。

### 8.3 重启后阿里云内网被 Tailscale 抢杀（元数据 / Workbench 一起坏）

**症状**：控制台「实例登录失败」；同时 VPS 上
`curl http://100.100.100.200/latest/meta-data/instance-id` 超时、云助手异常。

**真因**：`iptables` 里 `ts-input` 排到了 INPUT 最前，而它含
`-s 100.64.0.0/10 ! -i tailscale0 -j DROP`；阿里云元数据 `100.100.x` 与
Workbench `100.104.x` 都落在这个段里，于是在我们的 ACCEPT 之前就被 DROP。

**为什么会复发**：旧脚本用 `iptables -C … || iptables -I INPUT 1 …`，
规则已存在时**不会把位置挪回最前**，顺序一旦被别的服务打乱就永久失效。
`tailscaled` 每次（重）启动都会重插自己的链。

**处置 / 自愈**：

```bash
iptables -S INPUT | head -5                              # 头两条应是 100.104/16:22、100.100/16
systemctl restart dsh-aliyun-metadata                    # 幂等重排（RemainAfterExit，必须 restart）
systemctl start dsh-aliyun-metadata-reassert.timer       # 每 5 分钟兜底
```

**注意**：这套脚本加了 `flock -w 10` 并发锁 —— 同一时刻两个实例「删旧+插新」
会产生**重复规则**（实测出现过 2 条）。重复规则本身无害，但会让 `grep -c` 的
自检失真；看到条数 >1 说明有并发，跑一次 `systemctl restart dsh-aliyun-metadata` 即可收敛。

### 8.4 手机上 miniserve 的 Basic 认证永远输不对

**症状**：手机/平板浏览器反复弹登录框，输对了口令也进不去；
VPS 日志刷 `Invalid credentials for HTTP authentication`。

**真因**：不是口令错，是**手机键盘/输入法把用户名首字母自动大写**（`share` → `Share`），
Basic 认证区分大小写，于是永远失败。桌面端 curl 同一个口令是 200。

**处置**：改成**令牌路径**（现网就是这个）：

```
http://100.109.125.37:8081/<PREFIX>/
```

`<PREFIX>` 在 VPS `/etc/miniserve/env`（600）。根路径 `/` 返回 404 是**故意的**。
控制台首页会自动读取该文件生成链接，不用手输。

**代价（必须知道）**：链接本身就是凭据 —— 拿到链接的人能上传/下载/**删除**。
别截图外传；泄露了就换 `PREFIX` 并 `systemctl restart miniserve`。

### 8.5 控制台「一键登录令牌」和「Basic 口令」是两个东西

**症状**：`curl -u dsh:<贴在聊天里的那串>` 返回 401，但页面本身是好的。

**真因**：`/etc/dsh-console/token`（一键登录用）和 `/etc/dsh-console/password`
（Basic 用）是**两份独立的 32 位十六进制串**。用 token 当口令必然 401。

**怎么区分**：两个文件都在，取错的概率很高 —— 直接看用途：

| 用途 | 取哪个 | 用法 |
|---|---|---|
| 一键登录（推荐，手机/PC 都不用输入） | `/etc/dsh-console/token` | 打开 `http://<host>:8090/?k=<token>`，种 30 天 cookie |
| Basic 认证 | `/etc/dsh-console/password` | 用户名固定 `dsh` |

```bash
ssh -F /dev/null root@100.109.125.37 'cat /etc/dsh-console/token; echo; cat /etc/dsh-console/password'
```

**轮换**（两个都换，会踢掉已保存的登录）：

```bash
ssh -F /dev/null root@100.109.125.37 '
  openssl rand -hex 16 > /etc/dsh-console/token
  openssl rand -hex 16 > /etc/dsh-console/password
  systemctl restart dsh-console'
```

### 8.6 Windows 浏览器打不开 `100.x`，但 `curl.exe` 是 200

**症状**：控制台（走 `localhost` 转发）能开，`http://100.109.125.37:8080` 等却打不开；
在 PowerShell 里 `curl.exe` 对同一地址返回 200/302。

**真因**：`curl.exe` **不走系统代理**，浏览器**走**。常见两种：
① WinINET 手动代理把 `100.x` 也代理走了；② 浏览器「始终使用安全连接」尝试把
`http://<IP>` 升级成 https（IP 没有证书 → 失败），而 `localhost` 恰好被豁免
（这条完美解释"只有控制台能开"）。

**排查（PowerShell，不是 WSL bash）**：

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' |
  Select-Object ProxyEnable, ProxyServer, ProxyOverride, AutoConfigURL
curl.exe -s -o NUL -w "8080=%{http_code}`n" http://100.109.125.37:8080/
```

- `curl.exe` 通、浏览器不通 → 浏览器层（代理例外没生效 / HTTPS-First / 代理扩展），
  用 InPrivate 窗口 + 关扩展再试；
- 两个都不通 → Windows 路由层。

**兜底（已固化，最省事）**：WSL 里的 `console-forward.service` 把 8090/3001/8080/8081
四个端口转发到 `localhost`，完全绕开浏览器代理：

```bash
systemctl --user enable --now console-forward.service
# Windows 打开 http://localhost:8090（以及 :3001 / :8080 / :8081）
```

### 8.6b 控制台能开、但里面点「监控面板/推送/文件中转」打不开

**症状**：经 `http://localhost:8090` 打开控制台正常，但点入口卡跳到
`http://100.109.125.37:3001` 之类的地址就打不开（8.6 那类代理/HTTPS-First 问题）。

**真因**：入口卡当时把 `100.109.125.37` **写死在 HTML 里**。控制台本身是经 WSL 转发
（`localhost:8090`）访问的，但卡片链接指向 tailnet IP —— 浏览器对 `100.x` 走代理/升级
https 失败，于是"控制台能开、其它都点不开"。

**修复（已落地）**：卡片改用 `data-port`，由 JS 按**当前访问的主机名**拼链接
（`location.hostname + ':' + port`），miniserve 的令牌链接也在前端把服务端返回的
绝对地址换成本机 host。同时 `console-forward.service` 补齐了 `22022/22023` 转发，
所以六个入口在 `localhost` 下都可用。

**验证**：

```bash
for p in 8090 3001 8080 8081 22022 22023; do
  printf "localhost:%-6s -> " "$p"; curl -s -o /dev/null -w '%{http_code}\n' -m 6 "http://127.0.0.1:$p/"
done
```

预期：8090=401（要认证）、3001=302、8080=200、8081=404（令牌路径，正常）、
22022/22023=401 或 302（取决于隧道是否在）。

### 8.6c 入口卡「点了没反应」= 链接赋值函数没被调用

**症状**：控制台能开，**文件中转**能点（因为它走另一条赋值路径），
但「监控面板 / 推送 / 两台 DSH」点了**毫无反应**（不是报错，是根本没跳）。

**真因**：入口卡的 `href` 是 JS 运行期赋值的（`applyEntryHrefs()`）。
2026-11-12 一次改动把这一行误插进了 `doAction()` 的 `.finally()` 里 ——
**语法没问题、`grep applyEntryHrefs` 也能搜到**，但启动时从未调用，
于是 `<a>` 上没有 `href`，点击没有任何效果。纯静态断言抓不到这种"位置错"。

**排查**：

```bash
# ① 页面里 `<a data-port=...>` 是否存在、是否有 href（浏览器 DevTools 里看更快）
curl -s -u dsh:$(...口令...) http://localhost:8090/ | grep -o 'data-port="[0-9]*"[^>]*'

# ② 直接跑行为测试（比肉眼靠谱）
node tools/tests/console-entry-links.mjs
```

**修复**：`applyEntryHrefs()` 必须在脚本末尾、`refreshStatus()` 之前调用一次
（不能在某个回调里）。已加 `tools/tests/console-entry-links.mjs`：
用最小 DOM 桩在 `node:vm` 里真跑页面主脚本，断言四张卡片的 href 是
`http://<当前host>:<端口>/[go]`，位置错了会直接 FAIL。

**判据**：入口卡点不动时，先跑上面那个测试 —— 它红了就是代码问题，绿了才是网络/代理问题（见 8.6）。

### 8.7 `apt` 镜像偶发断连，会让安全更新「卡好几天」

**症状**：`unattended-upgrades` 日志里
`ERROR fetch.run() result: E:Method http has died unexpectedly!`，
随后整轮升级中止；`apt-get -s dist-upgrade | grep -ci '^Inst.*security'` 长期不归零。

**真因**：阿里云镜像偶发 TCP 断连，apt 默认重试次数太少 → 一个包下载失败就整轮放弃；
而 `unattended-upgrades` 每天只跑一次，于是永远卡住。

**处置**：

```bash
# 已固化（/etc/apt/apt.conf.d/52-dsh-retries，模板见 ops/vps/52-dsh-retries.conf.example）
Acquire::Retries "5";  Acquire::http::Timeout "30";  Acquire::https::Timeout "30";

# 手动补一轮（跑完看剩余数应为 0）
ssh -F /dev/null root@100.109.125.37 '
  DEBIAN_FRONTEND=noninteractive unattended-upgrade -v | tail -5
  apt-get -s -o Debug::NoLocking=true dist-upgrade | grep -ci "^Inst.*security"'
```

**注意**：并发跑两个 `unattended-upgrade` 会互相等锁，看起来像"卡住"；
`pgrep -af unattended-upgrade` 确认只有一个再判断。

### 8.8 内核更新后必须重启（只装包不生效）

```bash
ssh -F /dev/null root@100.109.125.37 '
  cat /var/run/reboot-required.pkgs 2>/dev/null
  uname -r'
```

`reboot-required.pkgs` 里有 `linux-image-*` 就说明要重启；`uname -r` 对比已装版本即可
判断是否已生效。`dsh-health-push.sh` 会把这个写进每 30 分钟的健康消息里
（`需要重启（内核/库更新）`），所以不会漏。

重启影响面：VPS 上的中继/控制台/Kuma 断 **30–60 秒**，PC 本机 DSH 完全不受影响，
手机隧道会自动重连。重启后 Kuma 会如实报一次 Down→Up（这是正常的，不是故障）。

### 8.9 systemd oneshot 的 `start` 不会重跑（要用 `restart`）

**症状**：改了脚本，`systemctl start dsh-aliyun-metadata` 之后行为没变。

**真因**：`Type=oneshot` + `RemainAfterExit=yes` 的单元在 active 状态下 `start` 是空操作。

**处置**：改脚本后用 `restart`；只想重跑「跑完就退出」的 oneshot（如 prune/check）用 `start` 没问题。

### 8.10 `git fetch` 在本机报权限错误（其实是 ssh_config 的问题）

**症状**：`git fetch` 报
`Please make sure you have the correct access rights and the repository exists`，
但同一个 key 能 `ssh` 上去。

**真因**：系统 `/etc/ssh/ssh_config.d/` 里有个属主不对的 include
（`Bad owner or permissions on …`），ssh 直接拒用整份配置。

**处置**：所有 ssh/git 命令都显式绕开系统配置：

```bash
GIT_SSH_COMMAND="ssh -F /dev/null -o StrictHostKeyChecking=accept-new -o BatchMode=yes" git fetch origin
ssh -F /dev/null root@100.109.125.37            # 手工 ssh 同理
```

（`-F /dev/null` 是这套环境里**所有** ssh 调用的标配，脚本里已经这么写。）

### 8.11 VPS 直连 GitHub 的 TLS 会偶发断（所以镜像方向改成 PC 推）

**症状**：VPS 上 `git clone/fetch` github.com 报
`GnuTLS recv error (-110): The TLS connection was non-properly terminated`，重试也常失败。

**真因**：VPS（北京）到 GitHub 的链路不稳；PC 侧同样命令却稳定。

**处置**：**不要让 VPS 去拉**。镜像方向是 PC → VPS：

```bash
# PC 上（每日备份成功后自动跑，也可手动）
bash ops/backup/git-mirror-push.sh
# 成功后写 /srv/git-mirror/.last-run；超过 48h 未更新会被 VPS 健康自检报警
```

VPS 上的 `dsh-git-mirror.timer`（拉取方向）已停用删除，不要再装回去。

### 8.12 Kuma 的 ntfy 通知对 push 监控会 400（缺 url）

**症状**：`journalctl -u uptime-kuma` 里
`Cannot send notification to ntfy (VPS)` +
`400: invalid request: actions invalid; parameter 'url' is required for action 'view'`。

**真因**：Kuma 的 ntfy provider **无条件**把 `monitor.url` 塞进消息里的「打开」按钮；
push 监控天然没有 URL，于是 ntfy 校验失败、整条通知发不出去。

**处置**：push 监控的 `url` 填一个可点的目标（现网填 Kuma 自己
`http://100.109.125.37:3001`）。`ops/vps/kuma-configure.py` 已经这么写，重跑即可对齐。

### 8.13 两个 restic 口令别混（仓库加密口令 ≠ rest-server 认证口令）

| 口令 | 位置 | 用途 | 丢了会怎样 |
|---|---|---|---|
| 仓库加密口令 | PC `~/.restic-pass`；VPS `/etc/restic/repo-password` | `restic` 解密仓库 | **数据永久无法恢复** |
| rest-server 认证口令 | PC `~/.restic-repo-url`（含在 URL 里）；VPS `/etc/rest-server/password` | HTTP Basic 访问 `:3000` | 备份失败，可重置 |

**症状**：报 `401`/`invalid password` 时先分清是哪一层：
`curl -u restic:<pw> http://100.109.125.37:3000/` 探的是**第二层**（认证）；
`restic snapshots` 报 `wrong password` 才是**第一层**（加密口令）。

### 8.14 append-only 仓库下，客户端删不掉东西（这是设计）

`rest-server --append-only` 下，PC 侧 `forget`/`prune`/`DELETE` 一律 **403**。
这是有意的：即使 PC 中招，也删不掉历史快照。要删请走 VPS 侧：

```bash
bash ops/backup/restic-ctl.sh forget <id>     # 自动 SSH 到 VPS，以 restic 用户执行
bash ops/backup/restic-ctl.sh prune           # 触发 VPS 的 oneshot
```

### 8.16 Windows 登录弹「缺少对象: 'sh'（800A01A8）」= VBS 换行/编码问题

**症状**：Windows 登录时弹 VBScript 错误框，指向
`…\Startup\dsh-wsl-autostart.vbs` 第 3 行 `Set sh = …`，报
`缺少对象: 'sh'`，错误码 `800A01A8`。

**真因**：该 `.vbs` 由 `ops/install-tailnet-autostart.sh` 生成。旧实现用
`cat > "$VBS" <<EOF`，在 WSL 上写出的是 **LF + UTF-8**。VBScript 不认 LF-only：

- 第 3 行被并进上一行注释（`'` 开头），`Set sh = ...` **从未执行**；
- 第 4 行 `sh.Run …` 于是引用不存在的对象 → 800A01A8。

代码本身没错，纯粹换行符 + 编码问题。

**正确的字节契约**：`UTF-16LE(BOM=FF FE)` + 每行 `CRLF`（4 个），不能有裸 LF。

**已验证的修复方式**（脚本里已改成这个；2026-11-12 已与 Windows 上人工修好的文件逐字节比对一致，556 字节）：

```sh
{
  printf "' ...中文注释...\r\n"
  printf "' ...\r\n"
  printf 'Set sh = CreateObject("WScript.Shell")\r\n'
  printf 'sh.Run "%s -d %s --exec /bin/sh -c ""sleep infinity""", 0, False\r\n' "$WSL_WIN" "$DISTRO"
} | iconv -f UTF-8 -t UTF-16LE > tmp
{ printf '\377\376'; cat tmp; } > "$VBS"        # 补 BOM
rm -f tmp
```

**现场应急**（不想重跑脚本时）：把那个 `.vbs` 用记事本另存为「Unicode」，
或 `unix2dos` 之后用 `iconv -f UTF-8 -t UTF-16LE` 重写并补 BOM。

**当前状态**：生成处已修 + 加了自检（BOM 与裸 LF 校验，不通过会当场告警）+
回归测试 `node tools/tests/vbs-autostart.mjs`（已进 `npm test`）。

### 8.17 两台机器共用一个 restic 仓库：`restore latest` 会拿到另一台的

**症状**：在公司那台（T14p）上 `restic ls latest` / `restore latest`，列出的 / 恢复出的内容
属于 MSI（或反过来）—— 因为两台备份到**同一仓库、同一路径 `/home/guava5tar_/dsh`、
同一用户名 `guava5tar_`、同一 tag `dsh-nightly`**，restic 的 `latest` 只按时间取，
**不知道"本机"是哪个**。

**真因**：区分维度只有 restic 的 `--host`（取备份时的 hostname），
而默认用法（`latest`、`ls latest`）不带你就会随机命中。2026-11-12 实测踩到。

**修复（已落地）**：`restic-backup.sh` 额外打机器 tag `host-<短主机名小写>`：

| 机器 | tag |
|---|---|
| YGY12（主力） | `host-ygy12` |
| MSI | `host-msi` |

```bash
# 只看本机 / 只恢复 MSI
restic snapshots --tag host-ygy12
restic restore --tag host-msi latest --target /tmp/restore-msi --include '/home/guava5tar_/dsh/profiles'
```

**给历史快照补标**：append-only 下客户端改不了（403），只能在 VPS 侧做：

```bash
ssh -F /dev/null root@100.109.125.37 '
  RS="runuser -u restic -- env RESTIC_REPOSITORY=/srv/backup/dsh \
      RESTIC_PASSWORD_FILE=/etc/restic/repo-password RESTIC_CACHE_DIR=/var/cache/restic \
      /usr/local/bin/restic"
  $RS snapshots --no-lock --json | python3 -c "..."   # 按 hostname 归出短 id
  $RS tag --add host-msi <短 id>'
```

> ⚠️ `restic tag` 会**重写快照文件 → 短 ID 变化**。如果别处引用过旧短 ID
> （笔记、脚本），要一起更新。2026-11-12 补标 12 条历史快照时全部 ID 都变了。

**判据**：`restic snapshots --json | jq '.[].tags'` 里每条都应有 `host-*`。

### 8.18 ACP nudge 横幅「压完了不消失」= 只数时间，不认回应

**症状**：照着输入框上沿那条「上下文 N% · 建议压缩」压缩成功，横幅还在那儿杵着，
要手动点 × 才走。用户原话：「有点不够高级」。

**真因**：横幅的显隐条件只有 `Date.now() - lastNudge.at < 15min`（`client.js` 的
`AcpNudge`）。它**不知道**模型是否已经照办 —— `lastNudge` 是 host 侧的瞬时状态，
压缩成功是会话日志里的 `compaction/summary`，两条线没接上。于是正确操作之后
横幅还要显示满 15 分钟。

**修复（2026-11-12）**：横幅接上 `contextAcp` 投影的 `lastAt`（= 最近一次
`compaction/summary` 的 `event.time`，毫秒）。

```
lastAt >= nudge.at  →  已响应 → 蓝色「已压缩 · 4 秒后自动收起」+ 倒计时条 → 自动写
                       sessionStorage 并消失（不用点 ×）
lastAt <  nudge.at  →  未响应 → 照旧琥珀色「建议压缩」，常驻（那才需要人处理）
```

三个容易踩的点：

1. **时间单位**：`event.time` 是 `Date.now()` 毫秒。别处同名时间可能是秒级 epoch，
   客户端用 `toEpochMs()` 归一（`< 1e11` 视为秒），不归一会差 1000 倍 → 永远判"没压过"。
2. **不能拿旧压缩冒充**：必须 `lastAt >= at`。会话里本来就有历史压缩，直接看
   `lastAt > 0` 会让第一次 nudge 就立刻显示"已压缩"。
3. **倒计时条要 `position:relative` + `overflow:hidden`** 的父容器，否则 2px 的条
   从圆角里溢出来。

**门禁**：`node tools/tests/acp-nudge-banner.mjs`（node:vm 里真渲染组件 + 假时钟
推进，证明 3.9 秒还在、4 秒后没了）；`acp-client.mjs` 另外断言这套逻辑真的进了
**编译后的 bundle**（5 个标记），因为"源码对、产物被摇掉"是另一类静默失败。

> ⚠️ 写这类测试时**必须把 `Date` 也塞进 vm sandbox**。只假 `setTimeout` 不假
> `Date.now()`，组件会拿真实时间跟固定的 nudge 时间比，一律判成过期 → 渲染
> `null`，你会以为修复没生效（本次实测踩过）。

### 8.19 Uptime Kuma 大版本升级（1.x → 2.x）与两个静默坑

**背景**：2026-11-17 把 VPS 的 Kuma 从 `1.23.16` 升到 `2.5.11`。
2.x 是重写版，**心跳表要聚合成新格式**，官方要求：备份 data、中途不能中断、
断了只能回滚重来。

**别信 npm 的 `latest`**：`npm view uptime-kuma version` 当时给的是
`2.0.0-dev.0`（开发预发布）。正确来源是 GitHub releases：

```bash
curl -s "https://api.github.com/repos/louislam/uptime-kuma/releases?per_page=5"   | python3 -c "import json,sys;[print(r['tag_name'], r['prerelease']) for r in json.load(sys.stdin)]"
```

**官方 `setup` 脚本会跑 vite build —— 这台 1.6 GB 的机器不建议**。
2.x 的 release 附带预构建前端 `dist.tar.gz`，用官方这两步就够了：

```bash
cd /opt/uptime-kuma
npm ci --omit dev --no-audit --no-fund   # 约 1.5 分钟，node_modules 约 260 MB
npm run download-dist                     # 流式解包到 ./dist，约 8 分钟
```

**升级配方（可回滚）**：

```bash
TS=$(date +%Y%m%d-%H%M%S); BK=/root/kuma-backup-$TS; mkdir -p "$BK"
systemctl stop uptime-kuma
tar czf "$BK/kuma-data.tar.gz" -C /opt/uptime-kuma data   # 8.6 MB
mv /opt/uptime-kuma /opt/uptime-kuma.1.23.16               # 旧版留着，回滚就是换回来
tar xzf /tmp/kuma-2.5.11.tar.gz -C /tmp && mv /tmp/uptime-kuma-2.5.11 /opt/uptime-kuma
cp -a /opt/uptime-kuma.1.23.16/data /opt/uptime-kuma/data
cd /opt/uptime-kuma && npm ci --omit dev --no-audit --no-fund && npm run download-dist
systemctl start uptime-kuma
journalctl -u uptime-kuma -f     # 盯着 "Aggregate Table Migration Completed"
```

**实测**：6 个监控 / 17673 条历史心跳，迁移 **17 秒**完成。
迁移后 `heartbeat` 表只剩近期的 3130 条（旧的聚合进
`stat_minutely/stat_hourly/stat_daily`），这是 **2.x 的正常优化，不是丢数据**。
判据：3 张 `stat_*` 表有数据、6 个监控名字不变、新心跳还在长。

**回滚**：`systemctl stop uptime-kuma && mv /opt/uptime-kuma /opt/uptime-kuma.2.5.11
&& mv /opt/uptime-kuma.1.23.16 /opt/uptime-kuma && systemctl start uptime-kuma`。
**必须同时还原 data**（从 `$BK/kuma-data.tar.gz`），因为 2.x 已经改过表结构。

**2.x 破坏性变更（会踩到的）**：
- **JSON 备份/恢复被移除**，只剩"备份 data 目录"这一种方式；
- 邮件通知模板改用 LiquidJS：变量**区分大小写**，不匹配的变量**静默忽略**
  （以前自定义正则替换的模板会悄悄变成空白，务必核对告警正文）；
- Node 最低 20.4（本机 20.19.5 OK）；
- 徽章接口的 `:duration` 只接受 `24`/`24h`/`30d`/`1y` 这类写法。

### 8.20 `[ -x ]` 判可执行位 —— 一个没人发现的静默失败

**症状**：Kuma 里 `VPS 健康` 推送监控从 11-17 起报
`push down: ❌ git 镜像 150h 未更新`，而备份本身一直是好的。

**根因**：`restic-backup.sh` 里这段：

```bash
if [ "$rc" -eq 0 ] && [ "$#" -eq 0 ]; then
  MIRROR="$HOME/.../ops/backup/git-mirror-push.sh"
  if [ -x "$MIRROR" ]; then "$MIRROR" || echo "⚠️ ..." ; fi   # ← 这里
fi
```

`git-mirror-push.sh` 在 git 里记录的是 **`100644`（不可执行）**、磁盘也是
`-rw-------`，于是 `[ -x ]` 为假，镜像推送被**静默跳过**，从 11-11 冻结 6 天。

**修法**（两层都做）：

```bash
# 1) 判断改用 -f + bash，不再依赖可执行位
if [ -f "$MIRROR" ]; then bash "$MIRROR" || echo "⚠️ git 镜像失败" >&2; fi
# 2) 文件本身补上可执行位并让 git 记录
chmod 755 ops/backup/git-mirror-push.sh
```

**教训**：**退出码位/`-x` 不可靠**（`cp`、`tar`、编辑器、checkout 都可能丢）。
判"这个脚本能不能跑"应该看"文件在不在"，然后用解释器显式执行。
同类风险也在 `vps-restic-*.sh`（它们是 `100644`，但目前都由 `bash xxx.sh` 调用，没事）。

**判据**：`cat /srv/git-mirror/.last-run` 的时间应当和最近一次备份同一档；
健康推送日志出现 `push up: git 镜像 0h 前`。

### 8.21 界面空壳、`N required entries did not activate` = 客户端模块清单缺包

**症状**（2026-11-24 升级 `0.2.2-rc.5` 实测）：服务端起来了、页面能开，但界面只剩空壳：

```
dsh: warning: 2 required entries did not activate
@deepseek-ai/dsh-client-ui-sidebar (required): pending (waiting for service: uiWorkspace)
@deepseek-ai/dsh-client-ui-chat (required): pending (waiting for services: uiWorkspace,
                                              uiConversation, sidebarRight, fileDrag)
…二十多条 pending
```

`/api/web/listProviders` 返回 404，供应商路由面板空。

**根因**（2026-11-26 更正 —— 之前这节记反了）：`dsh-web-app` bundle 插入的
`ui-context-menu` / `ui-file-drag` 两行**没有进到浏览器端的 client manifest**
（实测 **79**，正常 **83**），于是提供 `contextMenus` / `fileDrag` 服务的模块不存在，
所有依赖它们的插件永远 pending。

**这个坑是我们自己造的**：2026-11-24 我们误以为"这两行没生效"，于是在 bundle patch 里
加了 4 行（同 id + 同名、没有 `insert:`，见 `cc9017b`）。按 loader 的 patch 方言：

> **只有 `insert:` 能新增行。** 带 `id` 且没有 `insert` 的 patch **定位已存在的行**，
> 提供的字段替换该行字段；一个真值 `name` 只是**断言**已有插件名 —— 不改名，更不插入；
> 匹配不到任何行就告警跳过。

那 4 行正好命中了上游 `dsh-web-app` 已经插入的行，等于给它们盖了个"已被 patch"的章，
于是它们从 client manifest 里消失。**把那 4 行整段删掉即恢复**（`b78f69e`，79 → 83）。

**为什么极难发现**：host 启动日志 **0 warning**（补丁"成功应用"了）、
`--dump-config` 里两行**照样打印**、所有服务端接口**一切正常**。
唯一能暴露它的是浏览器端**真正收到的模块清单**。

**判据**（优先用守卫测试，不用开浏览器）：

```bash
node tools/tests/client-manifest.mjs     # 正常：83 条、两个模块在列、id 不重复
```

服务没起时它会明确跳过并 exit 0，不会误报。手工版（F12 → Console）：

```js
const u = performance.getEntriesByType('resource').map(e=>e.name).filter(x=>x.includes('/plugins/'));
const mods = new Set(); for (const x of u){const q=x.split('??')[1]; if(q) for(const p of q.split(',')) mods.add(p.split('&')[0]);}
({count: mods.size, ctx: u.join().includes('context-menu'), drag: u.join().includes('file-drag')})
```

正常：`{count: 83, ctx: true, drag: true}`。`count` 变少就是缺模块，别先怀疑缓存。

**修法**：

```bash
# 1) 确认 patch 里没有那 4 行（有就删掉；不需要任何替代补丁）
grep -n 'ui-context-menu\|ui-file-drag' playground/themes/dsh-guava-pack/cordis.patch.yml
# 2) 重启 host，再跑守卫
systemctl --user restart dsh.service
node tools/tests/client-manifest.mjs
# 3) 浏览器硬刷新一次（Ctrl+Shift+R）：坏掉的客户端图会粘在标签页里
```

**别再补回来**：要新增挂载行只有一种写法 —— 写进 `- insert:`。那 4 行已在
`b78f69e` 整段删除；`6c227d0` 又把文件里"等价于补插"的错误注释一并清了。

**事故档案（2026-11-26）**：另一台机器照着**旧版** `ops/UPGRADE-DSH.md` 第 4 节
"同 id 同名重声明一遍"去升级，界面直接空壳，用 pi 修了半天。
真凶就是那段"修法"本身。修完后：`6c227d0` 重写第 4 节（4.1 成因 / 4.2 为什么难发现 /
4.3 判据 / 4.4 修法）、新增 `tools/tests/client-manifest.mjs` 并接进 `npm test`。

**教训（两条，都要记住）**：

1. **`--dump-config` 里有这一行 ≠ 浏览器里加载了这个模块。** 组合层 / 激活层 / 客户端层
   是三件事：`check-boot.mjs` 只看启动日志 + 端口，**天生看不见 client manifest**。
2. **检查器不能给"不认识的行"开绿灯。** 事故里 `install.mjs --check` 曾把多出来的 2 行
   称作"上游 id 的 **兼容补丁**"并打 ✅ —— 这句放行话本身把错误固定成了"正常"。
   现在改成硬断言：顶层 `- id:`（不在 `insert:` 里）一律判红，并点名本节。

**判据**：`node tools/check-boot.mjs` → 「运行态正常」；
`~/dsh/logs/web-run.log` 最后一段没有 `did not activate`。

---

### 8.22 会话全都打不开、`… never started` = 上游包 exports 漏发子路径

**症状**：点开任何已有会话 → 它从侧栏**消失**，输入框显示「会话不可用」。
WebSocket 帧里才是真话：

```
api-session/error: resume failed … RemoteError: tool-subagent-list-agents
  (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started
```

**根因**：`@deepseek-ai/dsh-tool-subagent-control@0.2.2-rc.5` 的发布产物自相矛盾 ——

```
lib/index.js                  ← 有
lib/types/list-agents.d.ts    ← 有（类型声明发了）
lib/types/list-agents.js.map  ← 有（sourcemap 发了）
lib/list-agents.js            ← 没有 ✗   ← 真正被 import 的那个
exports["./list-agents"]      ← 没有 ✗
```

`files` 白名单漏配，`.js` 被排除而它的 `.d.ts` / `.js.map` 留下了。
**`0.2.3-alpha.2` 一模一样，所以升 alpha 修不了。**（同一个包里 `wait-agent` 也漏了
`lib/types/wait-agent.js`，只是暂时没人 import 才没炸。）

**判据**（两秒）：

```bash
tar tzf <(curl -sS https://registry.npmjs.org/@deepseek-ai/dsh-tool-subagent-control/-/dsh-tool-subagent-control-0.2.2-rc.5.tgz) \
  | grep '^package/lib/'
node --input-type=module -e "import('@deepseek-ai/dsh-tool-subagent-control/list-agents').then(m=>console.log('OK',Object.keys(m))).catch(e=>console.log('FAIL',e.code))"
```

**修法**：用**同版本 src** 编译一份 `lib/list-agents.js` 塞进去，再补 `exports` 条目。
本仓库已做成幂等补丁：

```bash
bash playground/themes/dsh-guava-pack/patches/apply-subagent-list-agents.sh
# 或在升级后统一：node playground/themes/dsh-guava-pack/install.mjs --patch
```

产物在 `patches/vendor/subagent-control-list-agents.js`（esbuild 从同版本
`src/list-agents.ts` 编出来）。上游一旦自带该文件与 exports 条目，脚本自动跳过。

**教训**：**类型声明发了，不代表运行时产物发了。** `.d.ts` 能骗过 `tsc`、骗过所有
静态检查，骗不过一次 `import()`。以后核对上游包，除了看 `exports` 键，还要
`tar tzf` 确认 `exports` 指向的文件**真的在包里**。

**判据**：`node tools/check-boot.mjs` 绿；连点两个会话都留在列表里、标题跟着变。

---

### 8.23 Node 连 Cloudflare 端点报 ETIMEDOUT、curl 却 200 —— 是 IPv6 自动选族

**症状**（2026-11-25）：同一台机器、同一个 URL ——

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://openrouter.ai/api/v1/models   # 200
node -e 'fetch("https://openrouter.ai/api/v1/models").then(r=>console.log(r.status))'
#   → TypeError: fetch failed，cause: ETIMEDOUT（545ms 就死）
```

`opencode.ai` 同样，而且**时好时坏**（8 次里成功 5 次），最容易被当成"网络抖动"。

**根因**：这台 WSL 只有 Tailscale 的 ULA（`fd7a:…`）、**没有 IPv6 默认路由**，
而 Cloudflare 托管的这两家同时有 A 和 AAAA。Node 默认 `autoSelectFamily: true`
（happy eyeballs）会并发试两族 —— IPv6 立刻 `ENETUNREACH`，聚合后整体抛
**ETIMEDOUT**。curl 的 happy eyeballs 实现正确，所以完全不受影响。
于是就有了最有误导性的组合：**curl 通、node 不通**。

**判据**（10 秒内定位）：

```bash
ip -6 route show default        # 空 → 没有 v6 默认路由，这就是前提
node -e 'require("node:net").connect({host:"openrouter.ai",port:443}).on("error",e=>console.log("auto:",e.code)).on("connect",()=>console.log("auto: ok"))'
node -e 'require("node:net").connect({host:"openrouter.ai",port:443,family:4}).on("error",e=>console.log("v4:",e.code)).on("connect",()=>console.log("v4: ok"))'
# 期望：auto: ETIMEDOUT / v4: ok
```

实测（8 次连续 `GET /models`）：

| | openrouter | opencode |
|---|---|---|
| 默认（autoSelectFamily 开） | **0/8** | 5/8 |
| `--no-network-family-autoselection` | 8/8 | 8/8 |

**修法**（两处都要，各管一段）：

```bash
# ① DSH 本体：启动器 ~/dsh/dsh 里，exec node 之前（幂等 + 能力探测，老 Node 不会因此起不来）
case " ${NODE_OPTIONS:-} " in
  *--no-network-family-autoselection*) ;;
  *) node --no-network-family-autoselection -e '' 2>/dev/null &&
       export NODE_OPTIONS="${NODE_OPTIONS:-} --no-network-family-autoselection" ;;
esac
```

```js
// ② 工具：tools/lib/model-config.mjs 入口（同步工具与定时任务都 import 它）
net.setDefaultAutoSelectFamily?.(false)
```

`--dns-result-order=ipv4first` **不够**：它能救 opencode，救不了 openrouter（实测仍 0/8）。

**教训**：**「curl 通、node 不通」先怀疑 happy eyeballs / 双栈，别怀疑代理和证书。**
另一个容易误判的点：`ETIMEDOUT` 只花了 545ms —— 真正的 SYN 超时是秒级，
这么快的超时说明是「选错了地址」，不是「路上丢包」。

---

### 8.24 同一把 key 存两处 —— `.bashrc` 的旧副本把凭证库盖住了

**症状**：同步工具对某家一律「探测失败 / 401」，但 DSH 里同一个模型跑得好好的。

**根因**：key 有三个来源，优先级错了就会拿错那份：

| 顺序 | 来源 | 谁在用 |
|---|---|---|
| 1 | `process.env` | 启动器注入、手动 export |
| 2 | `<DSH_HOME>/.credentials.yaml` 的 `refs:` | **DSH 运行时（真正生效的那份）** |
| 3 | `~/.bashrc` 的 `export NAME=…` | 桥接、定时任务、同步工具 |

启动器 `~/dsh/dsh` 先 `eval` `.bashrc` 的 `*_API_KEY`，再跑
`tools/export-provider-keys.mjs` 把凭证库整段导出 —— **后者覆盖前者**。
所以 DSH 里生效的永远是凭证库那份；而工具只读 `.bashrc`。

2026-11-25 实测：`.bashrc` 的 `OPENROUTER_API_KEY`（74 字符）是旧的，
`/auth/key` 返回 401 `User not found`；凭证库那份（73 字符）返回 200。
于是工具一直在用废 key 探测，报"探测失败"，看着像网络问题。

**修法**：`tools/lib/model-config.mjs` 的 `resolveProviderKey()` 按
**env → 凭证库 → .bashrc** 取，与运行时对齐。旧名 `envFromBashrc` 保留为别名。

**判据**：

```bash
node --input-type=module -e 'const {resolveProviderKey}=await import("./tools/lib/model-config.mjs");
console.log("len:", resolveProviderKey("OPENROUTER_API_KEY")?.length)'
# 与凭证库里那份一致（本机 73），不是 .bashrc 里那份（74）
```

**教训**：**同一份密钥存两处，一定会漂。** 要么只留凭证库、把 `.bashrc` 那行删掉；
要么让所有读方走同一个函数。顺手检查：`.bashrc` 里凡是 `*_API_KEY` 都该和凭证库核对一遍。

---

### 8.25 profile 挂着旧副本、改 pack 却不生效（bundle 收敛，2026-11-27）

**症状**：改 `dsh-guava-pack/plugins/*` 没反应；同样的改动改 `playground/themes/<旧副本>` 才生效。
`~/.cursor` 里没有任何报错 —— 因为 profile 的 `bundles` 压根没指向 pack。

**本机曾经的形态**：profile `bundles` = 11 个，依赖 9 条 `link:`，其中 7 条指向
`playground/themes/<旧插件>`；只有 `dsh-context-acp` / `dsh-opencode-session-header` 指向 pack。

**收敛做法**（= 别的机器 3.9 已经做过的）：

```yaml
# profiles/web/package.json
"dependencies": {
  "dsh-context-acp": "link:.../dsh-guava-pack/plugins/dsh-context-acp",   # preset 要 `dsh-context-acp/engine`
  "dsh-guava-pack": "link:.../dsh-guava-pack"
},
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-guava-pack"
] } }
```

```bash
cd ~/dsh/profiles/web && pnpm install          # 生成 node_modules/dsh-guava-pack 链接
~/dsh/dsh --profile web --dump-config > after.yml   # 与迁移前逐条对比，别只看"能起来"
```

**四个坑**（本机 2026-11-27 全踩过）：

1. **旧副本里可能有 pack 没有的本地改动** —— 切换即丢。本机就是：google 的三处修复
   （query 保真 / catalog 回落 / providers.json）只存在于旧副本。**先收回 pack，再切 bundle。**
2. **手工起的旧 daemon 会占着 8318**：`start.sh` 的 `--force` 才会按端口接管，否则新 daemon
   `EADDRINUSE` 起不来；更阴的是面板写 pack 的 `mode.json`、旧 daemon 读旧的 →
   **开关静默不生效**。重启前先 `kill $(cat <旧目录>/router.pid)`。
3. **判断"谁在跑"只看端口和日志**：`ls -l playground/themes/*/router.log` 与
   `dsh-guava-pack/plugins/provider-router/router.log` 谁的 mtime 新，就是谁在写；
   `--dump-config` 里插件行的 `name:` 也会直接指出实际路径。
4. **归档不删除**：旧目录 `mv` 到 `playground/themes/.archive-20261127/`，观察一周再删；
   同时清掉 profile `node_modules` 里未声明的 8 个旧 symlink。

**验收**：`dump-config` 顶层条目数/ id 集合与迁移前一致；`client-manifest` 83；
router 日志里的 `providers:` 列表包含该有的上游；UI 面板里供应商都在。

---

### 8.26 antigravity（8045 桥接）报 `Connection failed, please check your network` —— 它自己要过 SSR

**症状**：`http://127.0.0.1:8045/v1/models` 返回 **200**（桥接活着），但
`/v1/chat/completions` 返回 **500**，正文是 Antigravity Tools 自己的：

```
Stream collection error: Connection failed, please check your network or proxy settings
fn=collect_stream_to_json ... raw=Stream interrupted before completion
```

**根因**：8045 是 **Antigravity Tools（Windows 侧）**，它自己出墙需要上游代理；配置项在
`%USERPROFILE%\.antigravity_tools\gui_config.json`：

```json
"proxy": { "upstream_proxy": { "enabled": false, "url": "" } }
```

默认是**关的**。DSH 这一跳（WSL → 127.0.0.1:8045）是本地回环，通不通和 SSR 无关；
真正要过 SSR 的是**桥接→Google/Anthropic 的那一跳**。

**修法**：

```json
"upstream_proxy": { "enabled": true, "url": "http://127.0.0.1:2080" }
```

改完**必须重启 Antigravity Tools**（配置在启动时读进内存，热改不生效）。
本机 SSR 在 Windows 侧监听 2080，Windows 上 `curl -x http://127.0.0.1:2080 https://www.google.com/generate_204` → 204。

**验证**（用桥接的 key 直接打，不进 DSH）：

```bash
curl -s -m 30 http://127.0.0.1:8045/v1/chat/completions \
  -H "Authorization: Bearer $ANTIGRAVITY_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"ok"}],"max_tokens":5}'
# 2026-11-27 实测：claude-sonnet-5-5 / gemini-3.8-flash-tiered / gemini-3.1-flash-image → 200
#               gemini-3.8-flash(→flash-high) / gemini-4-carbon → 仍 500（上游流中断，与代理无关）
```

**教训**：**删 `~/.antigravity_tools` 等于把它的代理设置一起删了**（11-25 清理时踩的）。
只删日志/缓存放着不动；要清就先把 `gui_config.json` 里的 `upstream_proxy` 抄下来。
另外：DSH 的 router **不要**给 antigravity 配上 8318 —— router 对 loopback 强制直连，
而且 SSR agent 只包 https，配了也不会生效，只会误导后来人。

---

### 8.15 排查顺序（省时间的模板）

```
① 看告警消息本身（ntfy 里那条写了具体原因，别跳过）
② VPS 能进吗 → 不能：第 3 节（先查 iptables 顺序）
③ bash /usr/local/sbin/dsh-doctor.sh --short   → 24 项，直接指出 ❌
④ 是 PC 侧问题吗 → 控制台 :8090 的状态卡 / systemctl --user status <unit>
⑤ 改了什么就回滚什么，别叠加多个变更
⑥ 修完把新坑写回这一节
```
