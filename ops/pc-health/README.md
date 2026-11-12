# PC 侧健康自检（每台 PC 一条 Kuma push 监控）

## 为什么需要

Kuma 从**外部**探 `http://VPS:<REMOTE_PORT>/go`，只能发现「隧道 + 入口反代 + DSH 整体挂掉」。
如果 **DSH 自己崩了而入口反代还在**，外部探测仍然 302（反代只是转发 3080），告警不会响。
所以每台 PC 上再跑一个内部自检，每 15 分钟 push 一次。

## 检查项

| 项 | 地址 | 期望 |
|---|---|---|
| DSH 本体 | `127.0.0.1:3080/` | 200/401 |
| commandcode 桥接 | `127.0.0.1:8317/v1/models` | 200（未启用则跳过）|
| 供应商路由代理 | `127.0.0.1:8318/health` | 200（未启用则跳过）|
| 中继入口反代 | `127.0.0.1:3098/go` | 302/401（未接入则跳过）|
| VPS 上的本机隧道 | `http://VPS:<REMOTE_PORT>/go` | 302/401 |
| 根分区使用率 | `df /` | < 90% |

任一异常 → push `down` 并在消息里列出具体项（手机 ntfy 直接看到原因）。

## 两台机器的对应关系

| 机器 | VPS 端口 | Kuma 监控名 | 令牌变量 |
|---|---|---|---|
| 主力机 | 22022 | `PC 健康 (主力 22022)` | `KUMA_PUSH_PC_MAIN` |
| 第二台（MSI）| 22023 | `PC 健康 (MSI 22023)` | `KUMA_PUSH_PC_MSI` |

## 安装（在要监控的那台 PC 上跑）

```bash
# 1) 在 VPS 上取该机专属令牌（root）
ssh root@100.109.125.37 'grep KUMA_PUSH_PC_MSI /etc/kuma/push-tokens.env'
#   主力机换成 KUMA_PUSH_PC_MAIN

# 2) 在 PC 上安装（幂等；会自动装 timer 并立刻自检一次）
cd <pack 目录>
bash ops/pc-health/install.sh --token <上一步的令牌> --remote-port 22023
#   主力机 --remote-port 22022
```

`install.sh` 会：写 `~/.config/dsh/pc-health.env`（600）→ 按**本机 pack 真实路径**生成
`dsh-pc-health.service` → 装 `dsh-pc-health.timer`（每 15 分钟）→ `enable --now` → 立刻跑一次。

## 验证

```bash
systemctl --user list-timers dsh-pc-health.timer      # NEXT 应在 15 分钟内
systemctl --user status dsh-pc-health.service         # 上次结果
bash ops/pc-health/dsh-pc-health.sh                   # 手动跑，打印 up/down 与原因
```

Kuma 里对应监控应为 UP，消息形如
`正常：DSH/桥接/路由/入口/隧道 均可达，磁盘 5%`。
