# 网络排查：手机连 dsh 卡 / 流式延迟大 / 频繁重载

> 来源：2026-10-13 在 `ygy12` 上实测。结论都有验证命令，照着跑就能确认。

## 0. 拓扑：两条腿是独立的，别混着排查

```
手机 ──Tailscale(WireGuard)──▶ Windows ──localhost──▶ WSL 里的 dsh:3080
                                   │
dsh ──▶ provider-router:8318 ──▶ SSR(127.0.0.1:2080) ──▶ 海外供应商
```

> ⚠️ **SSR 端口每台机器都可能不同**（本机 2080，另一台 2099）。写死默认值的那台机器
> 会表现为"只有走 SSR 的供应商全挂"。用 `~/.bashrc` 里的 `DSH_SSR_PROXY` 显式指定，
> 启动器 / router `start.sh` / 桥接都会读它。`node tools/preflight.mjs` 会检查这一点。
>
> 另：`provider-router` 等上游响应头的上限默认已从 120s 收紧到 **60s**
> （`DSH_ROUTER_HEADER_TIMEOUT_MS`）。上游卡住时 UI 不会再傻等两分钟。

**SSR 完全不参与"手机 → 主机"这一跳。** 所以"套了代理所以手机卡"这个直觉是错的 ——
除非代理把 **Tailscale 自己的流量**也吸走了（下面就是这个坑）。

判断哪条腿有问题：
- 面板上的 `tok/s` 很高（如 193 tok/s）→ 生成端没问题，卡在"主机 → 手机"
- 桌面浏览器（localhost，不过 Tailscale）打开**同一个会话**也卡 → 是渲染，不是网络

## 1. 结论一：Tailscale 读环境变量，**不读**系统代理的"例外"列表

实测：把 `*.tailscale.com` 加进 Windows 的 **WinINET 例外**（`ProxyOverride`）后，
`tailscale netcheck` 里**依然**打印：

```
tshttpproxy: using proxy "http://127.0.0.1:2080" for URL: "https://controlplane.tailscale.com/"
```

把 `ProxyEnable` 置 0、改成 PAC 也一样没用。原因：代理来自**环境变量**，而
Tailscale 的 `tshttpproxy` 是**环境变量优先**（`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`）。

排查：

```powershell
# 看 Windows 侧的代理环境变量（用户级）
reg query "HKCU\Environment" | findstr /i proxy
# 系统级（服务进程读的是这个）
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" | findstr /i proxy
```

本机当时的实际值（问题所在 —— `NO_PROXY` 里没有 tailscale）：

```
HTTP_PROXY  = http://127.0.0.1:2080
HTTPS_PROXY = http://127.0.0.1:2080
NO_PROXY    = localhost,127.0.0.1,::1
```

## 2. 修复：把 tailscale 域名加进 NO_PROXY

```powershell
# 用户级（手动跑 tailscale CLI 时生效）
reg add "HKCU\Environment" /v NO_PROXY /t REG_SZ /d "localhost,127.0.0.1,::1,.tailscale.com,tailscale.com,controlplane.tailscale.com,.tailscale.io,.tailscale.net,100.64.0.0/10" /f

# 系统级（tailscaled 服务跑在 LocalSystem，必须用这个；需管理员）
[Environment]::SetEnvironmentVariable('NO_PROXY','localhost,127.0.0.1,::1,.tailscale.com,tailscale.com,controlplane.tailscale.com,.tailscale.io,.tailscale.net,100.64.0.0/10','Machine')
Restart-Service Tailscale
```

⚠️ 这几个 `*_PROXY` 变量是 SSR 客户端设的，**它重启时可能把 `NO_PROXY` 覆盖回去**。
发现失效就去客户端自己的设置里找 NO_PROXY / 例外字段填同样的值。

**判定标准**：`tailscale netcheck` 里那行 `tshttpproxy: using proxy ...` **必须消失**。
（实测：用户级写入 + 在 PS 里注入同样变量后，该行消失 ✓）

## 3. 结论二：修好代理不等于延迟就低

代理修好后，本机 DERP 延迟**没变**（美区 ~165ms，东京反而 227ms）。查过原因：

```powershell
Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Select Name,InterfaceDescription
Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select NextHop,InterfaceAlias,RouteMetric
```

结果：**没有 TUN/虚拟网卡接管默认路由**（默认路由直接走 WLAN）✓
所以不是"IP 层被代理"，而是**主机自己的国际出口路径就差**（到美区比到东京还快 = 国际流量绕美）。
这种情况下**换 DERP 也没用** —— 中继不是病根。

## 4. 直连才是根治，但要看 NAT 脸色

```powershell
tailscale netcheck        # 看 UDP / MappingVariesByDestIP / PortMapping
tailscale status          # 看对端是 direct 还是 relay "xxx"
tailscale ping <对端名>    # 直接给出路径与 RTT
```

本机基线（2026-10-13）：

```
UDP: true
MappingVariesByDestIP: true     ← 对称 NAT，打洞基本无望
PortMapping:                    ← 空：没有 UPnP / NAT-PMP
网关 172.20.32.254              ← NAT 化的网络，路由器做端口转发未必可行
v2339fa (android): relay "tok"
tailscale ping: 333ms / 1.53s / 432ms / … / 4.738s   ← 抖动到 4.7 秒
direct connection not established
```

**能做到的话**：上游放行 **UDP 41641**（端口转发到本机），直连成功后绕开中继。
**做不到**：只能接受中继 —— 但至少控制面不再绕美国了（第 2 节）。

## 5. 另一半：手机端的渲染

链路修好后，长会话在手机上**每个 token 重渲染整棵 DOM** 仍然卡，而且浏览器内存吃紧时
会丢弃标签页 → 表现成"经常重新加载"。

- 测法：手机上开一个**全新会话**让它流式回一段 —— 流畅就说明是渲染而非网络
- 治本：用 `dsh-context-guard` 的 handoff 流程（压缩 N 次后提示开新会话），别让会话无限变长

## 6. 回滚：改代理配置前先记下原值

本次排查中一度把 `ProxyEnable` 置 0 且 PAC 路径写错（用户目录是 `nana-` 不是 `nana`），
会直接断掉代理。原值与该还原命令：

```powershell
# 原值：ProxyEnable=1, ProxyServer=127.0.0.1:2080, ProxyOverride=127.0.0.1;<local>
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL /f
```

**教训**：改系统代理前先 `reg query` 记下三项原值；用 PAC 就先把 PAC 文件写成功再切过去。

## 7. 改后实测（2026-10-13，管理员写入系统级 NO_PROXY + 重启服务后）

```
系统级 NO_PROXY : localhost,127.0.0.1,::1,.tailscale.com,…  ✓ 已生效
netcheck        : 'tshttpproxy: using proxy' 那行**消失** ✓
tailscale ping  : 1.339s / 382ms / 323ms / 344ms / 383ms / 424ms
                  改前对照：333ms / 1.53s / 432ms / 945ms / 842ms / **4.738s**
                  → 4.7 秒的尖峰消失，抖动大幅收敛 ✓
tailscale status: v2339fa 仍是 relay "tok"；direct connection not established
Nearest DERP    : San Francisco 161ms（本机国际出口绕美，换 DERP 无用）
```

**结论**：控制面不再绕美国、抖动收敛；剩余 ~350ms 的"地板"是中继路径本身
（手机 → 东京 DERP → 本机），要再降只能打通直连（上游放行 UDP 41641）。
手机端若仍觉得卡，去做第 5 节（渲染）。
