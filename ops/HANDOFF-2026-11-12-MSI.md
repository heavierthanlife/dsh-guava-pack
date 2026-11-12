# HANDOFF — 2026-11-12 10:05（MSI / 第二台）

> 用途：开新会话时先读这一份，再按需读下面列出的文件。
> 产物全部已提交并推送到 `heavierthanlife/dsh-guava-pack`；HEAD 以 `git log -1` 为准
> （这份文档每轮都会追加一条提交，写死 SHA 一定过期）。

---

## 1. 这台机器是谁

| 项 | 值 |
|---|---|
| 主机名 | **MSI**（WSL2，Ubuntu 26.04，systemd 开启） |
| Windows 用户 | `YGY12` |
| `DSH_HOME` | `/home/guava5tar_/dsh` |
| guava pack | **`/home/guava5tar_/dsh-guava-pack`**（注意：**不在 `~/dsh` 里面**，与主力机布局不同） |
| GUI | `http://127.0.0.1:3080` |
| 中继入口（手机） | `http://100.109.125.37:22023/go`（VPS 端口 **22023**；主力机是 22022） |
| SSR 代理 | `http://127.0.0.1:**2099**`（主力机是 2080；`.bashrc` 里 `DSH_SSR_PROXY`） |
| 会话工作目录 | `/home/guava5tar_/dsh/playground/themes` |

**两台的关系**：各自独立的 DSH（不同会话/工作目录/插件状态），只共享 VPS 侧的
Kuma / ntfy / restic 仓库 / miniserve / 控制台(8090)。

---

## 2. 当前状态（2026-11-12 09:58 实测）

```
DSH            active，MainPID 4465（07:43:52 起，未重启），近 2h 错误行 0
dsh-remote-entry  active  本机 3098 反代
dsh-tunnel        active  VPS :22023
dsh-backup.timer  active  下次 11-13 03:35（Persistent + 随机 10 分钟）
dsh-pc-health.timer active 每 15 分钟（09:38 仍 up）
model-policy.timer active  下次 11-13 09:34（当日 09:34 已成功跑完）

端口 3080=401 8317=200 8318=ok(health) 3098=401
VPS 22022/go、22023/go 均 302
restic            12 个快照；MSI 与 YGY12 **同库同路径**（恢复必须带 --host，见待办 1）
Kuma              6 条监控全 active（5/6/7/8/9/10）；旧 id=2/3/4 已删
ntfy              端到端已验证：09:42 Kuma 判 down → 手机收到「HTTP Down」
```

Kuma 监控（VPS `100.109.125.37:3001`）：

| id | 名称 | 状态 |
|---|---|---|
| 8 | DSH /go (22023 MSI) | **UP** |
| 10 | PC 健康 (MSI 22023) | **UP** |
| 5 | DSH /go（主力机 22022） | **已恢复**（09:31 起 22022 与 22023 同时在听，均 302） |
| 9 | PC 健康 (主力 22022) | **UP**（09:11 起每 15 分钟有真实心跳，自检已装好） |
| 6 | DSH 备份新鲜度 | UP |
| 7 | VPS 健康 | UP |
| ~~2~~ / ~~3~~ / ~~4~~ | 旧监控：TCP Port / Ping / HTTP（都指向 22022） | **已删**（09:42；改库前备份 `kuma.db.bak-del-20261112-094248`） |

---

## 3. 本会话做了什么（都已推送）

### 3.1 拉取另一台的 75 个提交，修掉 3 个集成问题

1. **`context-acp` 起不来**：`Cannot find package '@deepseek-ai/dsh-tools'`。
   原因：pack 在 `~/dsh` **之外**，Node 向上找不到 `~/dsh/node_modules`。
   已在 pack 的 `package.json` 装好 `@deepseek-ai/dsh-{commands,compaction,compaction-basic,llm,tools}`。
2. **`model-policy.timer` 每次开机 inactive**：`After=dsh.service` 造成 ordering cycle，
   systemd 为破环删掉 timer 自己的 start job。已从 pack 源头移除该依赖（`760e22c`）。
3. **桥接从 pack 启动报 `ERR_MODULE_NOT_FOUND: undici`**：pack 补 `undici` 依赖。

### 3.2 供应商配置修正

| 供应商 | 修正 |
|---|---|
| `opencode-go` | `baseURL` 从错误的直连地址改回 `http://127.0.0.1:8318/opencode-go`（经路由代理）；移除写死的 `x-opencode-session`（由插件按会话注入） |
| `agentrouter` | `api` 从 `openai-completions` 改为 **`anthropic-messages`** —— 上游 OpenAI 兼容流**不发 finish_reason**，导致 `Stream ended without finish_reason`；Anthropic 协议正常返回 `stop_reason` |
| `commandcode` | `deepseek/deepseek-v4.1-flash` 的 `maxTokens` 384000 → **200000**（上游校验 `<=200000`） |

### 3.3 备份（本机此前完全没有）

