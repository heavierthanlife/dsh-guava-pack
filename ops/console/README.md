# DSH Console — VPS 统一图形入口

一台 Debian 12 VPS 上的单页控制台：手机 / 平板 / PC 打开一个页面，就能进 DSH、看监控、
看推送、传文件，并查看整机状态、安全地触发固定运维动作。

- 监听：**`100.109.125.37:8090`**（只绑 tailnet，不监听 `0.0.0.0`，公网 EIP 不开端口）
- 认证：HTTP Basic，用户名 **`dsh`**，口令随机生成于 VPS `/etc/dsh-console/password`（600 root）；
  另有**一键登录令牌** `/etc/dsh-console/token`：访问 `http://100.109.125.37:8090/?k=<token>`
  会种一个 HttpOnly cookie（30 天）后跳到首页，手机/平板不用手打口令（Basic 仍然可用）
- 依赖：仅 Node.js 20 标准库（**无 npm 包**），静态页由 `server.mjs` 同目录的 `index.html` 提供
- 仓库内**不含任何明文口令**；口令只存在于 VPS 的 `/etc/dsh-console/password`

## 文件清单

| 位置 | 内容 |
|---|---|
| `ops/console/server.mjs` | 单文件 Node HTTP 服务：Basic 认证、`/api/status` 采集、`/api/action` 白名单动作 |
| `ops/console/index.html` | 单页 UI（中文、移动优先、无外部 CDN/字体，内联 CSS/JS） |
| `ops/console/install.sh` | 幂等安装 / 升级脚本 |
| `ops/console/README.md` | 本文件 |

VPS 侧安装后的路径：

| 路径 | 说明 |
|---|---|
| `/opt/dsh-console/server.mjs` | 服务代码（root:root 0644） |
| `/opt/dsh-console/index.html` | 页面 |
| `/opt/dsh-console/README.md` | 本文件副本（systemd `Documentation=file:` 指向它） |
| `/etc/dsh-console/password` | 首次安装生成，600 root；**升级时绝不覆盖** |
| `/etc/dsh-console/token` | 一键登录令牌（32 位 hex，600 root）；删除/改内容后 `systemctl restart dsh-console` 即作废旧链接 |
| `/etc/systemd/system/dsh-console.service` | 单元（`Restart=always`，root + 沙箱） |
| `/var/cache/dsh-console/restic` | 控制台自己读 restic 快照用的缓存（restic:restic 0750） |

## 一键登录（手机/平板）

```bash
sudo cat /etc/dsh-console/token
# 浏览器打开： http://100.109.125.37:8090/?k=<令牌>
```

令牌以 cookie 形式记住 30 天；换设备/清 cookie 后重新点一次链接即可。
URL 里带令牌，注意别把链接截图发到公开地方；要作废就重写 token 文件并重启服务。
若 Windows 浏览器因为公司 VPN/代理访问不到 `100.x`，在 WSL 里 `systemctl --user enable --now
console-forward.service`（见 `../tunnel/console-forward.service`），然后打开 `http://localhost:8090`。

## 为什么服务以 root 运行

题面允许在 README 说明选择。这里的取舍是：

- 需求要求页面上的按钮执行 `systemctl start restic-prune.service` 之类 **systemd oneshot**，
  并以 `runuser -u restic` 只读查询仓库。非 root 进程要做这两件事，只能引入
  **passwordless sudo 规则**；而单元同时要求 `NoNewPrivileges=yes`，`sudo` 属于 setuid
  提权，会被 NNP 直接挡住。二者不可兼得。
- 走 root 时，攻击面靠下面这些约束收窄，而不是靠用户降权：
  - 动作是**编译期硬编码的四个对象**（`prune` / `check` / `unlock` / `doctor`），
    请求里只传动作名，严格 `hasOwnProperty` 校验，**任何情况下都不拼接 shell**；
  - 全部命令用 `execFile(绝对路径, 固定参数)` 执行，不经 `/bin/sh`；
  - `ExecStart=/usr/local/bin/node /opt/dsh-console/server.mjs` 固定，页面不提供上传、
    不提供任意静态文件读取、不接受命令参数；
  - systemd 沙箱：`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、
    `PrivateTmp`、`PrivateDevices`、`ProtectKernel*`、`RestrictAddressFamilies`、
    `ReadWritePaths=/var/cache/dsh-console`（唯一可写路径）；已实测在该沙箱内
    `systemctl start/journalctl/runuser+restic/apt-get -s/du` 均正常；
  - 仅 tailnet 可达，且被 Basic 认证整体包住；没有公网暴露面。
  - 针对 1.6 GB 内存的小机器，单元里设 `NODE_OPTIONS=--max-semi-space-size=2`
    压小 V8 新生代，降低常驻 RSS（预算 60 MB）。
- 另外仍按要求创建了系统用户 `dsh-console`（`--system --no-create-home --shell nologin`），
  它不被服务使用；如未来改为 sudo 方案，可直接复用这个账号。**注意**：改为非 root 时
  必须同时移除 `NoNewPrivileges` 或改用 polkit，不能只改 `User=`。

## 安装 / 升级 / 回滚

```bash
# 安装或升级（同一命令，幂等）
scp -F /dev/null ops/console/{server.mjs,index.html,install.sh,README.md} root@100.109.125.37:/tmp/dsh-console/
ssh -F /dev/null root@100.109.125.37 'bash /tmp/dsh-console/install.sh'

