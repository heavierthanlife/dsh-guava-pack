#!/usr/bin/env node
/**
 * 验证 dsh-remote-entry 能把 DSH 的 Host 通道（WebSocket）透传过去。
 *
 * 背景：DSH Web UI 的 Host 连接走 `ws(s)://<authority>/api/remote.mux`。反代若只改
 * `Host` 而不改 `Origin`，DSH 的 Origin/Host 同源校验会拒绝，表现是界面能打开、
 * 但侧栏没有 session、设置里提示 "permission catalog has no active Host connection"。
 *
 * 用法（本机、DSH 在跑）：
 *   node tools/tests/ws-mux.mjs                    # 默认直连 127.0.0.1:3080 与反代 3098
 *   DSH_REMOTE_BASE=http://10.8.0.42:3098 node tools/tests/ws-mux.mjs
 *
 * 断言：
 *   1. 直连 `/api/remote.mux` 必须 101；
 *   2. 反代必须也是 101，且 `sec-websocket-accept` 与直连一致（同一份握手）。
 *
 * @module tools/tests/ws-mux
 */

import http from 'node:http';

const PROXY = process.env.DSH_REMOTE_BASE || 'http://10.8.0.42:3098';
const UPSTREAM = process.env.DSH_UPSTREAM || 'http://127.0.0.1:3080';
const MUX_PATH = '/api/remote.mux';

/** 经反代走一遍 /go → token → cookie，拿到可用的登录 cookie。 */
async function cookieViaProxy(base) {
  const go = await fetch(`${base}/go`, { redirect: 'manual' });
  const location = go.headers.get('location');
  if (location === null) throw new Error('反代 /go 没有返回 Location');
  const exchange = await fetch(`${base}${location}`, { redirect: 'manual' });
  const setCookies = exchange.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) throw new Error('token 交换没有下发 cookie');
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

/** 对某个 authority 发起一次 WS 握手，返回结果描述。 */
function handshake(baseUrl, cookie) {
  const url = new URL(baseUrl);
  const host = url.hostname;
  const port = Number(url.port || 80);
  return new Promise((resolve) => {
    const request = http.request({
      host,
      port,
      path: MUX_PATH,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Origin: `http://${host}:${port}`,
        cookie,
      },
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ ok: true, detail: `101 accept=${response.headers['sec-websocket-accept'] ?? '?'}` });
    });
    request.on('response', (response) => {
      response.resume();
      resolve({ ok: false, detail: `${response.statusCode} ${response.statusMessage}` });
    });
    request.on('error', (error) => resolve({ ok: false, detail: `ERR ${error.code || error.message}` }));
    request.setTimeout(5000, () => {
      request.destroy();
      resolve({ ok: false, detail: 'TIMEOUT' });
    });
    request.end();
  });
}

const cookie = await cookieViaProxy(PROXY);
const direct = await handshake(UPSTREAM, cookie);
const proxied = await handshake(PROXY, cookie);

const line = (label, result) => `  ${result.ok ? '✅' : '❌'} ${label.padEnd(34)} ${result.detail}`;
console.log(line(`直连 ${UPSTREAM}${MUX_PATH}`, direct));
console.log(line(`反代 ${PROXY}${MUX_PATH}`, proxied));

let failures = 0;
if (!direct.ok) {
  failures += 1;
  console.log('  ⚠️ 直连都不通 —— 先确认 DSH 在跑、cookie 有效');
}
if (!proxied.ok) {
  failures += 1;
  console.log('  ⚠️ 反代握手失败 —— 检查 ops/dsh-remote-entry.mjs 的 upgrade 分支是否改写 Origin');
}
if (direct.ok && proxied.ok) {
  const sameAccept = direct.detail.split('accept=')[1] === proxied.detail.split('accept=')[1];
  console.log(`  ${sameAccept ? '✅' : '❌'} 两条路径的 Sec-WebSocket-Accept 一致`);
  if (!sameAccept) failures += 1;
}
process.exit(failures === 0 ? 0 : 1);