- 装 `restic 0.17.3`（`~/.local/bin/restic`，与 VPS 同版本）
- 凭证：`~/.restic-pass`、`~/.restic-repo-url`（均 600，从 VPS 取，勿手抄）
- 单元：`dsh-backup.{service,timer}`，每天 03:30（Persistent + 随机 10 分钟）
- 仓库 append-only（VPS `rest-server --append-only`），本机只能追加
- 首跑：296 MiB 逻辑 / 97 MiB 实存，1:28

### 3.4 监控（两台对齐）

- **入口监控**：Kuma 新增 `DSH /go (22023 MSI)`（HTTP，60s）
- **PC 侧健康自检**：`ops/pc-health/` 新增脚本 + 安装器；每 15 分钟检查
  DSH/桥接/路由/入口反代/VPS 上本机隧道端口/磁盘，异常 push `down` 并带原因
- 为什么需要：外部探 `:22023/go`，DSH 死了入口反代照样 302，外部发现不了

### 3.5 平台修复

- **`mode.json` 三方统一**：`DSH_ROUTER_MODE_FILE`（启动器导出），否则面板开关切换不生效
- **启动器从 pack 拉起桥接与路由**（`GUAVA_PACK`），避免工作区旧副本覆盖
- **从 DSH 凭证库导出 provider key**：`tools/export-provider-keys.mjs` +
  `tools/run-model-policy.sh`，让桥接/定时任务也能拿到 key（用户把 key 填在凭证库而非 `.bashrc`）

### 3.6 本轮收尾（09:35–10:05）

- **Kuma 清理**：删掉 id=2（TCP Port）、id=3（Ping，实际 ping 的是 VPS 自己的公网 IP，
  纯噪声）、id=4（HTTP），三条语义与 id=5 重复，且都挂着 ntfy 通知 —— 真出故障会重复推送。
  改库前各留一份：`kuma.db.bak-20261112-094209`（改 id=4 前）、
  `kuma.db.bak-del-20261112-094248`（删除前）。
- **ntfy 端到端验证**：把 id=4 临时指向死地址 `http://100.109.125.37:9/`，Kuma 判 down 后
  经 ntfy 发布（`messages_published` 26→27，缓存里留下「HTTP Down [Uptime-Kuma]」，优先级 5），
  **手机收到**。该监控本就要删，所以不需要回滚。
- **共享仓库隐患**：实测 `restore latest` 不带 `--host` 会静默选中**另一台**的快照，
  已写进 `ops/backup/README.md`（新增 ⚠️ 节 + 铁律第 4 条）。

---

## 4. 重踩很贵的坑（务必先看）

1. **沙箱**：写 `/home/guava5tar_/dsh/playground/themes` 之外（`~/dsh-guava-pack`、`~/.config`…）
   必须带 `danger-full-access`，否则报 `Read-only file system` / EROFS ——
   **很容易误判成磁盘故障**。
2. **`pkill -f` 会杀掉自己**：命令行里含同样字符串时，连当前 shell 一起杀。
   用 `pgrep` 取 pid、或 `ss -lntp` 反查端口所属进程。
3. **`/tmp` 不跨 bash 调用保留**（每次调用是新沙箱），中间结果要放持久路径。
4. **pack 在 `~/dsh` 之外** → Node 解析不到 `~/dsh/node_modules`：
   任何 `@deepseek-ai/*` 或第三方依赖（如 `undici`）都必须在 **pack 自己的 node_modules** 里。
5. **WSL 关机 = 当前对话必断**（systemd 服务会随发行版停）。会话中断通常不是 DSH 崩。
6. **agentrouter 必须用 `anthropic-messages`**（见 3.2）。
7. **commandcode 的 `max_tokens` ≤ 200000**，而 opencode-go 允许 384000 —— 两家不能共用一个值。
8. **opencode-go 需要 `x-opencode-session`**，由插件 `dsh-opencode-session-header` 按会话注入，
   不要在 profile 里写死（会破坏 prompt cache 亲和性并泄露真实 session id）。
9. **`context-guard` 插件已被移除**（2026-11-06），handoff 逻辑并入 `session-purge`；
   现在 ACP 引擎是 `dsh-context-acp`（工具：`acp_status` / `compress` / `decompress` / `search_context`）。
10. **`cordis_inspect` 的 `input` 参数**：本版本传对象会被拒（`"input" must be an object`），
    **整个省略 `input` 字段**即可。
11. **DSH 的 bash 沙箱里 `systemctl --user` 必挂**：报
    `Failed to connect to user scope bus via local transport: No data available`
    （bwrap `--unshare-pid`，systemctl 解析不到总线对端 PID）。改用
    `busctl --user get-property org.freedesktop.systemd1 <单元对象> ...Unit ActiveState`、
    `journalctl --user`，或 `busctl --user list` 确认总线本身是好的。真实终端里 systemctl 正常。
12. **restic `latest` 跨机器静默串台**：两台共用仓库/路径/tag，不带 `--host` 的
    `restore latest` **不报错**，会命中另一台。恢复一律带 `--host YGY12|MSI`。
13. **VPS 反向进不来**：ygy12（主力机，tailscale `100.126.220.49`）对 VPS 的 22/3080/3098
    全部 closed，VPS 也没有它的密钥 —— 想查主力机只能请用户在那边跑命令。

