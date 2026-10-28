# 待验证事项

> 记录那些「代码/单测已通过，但运行期无法在当前环境观测」的结论。
> 每条都写清：现在验证到了哪一步、为什么卡住、怎么一次性验完、通过/失败怎么判。
> 验完就把对应条目删掉（或标 ✅ 并写上日期），不要让这里变成许愿池。

---

## 1. `dsh-opencode-session-header`：运行期真正发出的 `x-opencode-session` 头值

**状态**：⏸ 阻塞于「OpenCode Go 订阅尚未开通」——当前主力是 commandcode 订阅，
`opencode-go` 的 provider 配置与路由条目都还在，但**没有流量**，所以无法观测。

**记录日期**：2026-10-28

### 已经验证到什么程度

- 生效副本已确认是**打过补丁的**那份：`profiles/web/package.json` 里
  `"dsh-opencode-session-header": "link:…/dsh-guava-pack/plugins/dsh-opencode-session-header"`，
  `node_modules/` 里是软链，版本 `0.1.0-dsh.1`，`matchesSessionHeaderTarget` 存在。
- 模块可加载：服务在改完后的 `14:57:05` 正常启动并监听 3080（若模块语法错，起不来）。
- 匹配规则单测：`plugins/dsh-opencode-session-header/tests/smoke.mjs` → **22 passed / 0 failed**
  （含 8a–8i：回环 `/opencode-go` 打头、`/agentrouter` 不打、`/opencode-goo` 不打、
  非回环不放宽、`loopbackPrefixes: []` 可关）。变异测试确认去掉规则会红。
- 真实形状矩阵（离屏，用 `matchesSessionHeaderTarget` 直接跑）：
  `8318/opencode-go/*` 打头；`8318/agentrouter`、`8318/xiaomi-token-plan-cn`、
  `8317` 桥接、`8045` antigravity 全部不打。

**没验证到的**：那个头在**运行中的 DSH 进程**里实际被写成了什么值。

### 为什么当前环境看不到

1. **日志没有该插件的 info 行**：`~/dsh/logs/web-run.log` 里只有 `llm-deepseek-account`
   之类的行；插件 `apply()` 里的 `log('info', …)` 没有落盘（logger 级别/落盘策略限制）。
   注意：这条 info 行会打印 `loopbackPrefixes=opencode-go`，**哪天日志里出现了它，
   就说明插件按新代码装载了**——可以把它当成一个免费信号。
2. **进程在独立 pid 命名空间**：本会话的 bash 在 bubblewrap 沙箱里（`--unshare-pid`），
   `pgrep`/`ss -p` 都看不到宿主进程，无法 attach 去看它的 `globalThis.fetch` 或网络。
3. **路由代理的抓包只存 body、不存 headers**：`DSH_ROUTER_CAPTURE=1` 只在
   `provider === 'agentrouter'` 时写 `captures/req-*.json`（请求体），拿不到头。

### ⚠️ 关键陷阱：静态头会掩盖「注入没生效」

profile 里 `opencode-go` 仍带着一条硬编码兜底：

```yaml
        headers:
          x-opencode-session: 9e6a6e91-34ce-4d75-a762-6626220ed74e
```

插件生效时会在 adapter 组好头之后 `headers.set()` **覆盖**它；插件没生效/被运行时开关关掉时，
这条静态头仍然让请求成功。**所以「能用、不报 400」不能证明注入生效**——
必须看到头值是**会话 id 形状**（`session-…`）而不是 `9e6a6e91-…`。

### 验证配方 A（决定性，本地可做，约 5 分钟 + 1 次重启）

让请求打到一个本机 echo，把真正的头打印出来：

```sh
# 1) 起 echo（监听 9099，打印路径与头；故意回 500，只为抓头）
node -e "require('http').createServer((q,s)=>{console.log(new Date().toISOString(),q.method,q.url,'x-opencode-session='+String(q.headers['x-opencode-session']));s.writeHead(500,{'content-type':'application/json'});s.end(JSON.stringify({error:{message:'echo'}}))}).listen(9099,'127.0.0.1',()=>console.log('echo on 127.0.0.1:9099'))"
```

```yaml
# 2) 临时改 profiles/web/cordis.patch.yml 里 opencode-go 的 baseURL
      opencode-go:
        baseURL: http://127.0.0.1:9099/opencode-go   # 原来是 http://127.0.0.1:8318/opencode-go
```

```sh
# 3) 重启 + 刷新页面
systemctl --user restart dsh.service
```

4. 在 Web UI 新建一个会话，选一个 `opencode-go` 模型，发一句「hi」（必然报错，正常——echo 只想抓头）。
5. 看 echo 的输出。判据：

| 观测到头值 | 结论 |
|---|---|
| `session-…`（会话 id） | ✅ 注入生效 |
| `9e6a6e91-…`（静态兜底值） | ❌ 插件没生效（被静态头掩盖着，线上表现为「能用但所有会话共用一个 id」） |
| 空 / `undefined` | ❌ 完全没打头 |
| echo 根本没收到请求 | 说明 baseURL 没改对，或 DSH 没重启 |

6. **验证「每会话不同」**：再开第二个会话发一句，两次打印的头值应当**不同**。
   这才是本次改装真正要拿回来的东西（上游按会话做路由亲和与前缀缓存）。

7. 收尾（别忘）：把 baseURL 改回 `http://127.0.0.1:8318/opencode-go`，重启，删掉 echo 进程。

### 验证配方 B（轻量，只证明「有没有」）

临时把 profile 里那两行静态 `headers:` 注释掉 → 重启 → 发一句：

- 成功：至少「注入了某个头」成立（但仍**不能**证明是每会话不同的值）；
- 报 `400 MissingSessionID`：注入没生效。

验完记得把静态头加回去（它是插件被运行时开关关掉时的兜底）。

### 验证配方 C（上游侧）

订阅开通后，如果 OpenCode 控制台/用量页能按 session 维度看，直接比对两个会话是否各占一条即可。
这是唯一「不依赖本地观测」的确认方式。

### 开通订阅后的 checklist

- [ ] 起 echo，走配方 A，确认头值是 `session-…` 而不是静态 UUID
- [ ] 两个会话各发一句，确认头值不同
- [ ] baseURL 改回 `8318/opencode-go`，重启，删 echo
- [ ] 留意 `~/dsh/logs/web-run.log` 是否出现 `loopbackPrefixes=opencode-go` 的 info 行
- [ ] 全部通过后删掉本节

---

## 2.（备用格式）

以后再有「只能在上游/只能在真机观测」的结论，按上面同样的四段写：
**现状 → 卡在哪 → 怎么验 → 判据**。
