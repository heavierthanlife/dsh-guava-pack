# 新机器从零重建清单（REBUILD）

> 适用：换新电脑 / WSL 被删 / 系统重装。
> 目标：**只靠这份文档 + 密码管理器里的 key + restic 快照**，把一台机器恢复成和现在一样。
> 顺序不要跳：每一步的产物是下一步的前提。

---

## 0. 先决条件（你需要手上有）

| 东西 | 在哪 |
|---|---|
| GitHub 账号权限（`heavierthanlife` 私仓） | 浏览器已登录 |
| Tailscale 账号 | 能登录，且**新机器要加入同一个 tailnet** |
| 各家 provider key | **密码管理器**（见 `ops/SECRETS-INVENTORY.md`） |
| restic 仓库口令 | `~/.restic-pass`（新机上没有 → 从密码管理器或旧机取） |
| restic 仓库 URL | `~/.restic-repo-url`（同上） |
| VPS 的 root SSH 权限 | 通过 tailnet（公网 22 已被 iptables 关闭） |

---

## 1. Windows 侧

1. **装 WSL2 + Ubuntu**
   ```powershell
   wsl --install -d Ubuntu
   ```
   用户名建议用 **`guava5tar_`**（两台机器同名能省掉一堆路径改写）。

2. **开启 systemd**：编辑 `\\wsl$\Ubuntu\etc\wsl.conf`
   ```ini
   [boot]
   systemd=true
   [user]
   default=guava5tar_
   ```
   然后 `wsl --shutdown` 再进。

3. **装 Tailscale**（Windows 版），登录同一账号，记下本机的 MagicDNS 名。

4. **装 SSR / 本地代理**，记下端口（主力机 2080、MSI 2099）。

5. **配开机自启**（让 WSL 常驻、不用开窗口）：
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-wsl-autostart.vbs`

   ```vb
   ' 登录时静默拉起 WSL（sleep infinity 让发行版常驻）
   Set sh = CreateObject("WScript.Shell")
   sh.Run "C:\Windows\System32\wsl.exe -d Ubuntu --exec /bin/sh -c ""sleep infinity""", 0, False
   ```

   > ⚠️ **必须存成 UTF-16LE + CRLF**。用 Linux 工具写成 UTF-8 + LF 时，
   > VBScript 会把第 3 行并进上一行注释，登录时报
   > `缺少对象: 'sh'`（错误码 800A01A8）。这不是代码错，是换行符/编码错。
   > 检查：`file xxx.vbs` 应显示 `UTF-16, little-endian text, with CRLF line terminators`。

---

## 2. WSL 侧

```bash
# 2.1 Node ≥ 22.19（不要用 Windows 透传进来的 node！）
node -p 'process.execPath'      # 必须是 /usr/bin/node 这类 Linux 路径
# 若指向 /mnt/d/...，先修 PATH，再重来

# 2.2 pnpm
sudo apt-get install -y npm
sudo /usr/bin/npm i -g pnpm@11 --registry=https://registry.npmmirror.com

# 2.3 取插件包（唯一同步载体）
mkdir -p ~/dsh && cd ~/dsh
git clone git@github.com:heavierthanlife/dsh-guava-pack.git playground/themes/dsh-guava-pack

# 2.4 装 dsh 本体 + 依赖
cd ~/dsh/playground/themes/dsh-guava-pack
# 按 README 的「安装」一节装 dsh 0.2.1-rc.5，然后：
node install.mjs --patch          # 给 node_modules 打三处补丁（幂等）

# 2.5 恢复 profiles / sessions（用 restic，必须带 --host！）
#     见第 4 节
```

---

## 3. 机器绑定配置（不进 git，每台各做一次）

### 3.1 `~/.bashrc`

```bash
export DSH_HOME="$HOME/dsh"
export DSH_TAILNET_HOST="<本机 MagicDNS 名>.ts.net"
# SSR 端口每台不同；不写会回落到默认 2080（在 MSI 上是错的）
export DSH_SSR_PROXY="http://127.0.0.1:2080"      # MSI 用 2099

