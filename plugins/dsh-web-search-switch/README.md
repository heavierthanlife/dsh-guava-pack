# dsh-web-search-switch

在 **官方 DeepSeek 搜索** 和 **Tavily** 之间一键切换，即时生效、不用重启 DSH。

## 它解决什么问题

DSH 的联网搜索是**可插拔**的：`ctx.web` 是一层 capability seam，各家搜索是一个
"search provider"。但官方只发布了三个 provider：

| 包 | provider id | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-web-search-deepseek` | `deepseek-official` | 走一次 Messages 调用 + 原生 `web_search_20250305` server tool（每次搜索 = 一个模型回合） |
| `@deepseek-ai/dsh-web-search-exa` | `exa` | Exa 检索 API |
| `@deepseek-ai/dsh-web-search-perplexity` | `perplexity` | Perplexity，会回生成式答案 |

**没有 Tavily**（npm 上 `@deepseek-ai/dsh-web-search-tavily` 不存在，其余
brave / serper / firecrawl 也都 404）。

而且 seam 的选择策略让"两个都挂上、随便切"**做不到**：

- 配了 `searchProvider: <id>` → 必须用它（没注册/不可用直接报错）；
- 没配 → **恰好一个**可用 provider 才自动选中，两个可用就 `WEB_PROVIDER_AMBIGUOUS`；
- `searchProvider` 是插件**构造时**读的 → 改配置要重启。

所以本插件只注册**一个** provider（id = `switch`），把 `web.searchProvider` 钉在它
身上，再由它按运行时偏好转发。切后端 = 改一个 JSON 偏好，**下一次搜索立即生效**。

## 怎么开

1. profile 里把 seam 钉到 `switch`（`config/cordis.patch.example.yml` 已带这段）：

   ```yaml
   - id: web
     config:
       searchProvider: switch
       fetchProvider: http
   ```

2. 重启一次 DSH（新增 host 插件 + profile 改动都只在启动时加载）。

3. 用其中一个入口切换：

   - **设置 → 搜索后端**（两个按钮，显示各自是否已配置）
   - 聊天里：`/search-backend` 看状态，`/search-backend tavily` 切换

## Tavily key

引用名固定为 **`TAVILY_API_KEY`**，按 DSH 的常规顺序解析：
`ctx.credentials`（设置里存的） → 进程环境（`~/.bashrc` 由启动器载入）。

三种填法（优先级从高到低）：

1. **设置 → 搜索后端** 里直接粘贴（推荐）—— 存本机 0600 状态文件，**立刻生效、不用重启**；
2. DSH 凭证库（`ctx.credentials`）；
3. 进程环境 `~/.bashrc` —— 注意环境变量只在进程启动时读一次，**改完必须重启 DSH**。

没配 key 时切到 Tavily **不会崩**：搜索会返回一条结构化错误，直接告诉你缺哪个变量。

## ⚠️ client / host 版本错位（踩过的真实体验）

client 半边是**软链 + HMR**：改文件刷新页面就是新版。
host 半边**必须重启**才换。所以会出现这种组合：

> 面板上有 Tavily key 输入框（新 client）→ 填好点保存 → **毫无反应、也不报错**。

因为旧宿主不认识 `tavilyApiKey` 字段，静默忽略，返回的 state 里也没有
`tavilyKeyFromPanel`。现在修了：宿主在 `state.apiVersion` 里声明能力版本
（`2` = 支持保存 key），客户端拿不到或版本不够时，**直接把"请重启 DSH"打在面板上**
并禁用输入框，而不是假装保存成功。

## 偏好文件

```
<DSH_HOME>/storages/web-search-switch.json    # {"backend":"official"|"tavily"}  0600
```

- 每次搜索热读（stat mtime+size 缓存），**改文件也能立即生效**；
- 文件缺失 / 损坏 / 取值非法 → 回落 `official`（默认后端永远"能用"，坏文件不会把搜索弄坏）。

## 取舍（如实记录）

- **官方后端不支持 DeepSeek 账号登录态**：官方 provider 会优先用 account token，
  那条路径依赖官方插件内部的 initiator 判断，本插件没有复刻，因此走 **API key**。
  需要账号态搜索时，把 `searchProvider` 改回 `deepseek-official`（要重启）。
- **不接管 `web_fetch`**：只切搜索；抓取仍由 `web-fetch-http` 提供。
- seam 的 `maxResults` 截断仍由 seam 做，provider 只按自己的上限优化请求
  （Tavily `max_results` 上限 20）。

## 自检

```sh
node tools/tests/web-search-switch.mjs    # 33 项：映射 / 转发 / 偏好读写 / 接线
```

不联网：official 与 tavily 都注入假实现。
