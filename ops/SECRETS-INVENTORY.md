# 密钥清单与查询教程（SECRETS INVENTORY）

> **本文档只记录"有哪些密钥、放在哪、怎么取"，绝不记录密钥本身。**
> 任何情况下不要把密钥值贴进聊天、AI 对话、截图或 git 提交。

## 0. 为什么需要这份清单

整套 DSH 系统里，**只有这些 provider key 是没有任何备份的**：

| 位置 | 在 restic 备份里吗 |
|---|---|
| `~/dsh/.credentials.yaml`（`refs:` 段） | ✅ 在（`~/dsh` 被整体备份，restic 加密） |
| `~/.bashrc` 里的 `export *_API_KEY=` | ❌ **不在**（`~/.bashrc` 在 `~/dsh` 之外，备份不覆盖） |
| Windows 侧 `Antigravity Tools` 自己的配置 | ❌ 不在 |

也就是说：**如果 Windows 重装、WSL 被删、或家目录丢失，`.bashrc` 里那几把 key 就真的没了**（除非你记得去各家控制台重新申请）。

→ 所以请把它们抄进密码管理器（1Password / Bitwarden / KeePass 等）。

---

## 1. 密钥放在哪：两个来源，有优先级

`~/dsh/dsh` 启动器按这个顺序装载：

```sh
# 1) 先读 ~/.bashrc 里的 export（正则：^export ([A-Z_]+_API_KEY|DSH_[A-Z_]+)=）
eval "$(grep -E "^export ([A-Z_]+_API_KEY|DSH_[A-Z_]+)=" "$HOME/.bashrc")"

# 2) 再用 ~/dsh/.credentials.yaml 的 refs 段**覆盖**
eval "$(node "$GUAVA_PACK/tools/export-provider-keys.mjs")"
```

**结论：两处同名时，`.credentials.yaml` 生效。** 后执行的覆盖先执行的。

> ⚠️ 已知不一致（2026-11-12 核查）：`COMMANDCODE_API_KEY` 在两个位置**值不同**，
> 实际生效的是 `.credentials.yaml` 里的那份。`.bashrc` 里那份是历史残留，
> 容易误导排查。**以 `.credentials.yaml` 为准。**

---

## 2. 清单：变量名 / 用途 / 位置

`profiles/web/cordis.patch.yml` 里用 `apiKeyEnv:` 引用，共 **7 个必需**：

| 变量名 | 对应供应商 | 在 `.bashrc` | 在 `.credentials.yaml` |
|---|---|---|---|
| `AGENTROUTER_API_KEY` | AgentRouter（GPT 系列） | ✅ | — |
| `ANTIGRAVITY_API_KEY` | Antigravity（本机 8045 反代） | ✅ | — |
| `OPENCODE_GO_API_KEY` | OpenCode Go（$10/月订阅） | ✅ | — |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY` | 小米 Token Plan | ✅ | — |
| `COMMANDCODE_API_KEY` | Command Code（经 8317 桥接） | ⚠️ 旧值 | ✅ **生效** |
| `OPENROUTER_API_KEY` | OpenRouter | ❌ | ✅ |
| `NVIDIA_API_KEY` | NVIDIA NIM | ❌ | ✅ |

另有一些**不在 profiles 里、但其它工具会用**的：

| 变量名 | 谁在用 | 位置 |
|---|---|---|
| `DEEPSEEK_API_KEY` | Hermes / 直连 DeepSeek | `.bashrc` |
| `MIMO_API_KEY` | Hermes 备用链 | `.bashrc` |
| `TAVILY_API_KEY` | 联网搜索（Hermes / pi-lens） | `.bashrc` |
| `OPENCODE_API_KEY` | OpenCode Zen（与 Go 不是同一个套餐） | `.credentials.yaml` |

> `.credentials.yaml` 里还有 `client-connection/browser-session` 的 `secret`
> （浏览器会话签名密钥）。**不要删这条**，删了所有手机/平板都要重新输入 token。

---

## 3. 教程：在 WSL 里把这些 key 取出来

### 3.1 先开一个干净终端

在 Windows 里打开 Ubuntu 终端（或 `wsl` 进入）。确认 `HISTCONTROL`：

```bash
echo "$HISTCONTROL"
```

这台机器是 `ignoreboth`，意味着 **命令前加一个空格，就不会被记进 `~/.bash_history`**。
下面所有命令都以空格开头，请照抄（**开头的空格是故意的，别删**）。

### 3.2 只看"有哪些"（安全，不显示值）

```bash
 grep -oE '^export [A-Z_]+_API_KEY' ~/.bashrc | sed 's/export //' | sort
 sed -n '/^refs:/,$p' ~/dsh/.credentials.yaml | grep -oE '^  [A-Z0-9_]+:' | tr -d ' :' | sort
