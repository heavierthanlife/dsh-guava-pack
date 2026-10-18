# 双机同步（两台 Windows + 各自 WSL 里的 dsh）

> ## ⚠️ 2026-10-19 重大变更：`dsh-home` 远端已废弃
>
> `heavierthanlife/dsh-home` 这个 GitHub 仓库**已被删除**（`git push` 报
> `ERROR: Repository not found`），用户决定**不再重建**。
>
> **现在的同步载体只有本包 `heavierthanlife/dsh-guava-pack`**：
> - **进仓库的**：`plugins/`（8 个插件，含 provider-router / dsh-context-guard）、
>   `services/`、`ops/`（本文档 + NETWORK-NOTES + PROVIDER_ROUTING_PLAN）、
>   `machine/`、`config/`、`patches/`、`tools/`、`install.mjs`
> - **不进仓库、机器本地**：`~/dsh` 的其余部分 —— 启动器、`profiles/`、`sessions/`、
>   `attachments/`。这些**没有远端备份**了，换机只能重装 dsh + 重配 profile。
>
> 下方原文中凡提到「`~/dsh` 是 git 仓库 / 用 `dsh-sync` 同步 / 新机器 `git clone ~/dsh`」
> 的段落，**均已失效**，请按本条为准。

> 真相源：**本机（第一台）2026-10-06 的状态**为起始版本。
> 同步载体：~~GitHub 私仓（`~/dsh` 本身就是一个 git 仓库）~~ → **`dsh-guava-pack`**（见上）。
> 日常只用一条命令：`~/dsh/dsh-sync`

## 1. 三类清单（这就是"无遗漏"的边界）

### A. 进仓库（跟着 git 走）
| 路径 | 说明 |
|---|---|
| `dsh` `restart-dsh.sh` `tailnet-url.sh` `dsh-sync` `bootstrap-machine.sh` | 启动器与运维脚本 |
| `package.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` | 根依赖（dsh 本体版本锁在这里） |
| `profiles/**`（`*.yml` / `package.json` / `pnpm-lock.yaml`） | 组合配置：provider、模型、插件挂载、主题、子代理授权 |
| `profiles/*/cordis.patch.yml` | **dsh 的"设置 UI"实际改的就是它** |
| `playground/themes/**` | 自己写的插件：theme-manager / dsh-mobile-ui / provider-router / commandcode-bridge / dsh-theme-plugin |
| `playground/themes/dsh-theme-cyberpunk2077` | **submodule**（独立仓库，有自己的 GitHub 远端） |
| `sessions/` `attachments/` | 会话历史（15M + 2.9M） |
| `systemd/dsh.service` `machine/*.example` | 服务单元与机器配置模板 |
| `SYNC.md` `playground/themes/PROVIDER_ROUTING_PLAN.md` | 文档（**都在仓库里，跟着 git 走**） |

### B. 不进仓库，另一台重建
`node_modules/`（525M）、`profiles/*/node_modules/`
→ `pnpm install`（root + `profiles/web`）；`pnpm-lock` 变了 `dsh-sync` 会自动装。

### C. 不进仓库，每台各做一次（机器绑定）
| 项 | 做法 |
|---|---|
| provider keys（7 把） | 手动填进 `~/.bashrc`，模板见 `machine/bashrc.dsh.example` |
| WSL systemd | `/etc/wsl.conf`（`machine/wsl.conf.example`）→ `wsl --shutdown` |
| dsh 服务 + 开机自起 | `bootstrap-machine.sh` 自动装 `dsh.service` + `loginctl enable-linger` |
| Node ≥ 22.19 / pnpm / `command-code` CLI | 同上 |
| Tailscale + `tailscale serve` | Windows 侧各自配；`--trusted-host` 由启动器按 MagicDNS 自动推导 |
| **SSR / 本地代理端口** | **每台不同**：在 `~/.bashrc` 里 `export DSH_SSR_PROXY=http://127.0.0.1:<port>`（第一台 2080，MSI 2099）。`provider-router` 与 `commandcode` 桥都读它；启动器会把 `DSH_*` 从 `.bashrc` 载入（**systemd 起 dsh 时不读 .bashrc**，所以必须靠启动器那段 eval） |

