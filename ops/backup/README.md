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
| 看某快照里有什么 | `rk ls latest /home/guava5tar_/dsh/sessions` |
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

## 恢复（最常用的部分）

```bash
rk ls latest /home/guava5tar_/dsh/sessions | head

# 恢复到临时目录（不要直接覆盖生产目录！）
rk restore latest --target /tmp/restore --include '/home/guava5tar_/dsh/sessions'

# 只恢复单个文件
rk restore latest --target /tmp/restore --include '/home/guava5tar_/dsh/profiles/web/cordis.yml'
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
3. 恢复**永远先到 `/tmp`**，确认无误再覆盖。
