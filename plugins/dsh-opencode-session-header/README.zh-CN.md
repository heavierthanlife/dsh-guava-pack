# dsh-opencode-session-header

[![npm version](https://img.shields.io/npm/v/dsh-opencode-session-header)](https://www.npmjs.com/package/dsh-opencode-session-header)
[![license](https://img.shields.io/npm/l/dsh-opencode-session-header)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-opencode-session-header)](./package.json)

面向 **DeepSeek Harness (DSH)** → **OpenCode Go** 的按会话 `x-opencode-session` 头注入插件。

既修复 `400 MissingSessionID` 报错，**又**保留 OpenCode 官方按会话路由/提示词缓存的优化——只作用于 `opencode.ai`，运行时可开关（无需重启），零依赖。

[English](./README.md)

## 问题背景

自 2026-09-05 起，[OpenCode Go](https://opencode.ai/docs/go/) 强制要求每个推理请求携带稳定的 `x-opencode-session` 头（用于路由与提示词缓存）。DeepSeek Harness ≤ `0.1.2-rc.1` 在所有适配器路径上都不发送该头，导致 **opencode-go 下所有模型调用失败**：

```
400: {"type":"MissingSessionID","message":"Error from provider (Console Go): Request is missing x-opencode-session ..."}
```

上游修复在 [deepseek-harness discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495) 跟踪，但尚未发布。本插件在本地补上这个缺口。

## 为什么不用常见的绕过方案？

| | settings.yaml 静态 `headers` | 全局 `opencode_zen` profile（dsh-custom-header） | **本插件** |
|---|---|---|---|
| 修复 400 | ✅ | ✅ | ✅ |
| 每会话独立 id（缓存/路由最优） | ❌ 所有会话共用一个 id → 缓存落空、变慢变贵 | ✅ | ✅ 直接用 DSH 真实会话 id |
| 不影响其他 provider | ✅ | ❌ 对**所有**主机改写 UA + `x-opencode-*` | ✅ 仅 `opencode.ai` |
| 免重启开关 | — | — | ✅ 改 JSON 立即生效 |
| 额外依赖 | — | 第三方插件 + 客户端 bundle | 无 |

## 安装

```powershell
dsh plugin --profile web add dsh-opencode-session-header
```

或从本地目录安装：

```powershell
dsh plugin --profile web add "file:C:\path\to\dsh-opencode-session-header"
```

安装后**手动重启一次 dsh web**（插件随启动加载）。启动日志应出现：

```
[dsh-opencode-session-header] loaded: header=x-opencode-session hosts=opencode.ai fallback=dsh-default
[dsh-opencode-session-header] runtime switch: <DSH_HOME>\plugins\dsh-opencode-session-header.json ({"enabled":false} disables; missing file = enabled)
```

## 运行时开关（无需重启）

状态文件：`<DSH_HOME>/plugins/dsh-opencode-session-header.json`（`DSH_HOME` 未设置时为 `~/.dsh`）：

```json
{ "enabled": false }
```

- `false` → 关闭注入（所有请求原样放行）；
- `true` 或**文件不存在** → 开启注入；
- 插件每次 LLM 请求实时读取该文件，改动立即生效。

## 工作原理

两个挂载点，均已在 DSH `0.1.2-rc.1` 内实测可行：

1. **`llm/stream` waterfall 观察者**——把每次适配器流式迭代的执行包进 `AsyncLocalStorage`，携带 `GenerateOptions.sessionId`（每会话唯一，跨轮次/压缩/重试稳定；新会话/fork/子代理各自全新）。
2. **fetch 传输层中间件**——仅当请求主机匹配白名单（默认 `opencode.ai` 及其子域）时注入 `x-opencode-session`；值为当前会话 id，无 LLM 上下文时（如模型探测）用兜底值 `dsh-default`。**其他任何主机原样放行，一个字节不改。**

fetch 管线挂在本插件自己的 `Symbol.for` 键下（机制取自 [`@aizigao/pi-fetch-pipeline`](https://github.com/aizigao/pi-fetch-pipeline)，MIT），与其他同样包装 fetch 的插件互不覆盖。头合并遵循 fetch 规范：以实际会到达网线的那份头（`init.headers` 或 `Request.headers`）为合并基底。

## 测试

```powershell
npm test        # 13 项断言：注入 / 兜底 id / 主机白名单 / 运行时开关 /
                # 并发会话隔离 / llm/stream 上下文传播 / 子域匹配
```

## 兼容性与退役

- 针对已针对 DSH `0.1.2-rc.1`（发布时的 npm 最新版）构建并验证。
- 依赖"DSH 出站 LLM 请求走 Node 全局 `fetch`"这一现状；若未来版本更换网络栈，插件会静默停止注入——症状就是 400 复现，届时卸载即可。
- 待上游内置按会话会话头后（[discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495)），即可退役：

```powershell
dsh plugin --profile web remove dsh-opencode-session-header
```

重启 dsh web 生效（可顺带删除开关文件）。

## 致谢

- fetch 管线机制取自 [`@aizigao/pi-fetch-pipeline`](https://github.com/aizigao/pi-fetch-pipeline)（MIT）；在 DSH 上走 fetch 层的可行性由 [Asaiuta](https://github.com/Asaiuta) 的 [`dsh-custom-header`](https://github.com/Asaiuta/dsh-custom-header)（MIT）验证。

## 许可证

[MIT](./LICENSE)
