#!/usr/bin/env node
/**
 * dsh-remote-entry — 让 DSH 在「公司 VPN 网段」里可用（不改 DSH 的监听地址）。
 *
 * ## 为什么需要它
 *
 * DSH 的 `webserver.host` **只接受具体 IP，明确拒绝 `0.0.0.0`**（上游认为绑所有网卡
 * 等于把 RCE 暴露到网络）。但公司 VPN 给的地址每次连接都可能变（`10.8.0.x`），
 * 直接把 DSH 绑上去，VPN 一断或地址一变，服务就绑不上、起不来。
 *
 * 所以这里不碰 DSH：它继续只听 `127.0.0.1:3080`，本进程对外监听一个端口，
 * 把请求**原样转发**过去，并把 `Host` 改写成 `127.0.0.1:3080`：
 *
 *   · 改写成 loopback 之后，DSH 的 Host/Origin 信任判定天然通过（不需要改启动参数、
 *     不需要 `--trusted-host`）；
 *   · 浏览器侧的 cookie 是「按它自己看到的 authority」存的，而我们转发时 Host 恒为
 *     loopback，所以 DSH 解出来的 authority 与签发时一致 —— 登录态正常；
 *   · 于是 `/go → 302 → /?token=…` 这条既有入口逻辑在 VPN 里同样成立。
 *
 * ## 安全边界
 *
 * - 只允许 **回环 / VPN 网段（10.8.0.0/24）/ Tailscale CGNAT（100.64.0.0/10）** 访问，
 *   其它来源（例如公司 172.20.x 内网里的其他人）一律 403 —— 因为它会经 `/go` 发 token；
 * - 不做任何请求体改写、不落盘、不记录 token。
 *
 * ## 用法
 *
 *   node ops/dsh-remote-entry.mjs             # 监听 0.0.0.0:3098
 *   DSH_REMOTE_PORT=3098 node ops/dsh-remote-entry.mjs
 *
 *   # 手机上收藏（token 轮换自动跟随）：
 *   http://<VPN 里本机的 10.8.0.x>:3098/go
 *
 * @module ops/dsh-remote-entry
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.DSH_REMOTE_PORT || 3098);
const HOST = process.env.DSH_REMOTE_BIND || '0.0.0.0';
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.DSH_PORT || 3080);
const DSH_HOME = process.env.DSH_HOME || join(homedir(), 'dsh');
const LOG_FILE = join(DSH_HOME, 'logs', 'web-run.log');

/** 允许的网段（CIDR）：VPN 子网 + Tailscale CGNAT。 */
const ALLOW_CIDRS = [
  [ip4ToInt('10.8.0.0'), 24],
  [ip4ToInt('100.64.0.0'), 10],
];
/** 精确允许（回环）。 */
const ALLOW_EXACT = new Set(['127.0.0.1', '::1']);

/** "a.b.c.d" → 32 位整数；非法返回 undefined。 */
function ip4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/** 来源是否允许（字符串形式的 ipv4 / ipv6）。 */
function sourceAllowed(addr) {
  const ip = String(addr || '').replace(/^::ffff:/, '');
  if (ALLOW_EXACT.has(ip)) return true;
  const value = ip4ToInt(ip);
  if (value === undefined) return false;
  return ALLOW_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** 从日志里取当前 DSH token（唯一权威来源，不缓存旧值）。 */
function readCurrentToken() {
  let text;
  try {
    text = readFileSync(LOG_FILE, 'utf8');
  } catch {
    return undefined;
  }
  const matches = [...text.matchAll(/dsh web: http:\/\/[^\s]*?\?token=([A-Za-z0-9_-]+)/g)];
  const last = matches.at(-1);
  return last === undefined ? undefined : last[1];
}

/** `/go`：302 到带当前 token 的相对路径（浏览器会把它解析成当前 authority）。 */
function handleGo(res) {
  const token = readCurrentToken();
  if (token === undefined) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`DSH 还没打印登录 token（日志: ${LOG_FILE}）\n检查: systemctl --user status dsh.service\n`);
    return;
  }
  res.writeHead(302, { location: `/?token=${token}`, 'cache-control': 'no-store' });
  res.end('redirecting\n');
}

/** 反向代理一个请求（含 SSE 流式与 WebSocket 升级）。 */
function proxy(req, res) {
  const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  // 转发给上游时不要带逐跳头
  delete headers.connection;
  delete headers['keep-alive'];

  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (up) => {
      // SSE 必须不缓冲：直通状态码与响应头，然后管道式写出。
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`upstream error: ${error.code || error.message}\n`);
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (!sourceAllowed(req.socket.remoteAddress)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden: 只允许回环 / VPN 网段 / tailnet 访问\n');
    return;
  }
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  if (pathname === '/go' || pathname === '/go/') {
    handleGo(res);
    return;
  }
  proxy(req, res);
});

// WebSocket / HTTP upgrade：直接建两条 socket 对拷。
server.on('upgrade', (req, socket, head) => {
  if (!sourceAllowed(socket.remoteAddress)) {
    socket.destroy();
    return;
  }
  const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  const up = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers,
  });
  up.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  up.on('error', () => socket.destroy());
  up.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[dsh-remote-entry] listening on http://${HOST}:${PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log(`[dsh-remote-entry] 手机入口: http://<VPN 里的 10.8.0.x>:${PORT}/go`);
});