# provider key（从密码管理器逐条填）
export AGENTROUTER_API_KEY="..."
export ANTIGRAVITY_API_KEY="..."
export OPENCODE_GO_API_KEY="..."
export XIAOMI_TOKEN_PLAN_CN_API_KEY="..."
export COMMANDCODE_API_KEY="..."                   # 见 SECRETS-INVENTORY 的注意事项
```

### 3.2 `~/dsh/.credentials.yaml` 的 `refs:` 段

启动器会用 `tools/export-provider-keys.mjs` 把这里导出成环境变量，**并覆盖 `.bashrc` 的同名值**。
`OPENROUTER_API_KEY` / `NVIDIA_API_KEY` 只在这里。

> ⚠️ 同一把 key 不要在两处写不同值——会让人排查时看错源头。

### 3.3 systemd 用户服务

```bash
mkdir -p ~/.config/systemd/user
cp ~/dsh/playground/themes/dsh-guava-pack/ops/{dsh,dsh-entry,dsh-remote-entry}.service ~/.config/systemd/user/
cp ~/dsh/playground/themes/dsh-guava-pack/ops/{model-policy.service,model-policy.timer} ~/.config/systemd/user/
# dsh-tunnel / console-forward / dsh-pc-health 按各目录 README 安装（含端口参数）

systemctl --user daemon-reload
systemctl --user enable --now dsh.service dsh-entry.service dsh-remote-entry.service \
                             dsh-tunnel.service console-forward.service \
                             model-policy.timer dsh-backup.timer dsh-pc-health.timer
loginctl enable-linger "$USER"      # 没有它，注销后服务会停
```

> ⚠️ `model-policy.timer` **不要**写 `After=dsh.service`：会和 `basic.target` 形成 ordering
> cycle，systemd 破环时可能把 dsh 的启动 job 删掉（症状：开机 dsh 不自启）。
> 顺序约束放在 `model-policy.service` 上。

### 3.4 restic 备份

```bash
# 从旧机/密码管理器取两个文件，权限 600
chmod 600 ~/.restic-pass ~/.restic-repo-url
bash ops/backup/restic-ctl.sh snapshots    # 能看到快照就对了
```

---

## 4. 从快照恢复（**必须带 `--host`**）

两台机器备份到**同一个仓库、同一个路径、同一个用户名**，只有 `host-<主机名>` 标签能区分。

```bash
# 先看本机有哪些快照
bash ops/backup/restic-ctl.sh snapshots | grep host-<你的主机名小写>

# 恢复 profiles（先到临时目录，别直接覆盖）
bash ops/backup/restic-ctl.sh restore latest --host <HOST> \
  --target /tmp/restore-drill \
  --include /home/guava5tar_/dsh/profiles

# 核对无误后再拷回去
rsync -a /tmp/restore-drill/home/guava5tar_/dsh/profiles/ ~/dsh/profiles/
```

**不带 `--host` 的 `latest` 会随机命中另一台的快照**（实测踩过）。

---

## 5. 验收

```bash
systemctl --user is-active dsh.service dsh-entry.service dsh-tunnel.service \
                             dsh-remote-entry.service console-forward.service
ss -ltn | grep -E ':(3080|8317|8318|3098|3099)'
bash ~/dsh/tailnet-url.sh                      # 手机入口地址
bash ~/dsh/playground/themes/dsh-guava-pack/ops/tunnel/check.sh 100.109.125.37
```

- VPS 上 `22022`/`22023` 对应本机的隧道端口，`ops/vps/` 的监控要在 Kuma 里新增一条
- 手机用 `http://100.109.125.37:<端口>/go` 打开

---

## 6. 常见坑（按踩到的顺序）

| 现象 | 真因 |
|---|---|
| 登录弹 `缺少对象: 'sh'` | VBS 存成了 UTF-8 + LF（见 1.5） |
| 开机 dsh 不自启 | `model-policy.timer` 的 `After=dsh.service` 造成 ordering cycle |
| 8317/8318 没起 | 它们由 `dsh web` 启动器拉起；dsh 停则全停。另：pack 路径找不到时会被静默跳过 |
| `pnpm` 找不到 / 装到了 Windows | WSL 把 Windows 的 node/npm 透传进了 PATH |
| `restic` 卡 8 秒后超时 | 交互式 shell 的 `HTTP_PROXY` 不认识 tailnet 的 100.x（脚本已内置 NO_PROXY） |
| 恢复出另一台的文件 | `restore latest` 没带 `--host` |
| agentrouter 报 `400 tool_use ids ...` | `node_modules` 补丁被 `pnpm install` 覆盖；跑 `node install.mjs --patch` |
