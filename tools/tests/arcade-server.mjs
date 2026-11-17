#!/usr/bin/env node
/**
 * tools/tests/arcade-server.mjs — 休闲角服务器的**行为**门禁。
 *
 * ## 为什么必须真起进程
 *
 * 这套服务的全部安全边界都在一个 `createServer` 回调里：路径令牌、cookie 换取、
 * Host 白名单、`..` 穿越、符号链接越界、扩展名白名单。这些**没有一条**是静态
 * grep 能证明的 —— 一个 `startsWith` 写错、一个 `decodeURIComponent` 放错位置，
 * 源码看起来都对，实际却把 `/etc/passwd` 发出去了。
 *
 * 所以这里起一个真实进程，真的发 HTTP 请求，尤其是**编码过的穿越尝试**
 * （`%2e%2e%2f`、`..%2f`、双写 `....//`），因为浏览器的 URL 规范化会在到达
 * 服务端前就吃掉一部分，只有原始请求能测到服务端自己的防线。
 *
 * 全程绑定 `127.0.0.1` 与临时端口，不碰 VPS、不碰 8091。
 *
 * 用法：node tools/tests/arcade-server.mjs [--keep]
 *
 * @module tools/tests/arcade-server
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const SERVER = join(PACK, 'ops', 'arcade', 'server.mjs');
const PUBLIC = join(PACK, 'ops', 'arcade', 'public');
const KEEP = process.argv.includes('--keep');

const TOKEN = 'abcdef0123456789abcdef0123456789';
const COOKIE_NAME = 'dsh_arcade';

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/** 原始 HTTP 请求（不用 fetch：fetch 会规范化路径与拒绝某些头）。 */
function raw(port, { path, method = 'GET', headers = {}, host }) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { host: host ?? `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-arcade-'));
  // 静态根直接指向真实 public/（只读用它），另外在里面造一个指向 /etc 的符号链接。
  // 注意：符号链接必须造在真实 public 目录里才有意义 —— 但那会污染仓库，
  // 所以造一个临时根，把 public 拷进去。
  const staticRoot = join(root, 'public');
  mkdirSync(staticRoot, { recursive: true });
  // 用 cp -a 保持字节一致
  await new Promise((resolve, reject) => {
    const cp = spawn('cp', ['-a', `${PUBLIC}/.`, staticRoot], { stdio: 'inherit' });
    cp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`cp 失败 ${code}`))));
  });
  // 越界符号链接：字符串层面完全合法，realpath 之后跑出静态根
  symlinkSync('/etc', join(staticRoot, 'escape'));

  const secretDir = join(root, 'secret');
  mkdirSync(secretDir);
  writeFileSync(join(secretDir, 'secret.txt'), 'TOP-SECRET\n');
  // 静态根之外、但通过 .. 想拿到的文件
  writeFileSync(join(root, 'outside.txt'), 'OUTSIDE\n');
  // 未知扩展名：必须不发
  writeFileSync(join(staticRoot, 'evil.sh'), '#!/bin/sh\necho hi\n');

  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

  const port = 18091 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DSH_ARCADE_BIND: '127.0.0.1',
      DSH_ARCADE_PORT: String(port),
      DSH_ARCADE_ROOT: staticRoot,
      DSH_ARCADE_TOKEN_FILE: tokenFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const stop = () => {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  };

  try {
    // 等它开始监听（最多 15 秒）
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`进程提前退出：\n${stderr.slice(-2000)}`);
      try {
        await raw(port, { path: '/' });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    if (!ready) throw new Error(`15 秒内没起来。stdout=${stdout.slice(-800)} stderr=${stderr.slice(-800)}`);

    console.log('\n未授权访问');
    {
      const res = await raw(port, { path: '/' });
      check('根路径返回 404（不暴露"存在前缀"）', res.status === 404, `status=${res.status}`);
      check('404 不带 cookie', res.headers['set-cookie'] === undefined);
    }
    {
      const res = await raw(port, { path: '/index.html' });
      check('不带令牌直接要文件 → 404', res.status === 404, `status=${res.status}`);
    }
    {
      const res = await raw(port, { path: '/wrongprefix/' });
      check('错令牌 → 404', res.status === 404, `status=${res.status}`);
    }

    console.log('\n令牌换取 cookie');
    {
      const res = await raw(port, { path: `/${TOKEN}/` });
      check('带令牌访问首页 → 200', res.status === 200, `status=${res.status} body=${res.body.slice(0, 120)}`);
      check('内容是首页 HTML', res.body.includes('<title>休闲角 · DSH</title>'));
      const cookie = res.headers['set-cookie']?.[0] ?? '';
      check('下发 cookie', cookie.includes(`${COOKIE_NAME}=`), cookie.slice(0, 80));
      check('cookie 是 HttpOnly', /HttpOnly/i.test(cookie));
      check('cookie 是 SameSite=Lax', /SameSite=Lax/i.test(cookie));
      check('cookie 不含令牌明文', !cookie.includes(TOKEN), 'cookie 里放了路径令牌就等于明文泄漏');
    }

    console.log('\n用 cookie 访问 /');
    {
      // 从上一步拿到的 cookie 是前缀的 sha256，这里直接算一遍
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(TOKEN).digest('hex');
      const res = await raw(port, { path: '/', headers: { cookie: `${COOKIE_NAME}=${hash}` } });
      check('已授权访问 / → 302 到前缀下', res.status === 302, `status=${res.status}`);
      check('Location 指向 /<token>/', res.headers.location === `/${TOKEN}/`, res.headers.location);
    }
    {
      const res = await raw(port, { path: '/', headers: { cookie: `${COOKIE_NAME}=deadbeef` } });
      check('错 cookie 仍是 404', res.status === 404, `status=${res.status}`);
    }

    console.log('\n正常页面');
    for (const page of ['index.html', 'g2048.html', 'snake.html', 'mines.html', 'tetris.html',
      'relax.html', 'decide.html', 'pixel.html', 'shared.css', 'arcade.js']) {
      const res = await raw(port, { path: `/${TOKEN}/${page}` });
      check(`${page} → 200`, res.status === 200, `status=${res.status}`);
    }
    {
      const res = await raw(port, { path: `/${TOKEN}` });
      check('/<token>（无斜杠）→ 200 首页', res.status === 200, `status=${res.status}`);
    }

    console.log('\n路径穿越');
    // 这些是**服务端**防线：raw 请求不经过 URL 规范化
    const traversals = [
      `/${TOKEN}/../outside.txt`,
      `/${TOKEN}/../../etc/passwd`,
      `/${TOKEN}/%2e%2e/outside.txt`,
      `/${TOKEN}/%2e%2e%2foutside.txt`,
      `/${TOKEN}/....//outside.txt`,
      `/${TOKEN}/..%2f..%2fetc%2fpasswd`,
      `/${TOKEN}/escape/passwd`,          // 符号链接逃逸
      `/${TOKEN}/escape/shadow`,
    ];
    for (const attempt of traversals) {
      const res = await raw(port, { path: attempt });
      const leaked = res.body.includes('root:x:') || res.body.includes('OUTSIDE')
        || res.body.includes('TOP-SECRET');
      check(`穿越被拒：${attempt}`, res.status === 404 && !leaked,
        `status=${res.status} leaked=${leaked}`);
    }
    {
      // NUL 截断
      const res = await raw(port, { path: `/${TOKEN}/index.html%00.png` });
      check('NUL 字节不生效', res.status === 404 || res.status === 200,
        `status=${res.status}（只要不是把别的内容发出来即可）`);
      check('NUL 请求没有泄漏越界内容', !res.body.includes('root:x:'));
    }

    console.log('\n扩展名白名单');
    {
      const res = await raw(port, { path: `/${TOKEN}/evil.sh` });
      check('未知扩展名 .sh → 404', res.status === 404, `status=${res.status}`);
      check('没有把脚本内容发出来', !res.body.includes('#!/bin/sh'));
    }

    console.log('\n方法与 Host');
    {
      const res = await raw(port, { path: `/${TOKEN}/`, method: 'POST', headers: { 'content-length': '0' } });
      check('POST → 405', res.status === 405, `status=${res.status}`);
      check('405 带 Allow 头', res.headers.allow === 'GET, HEAD', res.headers.allow);
    }
    {
      const res = await raw(port, { path: `/${TOKEN}/`, method: 'HEAD' });
      check('HEAD → 200 且无 body', res.status === 200 && res.body === '', `status=${res.status} len=${res.body.length}`);
    }
    {
      const res = await raw(port, { path: `/${TOKEN}/`, host: 'evil.example.com' });
      check('陌生 Host → 421（防 DNS rebinding）', res.status === 421, `status=${res.status}`);
    }
    {
      const res = await raw(port, { path: `/${TOKEN}/`, host: `localhost:${port}` });
      check('localhost Host → 200', res.status === 200, `status=${res.status}`);
    }

    console.log('\n令牌文件校验');
    {
      // 令牌太短必须拒绝启动 —— 弱令牌等于没有访问控制
      const weakRoot = mkdtempSync(join(tmpdir(), 'dsh-arcade-weak-'));
      const weakToken = join(weakRoot, 'token');
      writeFileSync(weakToken, 'short\n', { mode: 0o600 });
      const weakPort = port + 1;
      const weak = spawn(process.execPath, [SERVER], {
        env: {
          ...process.env,
          DSH_ARCADE_BIND: '127.0.0.1',
          DSH_ARCADE_PORT: String(weakPort),
          DSH_ARCADE_ROOT: staticRoot,
          DSH_ARCADE_TOKEN_FILE: weakToken,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let weakErr = '';
      weak.stderr.on('data', (d) => { weakErr += d; });
      const exitCode = await new Promise((resolve) => {
        weak.on('exit', (code) => resolve(code));
        setTimeout(() => { try { weak.kill(); } catch { /* 已退出 */ } }, 8000);
      });
      check('过短令牌 → 启动失败（非 0 退出）', exitCode !== 0, `exit=${exitCode}`);
      check('失败信息说明了原因', /16-64/.test(weakErr) || /令牌/.test(weakErr), weakErr.slice(-200));
      rmSync(weakRoot, { recursive: true, force: true });
    }

    console.log('\n日志卫生');
    check('stdout 里没有令牌明文', !stdout.includes(TOKEN), '日志会进 journal，等于把令牌写盘');
    check('stdout 说明了监听地址', /监听/.test(stdout), stdout.slice(-200));
  } finally {
    stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!KEEP) rmSync(root, { recursive: true, force: true });
    else console.log(`\n[arcade-server] 保留临时目录：${root}`);
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} arcade-server: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n❌ arcade-server 框架错误：${error?.stack ?? error}`);
  process.exitCode = 1;
});
