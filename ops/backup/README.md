# restic 备份速查

仓库：`rest:http://100.109.125.37:3000/dsh/`（VPS 上 rest-server，**append-only** + basic auth）
密码：仓库加密口令在 `~/.restic-pass`；HTTP 认证口令在 `~/.restic-repo-url`（600，含 URL，别提交）

> 2026-11-11 变更：从 `sftp:root@…` 换成 rest-server。
> 好处：PC 只能**追加**，即使 PC 被入侵/中招，也删不掉已有历史快照（append-only，服务端 403）。
> 代价：**prune / forget 不能在 PC 上跑**，统一由 VPS 侧 `restic-prune.service` 直接操作仓库目录。

```bash
cd ~/dsh/playground/themes/dsh-guava-pack
alias rk='bash ops/backup/restic-ctl.sh'   # 可选，装个短名字
```

## 常用命令

| 想做什么 | 命令 |
|---|---|
| 看有哪些快照 | `rk snapshots` |
| 看某快照里有什么 | `rk ls latest --host MSI /home/guava5tar_/dsh/sessions` |
| 仓库统计（压缩率、去重收益） | `rk stats` |
| 完整性校验（只读，本地跑） | `rk check` |
| 对比两个快照 | `rk diff <id1> <id2>` |
| 删一个快照（**自动转到 VPS 执行**） | `rk forget <id>` |
| 删并回收空间 | `rk forget <id> --prune` |
| 只回收未引用数据 | `rk prune`（触发 VPS 的 oneshot，日志直接回显） |
| 清理陈旧锁 | `rk unlock`（在 VPS 上执行） |

## 定时任务

| 位置 | 单元 | 时间 | 做什么 |
|---|---|---|---|
| PC | `dsh-backup.timer` | 每日 03:30 | `restic-backup.sh`；成功后顺带 `git-mirror-push.sh` |
| VPS | `restic-lock-janitor.timer` | 每日 03:00 | 清理 >30 分钟的陈旧锁（早于备份） |
| VPS | `restic-prune.timer` | 每月 1 日 04:30 | `restic prune`（只回收，不 forget，保留全部快照） |
| VPS | `restic-check.timer` | 每周日 05:00 | `restic check --read-data-subset=2%` |
| VPS | `dsh-backup-freshness.timer` | 每 6 小时 | 最新快照 >26h → ntfy 报警 |

> **PC 上原来的 `dsh-prune.timer` 已作废**（append-only 会拒绝）。卸载：
> `systemctl --user disable --now dsh-prune.timer && rm ~/.config/systemd/user/dsh-prune.{service,timer}`

## ⚠️ 两台机器共用一个仓库：恢复必须区分机器

两台 PC（`YGY12` 主力 / `MSI`）备份进**同一仓库、同一路径**（`/home/guava5tar_/dsh`）、
同一用户名 `guava5tar_`、同一 tag（`dsh-nightly`），所以 `latest` 指的是
「**所有机器**里最新的那一份」，而且**不报错、静默命中另一台**：

```text
# 2026-11-12 实测（两台都快照在库）
$ restic restore latest --target /tmp/rtest --include '/nonexistent'
restoring snapshot 4acb333f ... by guava5tar_@YGY12      ← 本想恢复 MSI，静默给了 YGY12
#（补标后新 ID；当时输出的是 152c638e，restic tag 重写快照后失效）
```

### 两种区分方式（都可用，推荐 tag）

| 方式 | 用法 | 说明 |
|---|---|---|
| **机器 tag**（推荐） | `--tag host-msi` | `restic-backup.sh` 自 2026-11-12 起自动打 `host-<短主机名小写>`；与主机名大小写无关，最稳 |
| restic `--host` | `--host MSI` | 取备份时的 hostname；历史快照也有效 |

```bash
# 只看本机 / 只恢复 MSI
restic snapshots --tag host-ygy12
restic restore --tag host-msi latest --target /tmp/restore-msi --include '/home/guava5tar_/dsh/profiles'

# 用封装脚本时同理
bash ops/backup/restic-ctl.sh restore --tag host-msi latest --target /tmp/restore-msi
```

其他两条规则：

- `restic snapshots --latest n` 是**每个 host 各 n 条**，不带过滤会列出多台；
- 历史快照已全部补标：**13/13 条都带 `host-*`**（2026-11-12 在 VPS 侧完成，
  append-only 下客户端改不了快照元数据）。

> ⚠️ `restic tag` 会**重写快照文件 → 短 ID 变化**。历史快照补标后旧短 ID 全部失效，
> 引用过旧 ID 的笔记/脚本要一起更新。

