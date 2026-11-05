# restic 备份速查

仓库：`sftp:root@100.109.125.37:/srv/backup/dsh`（加密，密码在 `~/.restic-pass`）
封装脚本：`ops/backup/restic-ctl.sh`（省掉每次敲 `-o sftp.args` 与环境变量）

> SSH 已收口到 tailnet（公网 22 由 VPS 侧 iptables 丢弃），仓库地址用 100.109.125.37。

```bash
cd ~/dsh/playground/themes/dsh-guava-pack
alias rk='bash ops/backup/restic-ctl.sh'   # 可选，装个短名字
```

## 常用命令

| 想做什么 | 命令 |
|---|---|
| 看有哪些快照 | `rk snapshots` |
| 看某快照里有什么 | `rk ls latest` / `rk ls latest /home/guava5tar_/dsh/sessions` |
| 仓库统计（压缩率、去重收益） | `rk stats` |
| 完整性校验（每月一次足够） | `rk check` |
| 对比两个快照 | `rk diff <id1> <id2>` |
| 删一个快照 | `rk forget <id>` |
| 删并回收空间 | `rk forget <id> --prune` |
| 只回收未引用数据（不删快照） | `rk prune`（2026-11-05 实测 833M → 562M） |

自动回收：`dsh-prune.timer` 每月 1 日 04:30 跑一次 `restic prune`（不补跑；备份定时器只备份）。
| 清理陈旧锁 | `rk unlock` |

## 恢复（最常用的部分）

```bash
# 1) 先看清要什么
rk ls latest /home/guava5tar_/dsh/sessions | head

# 2) 恢复到临时目录（不要直接覆盖生产目录！）
rk restore latest --target /tmp/restore --include '/home/guava5tar_/dsh/sessions'

# 3) 确认内容没问题后，再挑需要的拷回来
ls -la /tmp/restore/home/guava5tar_/dsh/sessions | head

# 只恢复单个文件
rk restore latest --target /tmp/restore --include '/home/guava5tar_/dsh/profiles/web/cordis.yml'
```

`--include` 用快照内的绝对路径（就是备份时的原始路径）。不带 `--include` 会恢复整份 800MB。

## 日常

- 定时：`dsh-backup.timer` 每天 03:30（`Persistent=true`，错过补跑）；
- 手动补一次：`systemctl --user start dsh-backup.service --no-block`（**必须带 `--no-block`**，否则终端等到跑完）；
- 看最近一次结果：`journalctl --user -u dsh-backup.service -n 30 --no-pager | grep -E 'snapshot|processed'`。

## 三条铁律

1. **密码丢了 = 数据永久丢失**（仓库是加密的，VPS 上也没有密码）；
2. **定期做一次恢复演练**——没恢复过的备份不叫备份；
3. 恢复**永远先到 `/tmp`**，确认无误再覆盖，避免把好的数据盖坏。
