# 升级 DSH 的注意事项

> 适用：`dsh` 本体（`@deepseek-ai/dsh`）从 0.2.x 升到下一个 rc/正式版。
> 插件包（本仓库）不用跟着升级，但**升级后必须按本文自检**。

---

## 1. 升级前

```bash
# 1.1 备份 profile（不在 git 里，升级不会自动保护它）
cp -a ~/dsh/profiles/web/cordis.patch.yml \
      ~/dsh/profiles/web/cordis.patch.yml.bak-upgrade-$(date +%Y%m%d-%H%M%S)

# 1.2 记录当前正常的基线（升级后拿来对比）
systemctl --user is-active dsh.service
ss -ltn | grep -E ':(3080|8317|8318|3098|3099)'
grep -o 'token=[A-Za-z0-9_-]*' ~/dsh/logs/web-run.log | tail -1
```

## 2. 升级

```bash
cd ~/dsh
# 按官方方式升级（pnpm / npm 均可，注意 Node ≥ 22.19）
pnpm add @deepseek-ai/dsh@<版本>
# 升级会重装 node_modules → 我们打在里面的补丁会被覆盖，启动器会自动重打
node playground/themes/dsh-guava-pack/install.mjs --patch
systemctl --user restart dsh.service
```

## 3. 升级后自检（三步，缺一不可）

### 3.1 一条命令看服务端（日志 + 端口 + 路由健康）

```bash
node ~/dsh/playground/themes/dsh-guava-pack/tools/check-boot.mjs
```

它读 `~/dsh/logs/web-run.log` 的**最后一段**（上一次启动之前的一律不算），判三件事：

| 检查 | 红意味着 |
|---|---|
| `did not activate` / `pending (waiting for service: …)` | 客户端模块清单缺包，界面会是空壳 → 第 4 节 |
| `never started` | 上游包漏发 exports 子路径，会话打不开 → BREAK-GLASS §8.22 |
| 3080 / 8318 没监听、`8318/health` 不是 200 | 服务或路由代理没起来 |

退出码 `0` = 正常，`1` = 有异常（`--advisory` 恒 `0`，`--json` 出机器可读）。

`[deepseek-account] request failed`（`no-response`）、`ExperimentalWarning` 这些已知噪音已过滤，
不会误报。详见 `ops/tunnel/BREAK-GLASS.md` §8.21 / §8.22。

> `node install.mjs --check` 末尾也会自动跑一遍（advisory，不计入失败数），
> 所以一般**不必单独跑**；想在别的机器上核对日志用
> `DSH_CHECK_PORTS=none DSH_CHECK_LOG=... node tools/check-boot.mjs`。

### 3.2 客户端插件图完整（**必做**，服务端日志看不见这一层）

```bash
node tools/tests/client-manifest.mjs        # 正常：83 个模块、两个模块都在
```

这一步不能省：`--dump-config` 与服务端日志**天生发现不了** client manifest 缺模块
（见第 4 节）。守卫测试服务没起时会明确跳过，不会误报。

也可开浏览器看 F12 → Console：出现 `web boot: N required entries did not activate`
或 `404 /api/web/listProviders` 即异常。

### 3.3 端口与路由（`check-boot` 已覆盖，留作手工核对）

```bash
ss -ltn | grep -E ':(3080|8317|8318)'      # 三个都要在
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8318/health
```

---

## 4. 已知坑：客户端插件全部 pending（client manifest 缺模块）

**症状**：

```
web boot: 2 required entries did not activate
@deepseek-ai/dsh-client-ui-sidebar (required): pending (waiting for service: uiWorkspace)
@deepseek-ai/dsh-client-ui-chat (required): pending (waiting for services: uiWorkspace, uiConversation, sidebarRight, fileDrag)
... 二十多条 pending
```

界面只剩空壳，`/api/web/listProviders` 返回 404。

**根因**：`dsh-web-app` bundle 插入的 `ui-context-menu` / `ui-file-drag` 两行**没有进到
浏览器端的 client manifest**（实测 79 个模块，正常 83 个），于是 `contextMenus` /
`fileDrag` 服务不存在，依赖它们的插件永远 pending。

### 4.1 这个坑是怎么被自己造出来的（2026-11-24→11-26 真实事故）

2026-11-24 有人以为「升级到 0.2.2-rc.5 后这两行没生效」，于是在 bundle patch 里加了：

