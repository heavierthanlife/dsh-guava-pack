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

- `--attachments`：把**其余会话与交接文档都不再引用**的附件也算进来（内容寻址 +
  跨会话去重，必须引用计数；引用来源 = 其它会话日志 + 工作区 `HANDOFF-*.md` /
  `PURGED-*.md` + `$DSH_HOME/.purge-trash/*.md`。后者是跨会话交接载体，里面的
  `sha256:` 引用不在任何日志里，不扫就会把交接文档里的图/文件当孤儿删掉）
- 缺省 `trash` 模式：移到 `~/dsh/.purge-trash/<时间戳>/`，**可回滚**；`--hard` 才真删
- `--id <sessionId>`：不经归档列表，明确指定一个会话
- `--roster-only`：**只摘花名册里磁盘上已不存在的 id，一个会话都不碰**（脚本 `clean-roster.sh` 与面板那三条命令用的就是它）
- 正在跑 DSH 时会拒绝（除非 `--force`），因为花名册会被内存态覆盖

## 安全闸门（每一条都是有意的，不是啰嗦）

这个插件是全框架**唯一**会动会话存储的地方，所以每条破坏性动作前面都加了一道闸：

| 闸门 | 挡什么 |
|---|---|
| **写锁预检** | 动手前先用 `flock -n` 问内核"这个会话有没有活写者"。**被持有的会话一律跳过**，并在 CLI / 面板上报 —— 删掉活跃会话的 `session.lock` 会让两个写者同时往同一份日志追加（框架自己的文档说"nothing in the harness does so"，只有这里会）。跳过是**保护**不是失败，它们还在原地，等写完再跑一次即可。`--ignore-locks` 可显式跳过这道检查。 |
| **确认令牌** | 面板的 `execute` 必须带上 `plan` 发的令牌：**一次性**、5 分钟有效、并绑定"这批会话 + 这个模式 + 这个附件开关"。所以"用户看过 trash 计划"不能变成"实际执行 hard 删除"，重放也不行。<br>**诚实说明边界**：它挡的是盲目请求、重放、以及"删用户没确认过的那一批"；挡不住"能自己调 `plan` 的同源脚本"—— 客户端插件本来就有整个页面的权限，那是信任边界问题，不是令牌能解决的。 |
| **花名册预处理提前** | 读原文 / 解析 / 算新内容 / 写备份**全部在任何删除之前**，任一步失败即 abort（此时磁盘上一个会话都还没动）。 |
| **原子写** | `workspace.json` 用 temp + fsync + rename，不会留下半截 JSON（它是"会话属于哪个工作区"的唯一记录）。 |
| **附件保守** | 只要**任一日志解不完整、或任一 handoff/清单文档读不了**，就放弃删任何附件（宁可少删）。 |
| **清单先建目录** | 写 `PURGED-*.md` 前先建父目录 —— 否则"工作目录不可用就落回 trash"这条兜底会以 ENOENT 静默失败。 |
| **单条失败不中断** | 某个会话删不动（权限 / 目录非空 / 设备忙）只跳过它并上报，不影响其余会话。 |
| **回滚点不重名** | 回滚目录名带秒级时间戳，若已存在则加 `-2`/`-3` 后缀 —— 否则同一秒内重跑会 `ENOTEMPTY` 中断在半路。 |

## 删什么、留什么

| | |
|---|---|
| **删** | `sessions/<ws>/<sid>/`（日志+锁）、`storages/session_projcache/sessions/<sid>.json`、可选：无人引用的附件、可选：`workspace.json` 花名册条目 |
| **留** | 工作区里的文件（本来就在会话存储之外）、删除前写出的 `PURGED-<sid8>.md` 产出清单 |

清单写到**工作目录的真实路径**（`realpathSync` 展开符号链接）；工作目录拿不到（已删除 / 悬空链接 / 不是目录）时落到 `.purge-trash/`，CLI 与面板的预览都用同一个函数算，不会和实际写入位置跑偏。

清单内容：会话 id、时间、工作目录、释放体积、**该会话产出/触碰过的文件列表**（来自日志里 `write`/`edit` 的 `file_path` 与 `deliverables/presented`）。

## 性能：为什么不把 DSH 冻住

host 路由跑在 DSH **唯一**的那个事件循环上，而生成计划要解压归档会话的日志。本机实测
（归档日志 4.5 MB / 解出 15.7 M 字符）：

| 动作 | 耗时 | 事件循环最长阻塞 |
|---|---|---|
| `buildPlan`（同步，CLI 用） | 215 ms | **138 ms** |
| `buildPlanAsync`（host 用） | 183 ms | **24 ms** |
| `readStaleIds`（面板**每次页面加载**用的） | **1 ms** | ~0 |

三件事：

1. **便宜的残留通道**。面板每次加载都要刷新"花名册残留"列表，而它只需要两个 id 集合
   相减 —— 以前却走完整 `buildPlan`（每次页面加载 200ms+，结果只用到一个 `missing`
   字段）。现在走 `stale` 端点（`readStaleIds`，只枚举目录名，不解压、不 stat）。
2. **同步/异步同一份实现**。逻辑写成 generator，在昂贵步骤之间 `yield`；`driveSync`
   一路到底（CLI），`driveAsync` 每个 yield 点让出一次（host）。generator 之间用
   `yield*` 委托，所以**只有一份实现**，两条路径不可能漂移（有测试断言两者结果逐字节相同）。
3. **计划缓存 30 秒**。面板每次打开、每次取确认令牌都要一份计划；缓存把重复开销降到 0。
   执行后立刻作废。缓存不改变确认令牌的绑定语义（令牌每次都是新的）。

另外 `extractSessionFacts` 加了一道**便宜的预筛**：整段日志里绝大多数行与"产出"无关，
先 `includes` 再 `JSON.parse`（实测 15.7 M 字符 / 3590 行：全量 parse 82ms，预筛后 19ms，
只有 673 行需要解析）。已用 26 份真实日志逐条比对，输出与预筛前**完全一致**。

## 实现要点

- **解日志**：会话 `.jsonl.zstd` 是**多个 zstd 帧顺序拼接**（实测一份 343 帧 / 710KB）。
  必须**按 RFC 8878 的帧结构走帧**算边界，不能靠"扫魔数 + 逐帧试解" —— 实测
  `zstdDecompressSync` **对被截断的帧是静默容忍的**（尾部砍 4 字节，解出的文本长度与
  完整文件一模一样），所以"统计失败帧"根本抓不到截断。而截断正是附件引用扫描最危险的
  损坏形式（会静默漏掉尾部帧里的引用 → 删掉别的会话还在用的图）。
  走帧后：文件必须**正好由完整帧拼成**才认（`complete`），否则按不可信处理。
- **搜索索引不用管**：`dsh-session-query-sqlite` 的对账逻辑是 `persistentDeletes = persistedRows.filter(row => !observation.persisted.has(row.id))`，会话文件消失后下次重算会自己删行。
- **cwd 从日志取**：有的归档会话已不在任何工作区花名册里（本机那个 witcher 会话就是），所以清单落点靠日志里的 `"cwd"` 字段。
- **`--attachments` 的失败姿态**：只要有任一日志解不完整，就**放弃删任何附件**（宁可少删）。