---

## 5. 待办（按优先级）

本轮已收掉交接里的 3 条（见 3.6），剩下这些：

1. **⚠️ 共享仓库 `latest` 串台**（2026-11-12 实测）：两台同仓库、同路径（`/home/guava5tar_/dsh`）、
   同 tag（`dsh-nightly`），`restore latest` 不带 `--host` 会静默恢复成另一台
   （实测选中 YGY12 的 `152c638e`）。
   - 立刻可用：恢复一律 `--host YGY12` / `--host MSI`（已写进 `ops/backup/README.md` 的 ⚠️ 节）；
   - 根本修法（**未做**，用户计划自己做）：备份脚本加 `host-<主机名>` tag，别再靠 `latest` 猜来源。
2. **`~/dsh` 本地仓库（无 remote）有未提交改动**：`profiles/web/cordis.patch.yml` 里默认模型
   已切成 `commandcode/deepseek/deepseek-v4.1-flash`（maxTokens 200000 + 注释），这是**运行中的
   真实配置**却还没入库；该仓库只做本地历史，提不提交由用户定。
3. **`dsh-opencode-session-header` 的 MSI 侧端到端验证**（低优先）：`PENDING-VERIFICATION.md`
   里这条在主力机 2026-11-02 已验通过；本机没单独验，且当前默认模型是 `commandcode`，
   走不到 opencode-go，等要切回去之前验一次即可。
4. **`is-enabled` 要查 timer**：两个 timer 的 service 是 oneshot + `static`（无 `[Install]` 段），
   查 service 会误判成「没启用」。正确写法：
   `systemctl --user is-enabled dsh-backup.timer model-policy.timer`。

已不再是待办（本轮核实过）：

- 主力机 PC 健康自检：已装，Kuma id=9 自 09:11 起每 15 分钟有真实心跳；
- 主力机两个 timer：**都 enabled + active**；backup 排程 03:30 + `Persistent=true`，
  11-12 03:30 机器关着、09:09 开机补跑，属预期行为（不是坏了）；
- ntfy 端到端：09:42 实测手机收到；
- Kuma 旧监控：id=2/3/4 已删（交接里只提到 2/4，**漏了 id=3 Ping**，本轮一并清掉）。

---

## 6. 常用命令速查

```bash
# 服务
systemctl --user status dsh.service
systemctl --user restart dsh.service          # 改 profile / host 插件后必须
systemctl --user list-timers                  # 备份 / 健康 / 模型策略
# 沙箱里 systemctl --user 不可用 → 用总线直查
busctl --user get-property org.freedesktop.systemd1 /org/freedesktop/systemd1/unit/dsh_2eservice org.freedesktop.systemd1.Unit ActiveState

# 健康
bash ~/dsh-guava-pack/ops/pc-health/dsh-pc-health.sh    # 打印 up/down 与原因
curl -s -o /dev/null -w '%{http_code}\n' http://100.109.125.37:22023/go

# 备份
export PATH="$HOME/.local/bin:$PATH" RESTIC_PASSWORD_FILE="$HOME/.restic-pass"
export RESTIC_REPOSITORY="$(head -n1 ~/.restic-repo-url)"
restic snapshots --compact --group-by host      # 按机器分组（两台共库）
restic restore latest --host MSI --target /tmp/r --include '<路径>'   # 恢复必须带 --host
RESTIC_LIMIT_KB=0 ~/dsh-guava-pack/ops/backup/restic-backup.sh   # 手动立即备份

# 路由 / 桥接
curl -s http://127.0.0.1:8318/health
curl -s http://127.0.0.1:8317/v1/models | head -c 120
cat /home/guava5tar_/dsh/playground/themes/provider-router/mode.json

# 配置（运行中真实生效值）
cd ~/dsh && ./dsh --profile web --dump-config | less
```

---

## 7. 关键文件

| 文件 | 说明 |
|---|---|
| `~/dsh-guava-pack/ops/pc-health/` | PC 健康自检（脚本 + 安装器 + README） |
| `~/dsh-guava-pack/ops/backup/` | restic 备份脚本与 README（含第二台步骤） |
| `~/dsh-guava-pack/ops/vps/kuma-configure.py` | Kuma 监控项定义（6 条，含本机 22023 与 PC 健康） |
| `~/dsh-guava-pack/ops/REMOTE-ACCESS.md` | 中继/访问方式总说明 |
| `~/dsh-guava-pack/ops/PROVIDER_ROUTING_PLAN.md` | 供应商路由设计 + 全测矩阵 + 三个大坑 |
| `~/dsh/profiles/web/cordis.patch.yml` | **运行中的 profile**（改它之后必须重启 DSH） |
| `~/.config/systemd/user/` | dsh / remote-entry / tunnel / backup / pc-health / model-policy |
| `~/.config/dsh/pc-health.env` | PC 健康自检配置（含 Kuma 令牌，600） |
| 桌面备份 | `C:\Users\YGY12\Desktop\dsh-profile-*.tar.gz`（含 README 恢复步骤） |