### D. 明确排除（运行时状态 —— 跨机覆盖只会互相打架）
`logs/`、`*.pid`、`*.out`、`storages/`（投影缓存，可重建）、
`profiles/*/.plugin-manager/logs/`、`playground/themes/provider-router/mode.json`（路由选择，见下）

### E. 排除的敏感 / 大体量
| 路径 | 原因 | 代价 |
|---|---|---|
| `.credentials.yaml` | 内含 browser-session **签名密钥** | 新机器上手机需重输一次 token |
| `playground/witcher/`（36M） | 用户像素画项目，不是 dsh 状态 | 自己另管 |

## 1.5 远端仓库

| 仓库 | 用途 | 可见性 | 状态 |
|---|---|---|---|
| `https://github.com/heavierthanlife/dsh-guava-pack.git` | **本包**：插件 + 服务 + 运维文档 | private | ✅ 唯一同步载体 |
| `https://github.com/heavierthanlife/dsh-theme-cyberpunk2077.git` | 赛博主题 submodule 的**镜像** | private | ✅ 保留 |
| ~~`https://github.com/heavierthanlife/dsh-home.git`~~ | ~~整个 `~/dsh` 快照~~ | private | ❌ **2026-10-19 已删除，不再重建** |

**为什么主题是镜像**：本机可用的 GitHub 凭证属于 `heavierthanlife`，而主题上游
`Tommy00748/dsh-theme-cyberpunk2077` 对该账号**只有 pull 权**（`permissions.push=false`），推不上去。
所以镜像到同账号私有仓，并把 `Tommy00748` 保留为 `upstream` remote：

```bash
# 日后若要用 Tommy00748 推回上游（拿到该账号凭证后）
cd playground/themes/dsh-theme-cyberpunk2077
git push upstream main                     # 推回原仓库
git remote set-url origin https://github.com/Tommy00748/dsh-theme-cyberpunk2077.git   # 想改回上游就改这行
cd ../.. && sed -i 's#heavierthanlife/dsh-theme-cyberpunk2077#Tommy00748/dsh-theme-cyberpunk2077#' .gitmodules
git submodule sync && git commit -am "chore(submodule): 指回上游" && git push
```

**凭证**：本机用 Windows 侧 Git Credential Manager（`D:\Git\mingw64\bin\git-credential-manager.exe`）
作助手，已**仅对这两个仓库**设了 repo-local `credential.helper`（没改全局）；token 存在 Windows 凭据管理器里，
**不在仓库/不落明文**。第二台机器上 private 仓库（含 submodule）同样需要一次 GitHub 认证。

## 2. 新机器（第二台）首次上线

```bash
# Windows 侧：wsl --install / 进 Ubuntu，确认用户名建议也用 guava5tar_
git clone <GitHub 私仓地址> ~/dsh          # 或：DSH_REPO_URL=... ~/dsh/bootstrap-machine.sh
cd ~/dsh && ./bootstrap-machine.sh
# 它做：/etc/wsl.conf(systemd) → Node/pnpm/command-code → submodule →
#       pnpm install ×2 → 检查 7 把 key → 装 dsh.service + linger → 自检
```
`bootstrap-machine.sh` 里 sudo 步骤会**逐个问**，不会静默动系统。

## 3. 日常：换机只用一条命令

```bash
~/dsh/dsh-sync      # pull → submodule → (必要时 pnpm install) → 修权限 → 重启服务 → 打印访问地址
```

**纪律（重要）**：`sessions/` 是 append-only 的文本，**同一时间只在一台机器上写**。
换机前先 `dsh-sync`，另一台不要同时开着 dsh 写同一会话。
不想守这条纪律，就把 `.gitignore` 里 `sessions/` 放开注释 → 两台各自记历史（代价：历史不连续）。

