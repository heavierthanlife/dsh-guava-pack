#!/usr/bin/env node
/**
 * tailnet 固定入口：把手机上"永远不变的一个地址"重定向到 DSH 当前的带 token 链接。
 *
 * ## 为什么需要它
 *
 * DSH 的登录 token **每个进程重新生成**，而 tailscale serve 暴露的地址是固定的。
 * 于是每次 DSH 重启，手机上收藏的链接就失效，要回电脑上「设置 → 连接信息」重新复制
 * —— 这是日常最烦的一步。
 *
 * 本服务挂在 `tailscale serve --set-path /go http://127.0.0.1:3099` 后面：
 *
 *     https://<tailnet>/go  →  302  /?token=<当前 token>  →  DSH 设置 cookie 后进入 UI
 *
 * 手机只需收藏 `https://<tailnet>/go`，token 轮换由这里自动跟随。
 *
 * ## 安全边界（重要）
 *
 * - 只监听 **127.0.0.1**：外部只能经 tailscale serve 的 tailnet-only 入口访问，
 *   不对局域网/公网直接暴露；
 * - 换句话说：能打开 `/go` 的设备本来就必须已经在你 tailnet 里（Tailscale 的
 *   身份与 ACL 是这一层唯一的门）。**不要**把这个端口通过 funnel 暴露到公网；
 * - token 仍然会被发到浏览器（和手动复制链接等价），但不会写入日志。
 *
 * ## token 从哪读
 *
 * DSH 启动时把 `dsh web: http://127.0.0.1:3080/?token=…` 打到 stdout，
 * systemd 单元把它 append 到 `$DSH_HOME/logs/web-run.log`（这是唯一权威来源；
 * 不猜、不缓存旧 token）。每次请求现读最后一行，所以 DSH 一重启就自动跟上。
 *
 * ## 用法
 *
 *   node ops/tailnet-entry.mjs            # 监听 127.0.0.1:3099
 *   DSH_ENTRY_PORT=3099 node …
 *
 * 配套（本机已安装）：
 *   systemctl --user enable --now dsh-entry.service
 *   tailscale serve --bg --https=443 --set-path=/go http://127.0.0.1:3099
 *
 * @module ops/tailnet-entry
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
const LOG_FILE = process.env.DSH_WEB_LOG || join(DSH_HOME, 'logs', 'web-run.log');
const PORT = Number(process.env.DSH_ENTRY_PORT || 3099);
const HOST = '127.0.0.1';

/** 从 DSH 启动日志里取**最后一次**打印的 token。 */
export function readCurrentToken(logFile = LOG_FILE) {
  let text;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return undefined;
  }
  // 只留最后 64KB：日志可能很大，token 只可能出现在最新一段。
  const tail = text.length > 65536 ? text.slice(-65536) : text;
  const matches = [...tail.matchAll(/dsh web: http:\/\/[^\s]*?\?token=([A-Za-z0-9_-]+)/g)];
  const last = matches[matches.length - 1];
  return last === undefined ? undefined : last[1];
}

/** 只接受纯 token 形状（防止日志里混进奇怪字符拼出 URL）。 */
function safeToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : undefined;
}

const server = createServer((req, res) => {
  const pathname = (() => {
    try {
      return new URL(req.url || '/', `http://${HOST}`).pathname;
    } catch {
      return '/';
    }
  })();

  if (pathname === '/health' || pathname === '/go/health') {
    const token = safeToken(readCurrentToken());
    res.writeHead(token === undefined ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: token !== undefined, hasToken: token !== undefined, log: LOG_FILE }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed\n');
    return;
  }

  const token = safeToken(readCurrentToken());
  if (token === undefined) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      'DSH 还没打印登录 token。\n' +
        `日志: ${LOG_FILE}\n` +
        '检查：systemctl --user status dsh.service\n',
    );
    return;
  }

  // 相对跳转（不带 scheme/host）：无论从 MagicDNS、IP 还是别的主机名进来都成立。
  res.writeHead(302, {
    location: `/?token=${token}`,
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('redirecting to DSH\n');
});

server.listen(PORT, HOST, () => {
  console.log(`[dsh-entry] listening on http://${HOST}:${PORT} → token from ${LOG_FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