```

### 3.3 逐条显示（推荐：一次只显示一个，看完按回车）

```bash
 for v in AGENTROUTER_API_KEY ANTIGRAVITY_API_KEY OPENCODE_GO_API_KEY \
          XIAOMI_TOKEN_PLAN_CN_API_KEY COMMANDCODE_API_KEY \
          OPENROUTER_API_KEY NVIDIA_API_KEY; do
   printf '\n===== %s =====\n' "$v"
   grep -E "^export ${v}=" ~/.bashrc 2>/dev/null | sed "s/^export ${v}=//; s/^[\"']//; s/[\"']$//" \
     | sed 's/^/  bashrc   : /'
   sed -n '/^refs:/,$p' ~/dsh/.credentials.yaml 2>/dev/null \
     | grep -E "^  ${v}:" | sed "s/^  ${v}:[[:space:]]*//; s/^[\"']//; s/[\"']$//" \
     | sed 's/^/  creds    : /'
   read -r -p '  —— 记完按回车继续 ——' _
 done
```

输出里 `creds` 那行才是生效值（见第 1 节）。

### 3.4 想一次性复制（可选，风险自担）

```bash
 mkdir -p ~/tmp-keys && chmod 700 ~/tmp-keys
 grep -E '^export [A-Z_]+_API_KEY=' ~/.bashrc > ~/tmp-keys/from-bashrc.txt
 sed -n '/^refs:/,$p' ~/dsh/.credentials.yaml > ~/tmp-keys/from-creds.yaml
 chmod 600 ~/tmp-keys/*
 echo "已写入 ~/tmp-keys/ ，抄完后务必执行： shred -u ~/tmp-keys/* && rmdir ~/tmp-keys"
```

抄完后**一定要删**：

```bash
 shred -u ~/tmp-keys/* && rmdir ~/tmp-keys
```

### 3.5 抄完清屏

```bash
 printf '\033[2J\033[3J\033[H'   # 清屏并清掉可回滚的缓冲区
```

（历史里本来就没记，因为命令前有空格。）

---

## 4. 顺手验证：某把 key 到底还能不能用

### OpenCode Go

```bash
 curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' \
   -H "Authorization: Bearer $OPENCODE_GO_API_KEY" \
   -H "x-opencode-session: check-$(date +%s)" \
   https://opencode.ai/zen/go/v1/models
```

- `200` = 有效
- `401 api_key_expired` = **过期**（不是缺 header；缺 header 会是 `400 MissingSessionID`）

> 2026-11-12 实测：这台机器的 `OPENCODE_GO_API_KEY` 已换新，返回 200。

### Command Code（走本机桥接）

```bash
 curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' \
   -H "Authorization: Bearer $(python3 -c "import json;print(json.load(open('/mnt/d/AI_Tools/pi/agent/models.json',encoding='utf-8'))['providers']['commandcode']['apiKey'])")" \
   http://127.0.0.1:8317/v1/models
```

`200` = 桥接在跑且令牌有效。

---

## 5. 新机器上要做什么

`~/.bashrc` 里的 key **不会**跟着 git 走（那是设计如此：仓库不能存密钥）。新机器：

1. 按本清单把 key 从密码管理器逐条 `export` 进 `~/.bashrc`
2. 或者把 key 填进 DSH 的凭证库（`~/dsh/.credentials.yaml` 的 `refs:`），由启动器统一导出
3. 重启：`systemctl --user restart dsh.service`
4. 用第 4 节的方法逐条验证

---

## 6. 红线

- ❌ 不要把 key 写进 `dsh-guava-pack` 仓库（`.gitignore` 挡不住你手动 `git add -f`）
- ❌ 不要把 key 贴进任何 AI 对话/issue/截图
- ❌ 不要在共享屏幕时跑第 3.3 节
- ✅ 定期（建议每季度）按第 4 节验证一次，过期的趁早换