# 只改页面/代码后升级：重跑 install.sh 即可（口令保持不变，服务 restart）
ssh -F /dev/null root@100.109.125.37 'bash /tmp/dsh-console/install.sh'

# 回滚（只删除本服务：单元 + 程序；口令文件留着，重建时沿用）
ssh -F /dev/null root@100.109.125.37 '
  systemctl disable --now dsh-console.service
  rm -f /etc/systemd/system/dsh-console.service
  systemctl daemon-reload
  rm -rf /opt/dsh-console
'
# 彻底清理（连口令一起删，之后重装会生成新口令）
#   rm -rf /etc/dsh-console /var/cache/dsh-console
```

- 安装脚本不会碰 rest-server / uptime-kuma / ntfy / miniserve / sshd / tailscaled，
  不会执行 `git commit`，也不会重启 DSH。
- 口令轮换：`rm /etc/dsh-console/password && bash install.sh`，或直接
  `printf '%s\n' '新口令' > /etc/dsh-console/password && chmod 600 ... && systemctl restart dsh-console`。
  服务**启动时读取一次**口令，改文件后必须 restart。

## 页面内容

1. **入口卡**：DSH 主力机（`:22022/go`）、DSH 第二台（`:22023/go`，未监听自动置灰并标注）、
   监控面板（`:3001`）、推送服务（`:8080`，附 ntfy App/topic 提示）、文件中转（`:8081`）。
   其中 miniserve 已改为**令牌路径**入口（根路径 `/` 返回 404），页面不硬编码前缀：
   服务端每次采集状态时读取 `/etc/miniserve/env` 的 `PREFIX`，生成 `…:8081/<PREFIX>/`
   完整链接；读不到或格式异常时卡片显示「未配置」并不可点击。PREFIX 不写日志、不显示文本。
2. **状态区**（15s 自动刷新，失败保留旧数据并安静提示）：
   - 6 个 systemd 服务：tailscaled / ssh / rest-server / uptime-kuma / ntfy / miniserve
   - 磁盘使用率、内存可用量、load 1/5/15、主机 uptime
   - 隧道探测：`100.109.125.37:22022|22023` 的 `/go`，3 秒超时，显示 HTTP 状态码或「未监听 / 超时」
     （sshd 的 `GatewayPorts clientspecified` 只绑 tailnet 地址，`127.0.0.1` 不通）
   - restic：快照数、最新快照时间与距今小时数、仓库大小、锁数量（>0 红色警告）
   - git 镜像：`/srv/git-mirror/.last-run` 距今小时数（>48h 红色）
   - 待装安全更新数（`apt-get -s` 模拟，5 分钟缓存，超时/失败降级）
3. **操作区**（每个按钮 `confirm()` 二次确认；POST `/api/action`，服务端白名单）：
   执行结束后回显 stdout / stderr / 退出码，systemd 动作额外回显**最后 30 行 journal**。

## 动作白名单

| 动作 | 服务端实际执行 | 超时 | 说明 |
|---|---|---|---|
| `prune` | `systemctl start restic-prune.service` | 120s | oneshot，可能几十秒到数分钟；超时后单元仍在后台跑，页面会提示看 journal |
| `check` | `systemctl start restic-check.service` | 120s | 同上，`--read-data-subset=2%` |
| `unlock` | `systemctl start restic-lock-janitor.service` | 60s | 只清 >30 分钟的陈旧锁 |
| `doctor` | `/usr/local/sbin/dsh-doctor.sh --short` | 30s | 只读诊断，rc=0 即健康 |

动作串行执行：已有动作在跑时再提交返回 `409`。动作响应里 `locksAfter` 是执行后
`/srv/backup/dsh/locks` 的文件数，便于确认没有把锁留下。

## API

- `GET /api/status` → JSON，主要字段：
  `services.items[]`（name/state/active）、`disk`、`memory`、`load`、`uptimeSec`、
  `tunnels.items[]`（port/listening/status/ms/error）、
  `restic`（`snapshots` / `latest` / `latestAgeHours` / `sizeBytes` / `locks` / `error`）、
  `gitmirror`（`at` / `ageHours`）、`security`（`count` / `stale`）、
  `miniserve`（`ok` / `url`，url 为令牌路径完整链接，前缀只来自 `/etc/miniserve/env`）、
  `busy`。
  状态在服务端缓存 8 秒；apt 计数另缓存 5 分钟。
- `POST /api/action`，必须同时满足：
  `Content-Type: application/json`、请求头 `X-Requested-With: dsh-console`（CSRF）、
  body 为 `{"action":"prune|check|unlock|doctor"}`，且 `Origin`（若存在）必须是本服务地址。
  返回动作结果 JSON（HTTP 200，`ok` 表示 rc==0；超时/失败时 `ok=false` 并带原因）。

只读采集的细节：restic 用
`runuser -u restic -- env RESTIC_REPOSITORY=/srv/backup/dsh RESTIC_PASSWORD_FILE=/etc/restic/repo-password RESTIC_CACHE_DIR=/var/cache/dsh-console/restic restic snapshots --no-lock --json`
（**必须 `--no-lock`**，不会在仓库里留锁）。

## 安全设计

- 只 `listen(PORT, "100.109.125.37")`，代码里没有 `0.0.0.0`；可用 `ss -ltn` 复核。
- 所有路径（含 `/api/*`、`/favicon.ico`）都要求 Basic；未认证一律 `401` +
  `WWW-Authenticate: Basic realm="DSH Console", charset="UTF-8"`。
- 用户名/口令拼接后做 SHA-256，再用 `crypto.timingSafeEqual` 常量时间比较。
- 校验 `Host` 头（仅 tailnet IP / localhost），防 DNS rebinding；动作额外校验 CSRF 头和 Origin。
- 日志只写 stdout：请求行、`auth failed`、动作名/rc/耗时/锁数；**从不记录口令或 Authorization 头**。
- 响应头：`CSP`（无外部资源）、`nosniff`、`DENY` frame、`no-store`。
- 页面所有动态内容用 `textContent` 渲染（journal/命令输出不会被当作 HTML 执行）。

## 已知限制

- **HTTP 而非 HTTPS**：tailnet 链路本身由 WireGuard 加密；Basic 口令在 tailnet 内是明文，
  不要在不可信设备或非 tailnet 网络上使用。浏览器会明文缓存凭据直到关闭。
- 服务以 root 运行（理由见上）；一旦 Node 进程本身被攻破，防护只剩 systemd 沙箱。
- `systemctl start` 的 120s 是**等待上限**，不是任务上限：prune/check 超过 120s 时页面显示
  超时，但服务端 oneshot 会继续跑完（单元自己的 `TimeoutStartSec` 是 3600/7200）。
- 状态每 15s 刷新，但服务端有 8s 缓存、apt 有 5 分钟缓存，所以安全更新数字不会秒级变化。
- `:22023` 的探测结果是「此刻是否监听」；第二台 PC 未开隧道时卡片置灰，属预期。
  探测走 tailnet 地址（`100.109.125.37`）而不是 `127.0.0.1`，因为 sshd 的反向隧道
  只绑 tailnet 地址。
- 既有 `/var/cache/restic` 目录在本机实际不存在，`restic-prune/check` 会打印一条 cache
  警告（不影响执行）。为不改变既有服务行为，本控制台使用**独立**缓存目录
  `/var/cache/dsh-console/restic`。
- 页面没有「停止/重启其他服务」能力，也没有任意命令执行；这是刻意的。
- 旧口令文件若含空白字符，服务拒绝启动（启动日志会说明）。

## 手机怎么打开

1. 手机安装 **Tailscale**，登录同一个 tailnet（`dsh-relay`）。
2. 浏览器打开 **`http://100.109.125.37:8090`**。
3. 弹出登录框：用户名 `dsh`，口令从 VPS 取：
   `ssh -F /dev/null root@100.109.125.37 'cat /etc/dsh-console/password'`
   （iOS/Android 的密码管理器可记住）。
4. 建议「添加到主屏幕」，全屏使用；页面无外部资源，弱网也能开。

## 本机快速验证

```bash
BASE=http://100.109.125.37:8090
PASS='<从 VPS 取>'

curl -s -o /dev/null -w 'no-auth   %{http_code}\n' "$BASE/"
curl -s -o /dev/null -w 'bad-pass  %{http_code}\n' -u dsh:wrong "$BASE/"
curl -s -o /dev/null -w 'good-pass %{http_code}\n' -u "dsh:$PASS" "$BASE/"
curl -s -u "dsh:$PASS" "$BASE/api/status" | head -c 800; echo
curl -s -u "dsh:$PASS" -H 'Content-Type: application/json' \
  -H 'X-Requested-With: dsh-console' -d '{"action":"doctor"}' "$BASE/api/action"
```
