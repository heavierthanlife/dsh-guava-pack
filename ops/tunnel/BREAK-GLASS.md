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

**症状**：在主力机上 `restic ls latest` / `restore latest`，列出的 / 恢复出的内容
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

### 8.15 排查顺序（省时间的模板）

```
① 看告警消息本身（ntfy 里那条写了具体原因，别跳过）
② VPS 能进吗 → 不能：第 3 节（先查 iptables 顺序）
③ bash /usr/local/sbin/dsh-doctor.sh --short   → 24 项，直接指出 ❌
④ 是 PC 侧问题吗 → 控制台 :8090 的状态卡 / systemctl --user status <unit>
⑤ 改了什么就回滚什么，别叠加多个变更
⑥ 修完把新坑写回这一节
```