```yaml
- id: ui-context-menu
  name: "@deepseek-ai/dsh-client-ui-context-menu"
- id: ui-file-drag
  name: "@deepseek-ai/dsh-client-ui-file-drag"
```

**这个判断是错的，而且补丁本身就是病因**。Loader patch 方言（见
`dsh-doc` 技能的 `references/composition-reference.md`）规定：

> `insert: [rows]` 追加行。**只有 `insert:` 能新增行。**
> 带 `id` 且没有 `insert` 的 patch **定位已存在的行**，提供的字段替换该行字段；
> 一个真值 `name` 只是**断言**已有插件名，不会改名，更不会插入。
> 没有非空 `id` 的非插入 patch、以及**匹配不到任何行**的 patch，只会告警并跳过。

那 4 行没有 `insert:`，却用了**上游 bundle 已经插入的行 id** —— 于是它们不是「补插」，
而是给这两行各盖了一个「被 patch 过」的章。这两行随后不再出现在 client manifest 里，
79 vs 83 的缺口就是这么来的。实测把 4 行删掉即恢复 83。

> ⚠️ **别再往 cordis.patch.yml 里加这两行，也不要加任何「同名同 id」的补丁行。**
> 这个补丁已经在 2026-11-26（`b78f69e`）整段删除。要新增挂载行，只有 `insert:`。

### 4.2 为什么它极难发现

| 检查手段 | 能否发现 | 原因 |
|---|---|---|
| host 启动日志 | ❌ | 0 warning，补丁「成功应用」了 |
| `--dump-config` | ❌ | 两行照样打印，1 个不多 1 个不少 |
| `/api/web/listProviders` 之外的服务端接口 | ❌ | 服务端一切正常 |
| `install.mjs --check`（**旧版**） | ❌ | 曾把多出来的 id 行称作「上游 id 的兼容补丁」并打 ✅ —— 检查器替错误背书了。**2026-11-26 已改成硬断言：顶层 `- id:` 一律判红** |
| **client manifest 条目数** | ✅ | 79 ≠ 83，缺的正是这两个 |

这就是必须看**浏览器端真正收到的模块清单**的原因 —— 它是唯一能暴露该故障的地方。

### 4.3 判断方法（推荐用守卫测试，不用开浏览器）

```bash
node tools/tests/client-manifest.mjs
```

它从 `~/dsh/logs/web-run.log` 取最后一次启动的 token，抓 `/?token=…`，
解析 `globalThis["__DSH_BOOT__"].entries`，断言：

- `@deepseek-ai/dsh-client-ui-context-menu` 与 `@deepseek-ai/dsh-client-ui-file-drag` 在列；
- 条目 id 无重复；
- 条目数不低于下限（默认 60，可用 `DSH_MANIFEST_MIN` 覆盖）。

服务没在跑时它会**明确跳过并 exit 0**，不会把 `npm test` 链弄断。

要看细节可以加 `--json`；它同时会用内置的「回归夹具」自证能抓到 79/缺模块那种载荷。

浏览器手工版（F12 → Console）：

```js
const u = performance.getEntriesByType('resource').map(e=>e.name).filter(x=>x.includes('/plugins/'));
const mods = new Set(); for (const x of u){const q=x.split('??')[1]; if(q) for(const p of q.split(',')) mods.add(p.split('&')[0]);}
({count: mods.size, ctx: u.join().includes('context-menu'), drag: u.join().includes('file-drag')})
```

正常：`{count: 83, ctx: true, drag: true}`。

### 4.4 修法

```bash
# 确认 bundle patch 里没有那 4 行（有就删掉，不需要任何替代补丁）
grep -n 'ui-context-menu\|ui-file-drag' playground/themes/dsh-guava-pack/cordis.patch.yml
node tools/tests/client-manifest.mjs      # 应 83、两个模块都在
```

浏览器侧若是旧的失败清单，硬刷新一次（Ctrl+Shift+R 或 DevTools → Application →
Clear site data）。服务端修好后浏览器仍会贴着一份旧的坏客户端图。

---

## 5. 回滚

```bash
cd ~/dsh
pnpm add @deepseek-ai/dsh@<旧版本>
node playground/themes/dsh-guava-pack/install.mjs --patch
systemctl --user restart dsh.service
```

profile 若被改坏，用第 1.1 步的备份覆盖回来再重启。

---

## 6. 升级后顺手做一次备份

```bash
systemctl --user start dsh-backup.service
```

DSH 每天 03:30 才自动备份，升级当天改的东西当晚才进快照。
