# dsh-session-purge

清理**已归档会话**的记录，只保留工作产出品。

## 先说结论：自带没有这个功能

| 查证 | 结果 |
|---|---|
| 会话菜单（`dsh-client-ui-workspace`） | 只有 `归档 / 取消归档 / 置顶 / 分叉 / 新会话` —— **无删除** |
| 全仓 `deleteSession\|removeSession\|sessionDelete\|deleteStored` | **0 命中** |
| CLI（`dsh/lib/bin.js`） | 无 `sessions / prune / gc / purge` |
| workspace 的 `delete` | 只改工作区账目，**不碰会话存储** |
| 归档语义 | 软停止，可从"全部对话（显示已归档）"恢复 —— **不删数据** |

`ctx.workspaces` 也**没有**"把会话从花名册移除"的 API（只有 archive/unarchive/create/rename/delete-workspace）。

## 实测账（本机 2026-10-13）

```
归档会话 2 个：
  session-73ae1c0e…  8.0M   themes   （41 个产出文件）
  session-936938b8…  3.1M   witcher  （18 个产出文件，已不在任何工作区花名册里）
  合计可回收 11.4M（含投影缓存）

attachments：526 个对象 / 76.1M —— **全部被日志引用，孤儿 0 个**
```

→ **今天从附件上一分钱都回收不到。** 79M 只有在引用它们的会话被清掉之后，才会逐步变成可回收。

## 两个分支

**聊天里 `/purge`：只出 dry-run 计划，不删任何东西。**

**真正的删除走 CLI**（建议先停服务，这样能同一趟把花名册也摘干净）：

```sh
systemctl --user stop dsh.service
node ~/dsh/playground/themes/dsh-session-purge/lib/core.mjs                    # dry-run
node ~/dsh/playground/themes/dsh-session-purge/lib/core.mjs --confirm --attachments
systemctl --user start dsh.service
```

- `--attachments`：把**其余会话都不再引用**的附件也算进来（内容寻址 + 跨会话去重，必须引用计数）
- 缺省 `trash` 模式：移到 `~/dsh/.purge-trash/<时间戳>/`，**可回滚**；`--hard` 才真删
- `--id <sessionId>`：不经归档列表，明确指定一个会话
- 正在跑 DSH 时会拒绝（除非 `--force`），因为花名册会被内存态覆盖

## 删什么、留什么

| | |
|---|---|
| **删** | `sessions/<ws>/<sid>/`（日志+锁）、`storages/session_projcache/sessions/<sid>.json`、可选：无人引用的附件、可选：`workspace.json` 花名册条目 |
| **留** | 工作区里的文件（本来就在会话存储之外）、删除前写出的 `PURGED-<sid8>.md` 产出清单 |

清单内容：会话 id、时间、工作目录、释放体积、**该会话产出/触碰过的文件列表**（来自日志里 `write`/`edit` 的 `file_path` 与 `deliverables/presented`）。

## 实现要点

- **解日志**：会话 `.jsonl.zstd` 是**多个 zstd 帧顺序拼接**（实测 887 帧）。`zstdDecompressSync` 只吃第一帧，流式解码器会在第二帧报 `Unknown frame descriptor`；按魔数 `28 b5 2f fd` 切片逐帧解是可行解。
- **搜索索引不用管**：`dsh-session-query-sqlite` 的对账逻辑是 `persistentDeletes = persistedRows.filter(row => !observation.persisted.has(row.id))`，会话文件消失后下次重算会自己删行。
- **cwd 从日志取**：有的归档会话已不在任何工作区花名册里（本机那个 witcher 会话就是），所以清单落点靠日志里的 `"cwd"` 字段。
- **`--attachments` 的失败姿态**：只要有任一日志解不开，就**放弃删任何附件**（宁可少删）。
