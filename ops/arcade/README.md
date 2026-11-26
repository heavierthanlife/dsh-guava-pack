# DSH Arcade — VPS 休闲角

一组纯静态小页面，只走 tailnet，令牌路径认证，非 root 运行。
零依赖、零构建、断网可用。

```
http://100.109.125.37:8091/<令牌>/
```

令牌在 `/etc/dsh-arcade/token`（600 root）。

## 为什么单独一个服务，而不是塞进 dsh-console

| | dsh-console（:8090） | dsh-arcade（:8091） |
|---|---|---|
| 跑什么 | 运维动作、restic、systemctl | 只发静态文件 |
| 用户 | `root`（需要 systemctl/runuser） | `dsh-arcade`（nologin、无家目录） |
| 被攻破的后果 | 能操作备份与服务 | 只能读到几个 HTML |

娱乐页面是"嘴上说没人在意、真出问题最麻烦"的那类东西。把它和 root 权限的
运维面板合在一个进程里，等于给一个 2048 游戏发了 restic 的钥匙。
分开的代价只是一个 systemd 单元，收益是权限面差一个数量级。

## 认证：为什么用路径令牌而不是 Basic

`dsh-console` 用 HTTP Basic（用户名 `dsh`），这在桌面浏览器上没问题，但手机上
实测踩过：Android 键盘会把用户名首字母自动大写，导致一直 401
（见 `ops/tunnel/PORTS.md` 里 miniserve 同一条教训）。所以这里沿用 miniserve 的
思路 —— **随机路径当令牌**：

```
第一次：http://100.109.125.37:8091/<前缀>/   → 200，同时种 cookie
之后：  http://100.109.125.37:8091/           → 302 到 <前缀>/
错误路径：                                    → 404（不承认前缀存在）
```

cookie 里存的是**前缀的 sha256**，不是前缀本身 —— 即使同域的其他脚本读到
cookie，也拿不到能拼进 URL 的令牌。服务端两种方式都认（URL 前缀或 cookie）。

轮换令牌：

```bash
ssh -F /dev/null root@100.109.125.37 '
  rm -f /etc/dsh-arcade/token && bash /tmp/dsh-arcade/install.sh'
# 旧 cookie 因为哈希对不上立即失效
```

## 页面

| 路由 | 内容 |
|---|---|
| `index.html` | 统一首页（入口卡） |
| `g2048.html` | 2048 |
| `snake.html` | 贪吃蛇 |
| `mines.html` | 扫雷（初/中/高三档，经典 95 外观：LED 计数器 + 笑脸；右键插旗/取消，旗子格左键无效，中键和弦） |
| `tetris.html` | 俄罗斯方块 |
| `relax.html` | 白噪音（Web Audio 合成）· 呼吸引导 · 番茄钟 |
| `decide.html` | 转盘 / 骰子 / 抽签 |
| `pixel.html` | 像素画板（导出 PNG） |

存档只写浏览器 `localStorage`，键名前缀 `arcade.`。换设备不同步，清浏览器数据就没了。

写新页面前**必须读** [`PAGE-CONTRACT.md`](PAGE-CONTRACT.md)：文件命名、顶栏结构、
相对路径（前导斜杠会丢掉令牌前缀）、`localStorage` 必须包 try、禁止外部资源。

## 安装 / 升级 / 回滚

```bash
# 安装或升级（同一命令，幂等；令牌与既有页面保持不变）
scp -F /dev/null ops/arcade/{server.mjs,install.sh,PAGE-CONTRACT.md,README.md} \
    root@100.109.125.37:/tmp/dsh-arcade/
scp -F /dev/null -r ops/arcade/public root@100.109.125.37:/tmp/dsh-arcade/
ssh -F /dev/null root@100.109.125.37 'bash /tmp/dsh-arcade/install.sh'

# 只看链接
ssh -F /dev/null root@100.109.125.37 'cat /etc/dsh-arcade/token'

# 回滚（只删本服务）
ssh -F /dev/null root@100.109.125.37 '
  systemctl disable --now dsh-arcade.service
  rm -f /etc/systemd/system/dsh-arcade.service
  systemctl daemon-reload
  rm -rf /opt/dsh-arcade'
# 连令牌一起删（重装会生成新令牌）：rm -rf /etc/dsh-arcade
```

安装脚本会自检四件事，任何一条不过就报错退出，不会留下"装成功了但打不开"：

1. 单元 active；
2. `100.109.125.37:8091` 在监听；
3. **不带令牌访问 `/` 返回 404**（返回 200 等于把页面公开给整个 tailnet）；
4. 带令牌访问首页返回 200，且 `/../../etc/passwd` 不返回 200
   （用 `curl --path-as-is`，否则 curl 自己就把 `..` 规范化了，测不到服务端）。

## 安全设计

- **只绑 tailnet** `100.109.125.37:8091`，公网不可见（与所有其他服务同一条原则）；
- **非 root**：`User=dsh-arcade`，nologin、无家目录；
- 令牌文件 600 root，用 systemd `LoadCredential` 以只读方式交给服务
  （直接读会 EACCES；chmod 644 则是错的做法）；
- **路径穿越三重防线**：拒绝 NUL、拒绝任何 `..` 段、`realpath` 之后必须仍在
  静态根内（防符号链接逃逸）；
- **扩展名白名单**：只发 html/css/js/svg/png/webp/ico/json/webmanifest；
- **Host 白名单**：陌生 Host 返回 421（防 DNS rebinding）；
- 只接受 GET/HEAD，其余 405；
- 服务**永远不执行命令、不读系统状态** —— 它连 `child_process` 都没 import；
- 沙箱：`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、`PrivateDevices`、
  `NoNewPrivileges`、`RestrictNamespaces`、`MemoryMax=192M`。

## 门禁

```bash
node tools/tests/arcade-pages.mjs    # 静态：页面骨架、无外链、无绝对路径、localStorage 包 try
node tools/tests/arcade-server.mjs   # 行为：真起进程测鉴权/穿越/符号链接/扩展名/Host
```

两个都在 `npm test` 里。`arcade-server.mjs` 只在 `127.0.0.1` 上起临时端口，
不碰 VPS、不碰 8091。

## 资源占用

竞品是"一个静态文件服务器"：单进程 Node、常驻 RSS 约 40 MB、
`NODE_OPTIONS=--max-semi-space-size=2` 压小新生代、`MemoryMax=192M` 兜底。
VPS 是 2 vCPU / 1.6 GB，这点开销可以忽略（load average 长期 0.0x）。
