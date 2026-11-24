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

### 3.1 服务端启动无告警

```bash
python3 - <<'PY'
from pathlib import Path
lines = Path.home().joinpath('dsh/logs/web-run.log').read_text(errors='replace').splitlines()
tail = lines[[i for i,l in enumerate(lines) if l.startswith('dsh web: http')][-1]:]
print('\n'.join(tail[:20]))
PY
```

期望：只有 `dsh web: http://...token=...` 和模型列表之类的正常行；
**不应出现** `N entry did not activate`。

### 3.2 浏览器端插件图完整

打开带 token 的地址，按 F12 看 Console：

- ❌ 出现 `web boot: N required entries did not activate` → 见第 4 节
- ❌ 出现 `404 /api/web/listProviders` → 供应商路由插件没挂上

### 3.3 端口与路由

```bash
ss -ltn | grep -E ':(3080|8317|8318)'      # 三个都要在
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8318/health
```

---

## 4. 已知坑：升级到 0.2.2-rc.5 后客户端插件全部 pending

**症状**（2026-11-24 实测）：

```
web boot: 2 required entries did not activate
@deepseek-ai/dsh-client-ui-sidebar (required): pending (waiting for service: uiWorkspace)
@deepseek-ai/dsh-client-ui-chat (required): pending (waiting for services: uiWorkspace, uiConversation, sidebarRight, fileDrag)
... 二十多条 pending
```

界面只剩空壳，`/api/web/listProviders` 返回 404。

**根因**：`dsh-web-app` bundle 里的 `ui-context-menu` / `ui-file-drag` 两行没有实际生效，
浏览器端拿到的 client 模块清单里**缺这两个模块**（实测 79 个，正常应为 83 个），
于是 `contextMenus` / `fileDrag` 服务根本不存在，所有依赖它们的插件永远 pending。

**判断方法**（不用看源码）：F12 → Console 里执行

```js
const u = performance.getEntriesByType('resource').map(e=>e.name).filter(x=>x.includes('/plugins/'));
const mods = new Set(); for (const x of u){const q=x.split('??')[1]; if(q) for(const p of q.split(',')) mods.add(p.split('&')[0]);}
({count: mods.size, ctx: u.join().includes('context-menu'), drag: u.join().includes('file-drag')})
```

正常：`{count: 83, ctx: true, drag: true}`。

**修法**：本仓库 `cordis.patch.yml` 末尾已经内置这两行的显式重声明
（见「0.2.2-rc.5 兼容补丁」段）。所以只要：

```bash
cd ~/dsh/playground/themes/dsh-guava-pack && git pull --rebase
systemctl --user restart dsh.service
```

界面即恢复。若将来某个版本官方修好了，这段重声明也无害（同 id 同名，等于补插）。

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