## 4. 已知坑（会静默漏掉的那类）

1. **绝对路径 / 用户名**：`profiles/*/package.json` 是 `link:/home/guava5tar_/dsh/...`，
   `systemd/dsh.service`、`restart-dsh.sh` 也是绝对路径。
   → **两台建议同用户名**。真不同名，`bootstrap-machine.sh` 会 sed 改写（代价：本机工作区变脏，`dsh-sync` 会拒绝 pull）。
2. **赛博主题是 submodule**：它的改动要在**它自己的仓库**里 commit+push，父仓库只会记录 commit 号。
   父仓库里看到 `modified: .../dsh-theme-cyberpunk2077` 时，用 `git -C playground/themes/dsh-theme-cyberpunk2077` 处理。
3. **`mode.json`（路由 direct/SSR）不同步** → 新机器是默认映射（只有 `agentrouter=ssr`）。
   想让它也同步：把 `.gitignore` 里那一行删掉。
4. **token 每次启动都变**，别收藏带 token 的 URL：用 `./tailnet-url.sh` 或 UI「设置 → 连接信息」。
5. **`.credentials.yaml` 不要乱点 UI 的"删除 <provider>"**（该文件同时存着 cookie 签名密钥，清了所有设备都要重登）。
6. **新机器上 WSL 会把 Windows 的 node/npm 透传进来**（PATH 里 `/mnt/d/.../NodeJS/npm` 排在 `/usr/bin` 前面）：
   症状是 `node -v` 看着正常，但 `npm i -g` 装进了 `C:\Users\...`，`pnpm` 永远找不到。
   **判据**：`node -p 'process.execPath'` 必须是 `/usr/bin/node` 这类 Linux 路径；
   `npm prefix -g` 不能是盘符。`bootstrap-machine.sh` 已内置这两个检查，并强制使用
   **Linux node 旁边的 npm**（`$(dirname $(command -v node))/npm`）。
   若 `/usr/bin/npm` 不存在（Ubuntu 的 `nodejs` 包不含 npm）→ `sudo apt-get install -y npm`。
7. **新机器怎么拿 pnpm（三档自动降级）**：`bootstrap-machine.sh` 依次尝试
   ① corepack（Linux node 旁边那个；关掉交互提示、跟随 registry，**能钉到 `packageManager` 的 11.21.0**）
   ② npm 用户前缀（改完**验证真的可写**才算成功，否则放弃）
   ③ 兜底 `sudo npm i -g`（会问一次）。
   失败的典型信号：`npm i -g` 报 `EACCES ... /usr/local/lib/node_modules`（前缀没改成）。
   手工救急：`sudo /usr/bin/npm i -g pnpm@11 --registry=https://registry.npmmirror.com`
8. **apt 装的 npm 9.2.0（Ubuntu resolute）有两个坑**（MSI 上实测）：
   - `npm config set ...` **不写 `~/.npmrc`**，`prefix` 也改不动 → `npm i -g` 仍写 `/usr/local` 报 EACCES。
     对策：用环境变量 `npm_config_registry` / `npm_config_proxy` / `npm_config_https_proxy`（优先级高于配置文件），
     或直接 `sudo /usr/bin/npm i -g <pkg> --registry=https://registry.npmmirror.com`。
   - **corepack 不可用**：它的 shim 在 Node 22 上 `pnpm -v` 正常但 `pnpm install` 崩
     （`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`），而且会盖住 `/usr/local/bin/pnpm`。
     `bootstrap-machine.sh` 现在会主动删除 `~/.local/bin/{pnpm,pnpx}` 里的 corepack shim。
9. **`HANDOFF.md` 已不存在**（2026-10-04~06 之间删掉的，`~/dsh/` 与 `D:\ZZZArea\` 两处都没了）：
   现行文档 = 本文件 + `playground/themes/PROVIDER_ROUTING_PLAN.md`，**都在仓库内**，不用再手动同步副本。