## 恢复（最常用的部分）

```bash
rk ls latest --host MSI /home/guava5tar_/dsh/sessions | head

# 恢复到临时目录（不要直接覆盖生产目录！）
rk restore latest --host MSI --target /tmp/restore --include '/home/guava5tar_/dsh/sessions'

# 只恢复单个文件
rk restore latest --host MSI --target /tmp/restore --include '/home/guava5tar_/dsh/profiles/web/cordis.patch.yml'
```

## 手动补一次备份

```bash
systemctl --user start dsh-backup.service --no-block   # 必须 --no-block，否则前台等
journalctl --user -u dsh-backup.service -n 30 --no-pager | grep -E 'snapshot|processed'
```

## git 裸镜像（防 GitHub 侧出事）

每日备份成功后，`git-mirror-push.sh` 把这两个仓库 `push --mirror` 到 VPS：

- `/srv/git-mirror/dsh-guava-pack.git`
- `/srv/git-mirror/dsh-theme-cyberpunk2077.git`

手动跑：`bash ops/backup/git-mirror-push.sh`（成功后写 `/srv/git-mirror/.last-run`，
VPS 健康自检会在 48h 未更新时报警）。

> 为什么由 PC 推：VPS → github.com 的 TLS 链路偶发 `GnuTLS recv error (-110)`，
> 重试也常失败；PC 侧访问 GitHub 稳定且已有免密 SSH 到 VPS。

## 回滚到旧 sftp 仓库（应急）

sftp 路径仍然可读（root 不受权限影响）：

```bash
RESTIC_REPOSITORY='sftp:root@100.109.125.37:/srv/backup/dsh' rk snapshots
```

## 三条铁律

1. **密码丢了 = 数据永久丢失**（仓库是加密的；VPS 上那份口令只是给 prune 用，不改变这一点）；
2. **定期做一次恢复演练**——没恢复过的备份不叫备份；
3. 恢复**永远先到 `/tmp`**，确认无误再覆盖；
4. 恢复**永远带 `--host`**（两台共用一个仓库，`latest` 会静默串台）。

## 第二台（pack 不在 `~/dsh` 下的机器）怎么启用

`dsh-backup.service` 里的 `ExecStart` 写的是第一台布局
（`<DSH_HOME>/playground/themes/dsh-guava-pack/...`）。pack 在别处时**本机单元要改路径**，
共享脚本不用动：

```bash
# 1) 二进制与凭证（口令从 VPS 取，别手抄）
mkdir -p ~/.local/bin
#   restic 0.17.3（与 VPS 同版本）
curl -fsSL -o /tmp/restic.bz2 \
  https://github.com/restic/restic/releases/download/v0.17.3/restic_0.17.3_linux_amd64.bz2
bunzip2 -f /tmp/restic.bz2 && install -m 755 /tmp/restic ~/.local/bin/restic
ssh root@100.109.125.37 'cat /etc/restic/repo-password' > ~/.restic-pass && chmod 600 ~/.restic-pass
#   rest: URL 含 rest-server 的 basic auth
printf 'rest:http://%s:%s@100.109.125.37:3000/dsh/\n' \
  "$(ssh root@100.109.125.37 'cut -d: -f1 /etc/rest-server/htpasswd')" \
  "$(ssh root@100.109.125.37 'cat /etc/rest-server/password')" > ~/.restic-repo-url
chmod 600 ~/.restic-repo-url

# 2) 单元（把 ExecStart 换成本机 pack 真实路径）
#    ~/.config/systemd/user/dsh-backup.service  ExecStart=<pack>/ops/backup/restic-backup.sh
#    ~/.config/systemd/user/dsh-backup.timer    同 pack 里的定义
systemctl --user daemon-reload
systemctl --user enable --now dsh-backup.timer

# 3) 首跑（可临时取消限速，仓库 dedup 后通常只需几十 MiB）
RESTIC_LIMIT_KB=0 <pack>/ops/backup/restic-backup.sh
```

**实测（2026-11-12，MSI）**：首跑 296 MiB 逻辑 / 97 MiB 实存，用时 1:28；
仓库里出现 `host=MSI` 的快照，`restic ls latest --host MSI` 能列出 profile 与 sessions
（两台都在库里之后，不带 `--host` 的 `latest` 见上面「⚠️」那节）。
注意 `dsh-backup.service` 里的 git 镜像步骤指向第一台路径，本机不存在时会静默跳过（无害）。
