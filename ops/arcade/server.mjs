#!/usr/bin/env node
// DSH Arcade — VPS 休闲页服务器（单文件、仅 Node 标准库、零依赖）
//
// 与 dsh-console 的分工：
//   * dsh-console（:8090, root, Basic 认证）负责运维动作，权限面必须小；
//   * 本服务（:8091）只发静态小游戏，**永远不执行任何命令**、不读系统状态。
//     它故意用非 root 系统用户运行，即使被攻破也拿不到 restic / systemctl。
//
// 认证：随机路径前缀当令牌（与 miniserve 同一套思路）。
//   为什么不用 Basic：手机上输密码键盘容易把首字母打大写，实测踩过
//   （见 PORTS.md「miniserve Basic always 401 on phone」）。路径令牌点一次就记住。
//   第一次访问 `/` → 302 到 `/<PREFIX>/`；带 cookie 的用户直接进。
//   访问错路径一律 404（不告诉对方"有个前缀存在"）。
//
// 环境变量（systemd 单元里固定）：
//   DSH_ARCADE_BIND      绑定地址（默认 100.109.125.37，绝不 0.0.0.0）
//   DSH_ARCADE_PORT      默认 8091
//   DSH_ARCADE_ROOT      静态根目录（默认 ./public）
//   DSH_ARCADE_TOKEN_FILE 令牌文件（600，内容即路径前缀）

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BIND = process.env.DSH_ARCADE_BIND ?? '100.109.125.37';
const PORT = Number(process.env.DSH_ARCADE_PORT ?? 8091);
const ROOT = path.resolve(process.env.DSH_ARCADE_ROOT ?? path.join(__dirname, 'public'));
const TOKEN_FILE = process.env.DSH_ARCADE_TOKEN_FILE ?? '/etc/dsh-arcade/token';

/** 库外扩展名一律不发（本服务只需要页面与其素材）。 */
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}));

const COOKIE_NAME = 'dsh_arcade';
/** 30 天：和 dsh-console 的令牌 cookie 保持一致，避免一个过期一个没过期。 */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
/** 令牌轮换后旧 cookie 立即失效靠这个哈希前缀校验（见 isAuthorized）。 */
let prefix = '';
let prefixHash = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * 恒定时间比较两个字符串，先各自 sha256 规整长度。
 * 直接用 timingSafeEqual 要求等长，长度本身就泄漏信息。
 */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** 读令牌文件。失败就让服务起不来 —— 没令牌的"公开娱乐页"不该悄悄存在。 */
async function loadToken() {
  const raw = await readFile(TOKEN_FILE, 'utf8');
  const value = raw.trim();
  if (!/^[a-z0-9]{16,64}$/i.test(value)) {
    throw new Error(`${TOKEN_FILE} 内容不是 16-64 位字母数字（当前长度 ${value.length}）`);
  }
  prefix = value;
  prefixHash = createHash('sha256').update(prefix).digest('hex');
  log(`令牌已加载（前缀长度 ${prefix.length}，内容不打印）`);
}

/** 从 Cookie 头取我们的会话值。 */
function readCookie(header) {
  if (typeof header !== 'string' || header === '') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * 是否已授权。
 *
 * 会话 cookie 里存的就是**前缀的 sha256**（不是前缀本身）：即使 cookie 被同域的
 * 别的脚本读到，也拿不到能直接拼进 URL 的路径令牌。代价是每次请求要算一次哈希，
 * 对 1.6 GB 的小机器完全可接受（单次 < 1µs）。
 */
function isAuthorized(req, urlPrefix) {
  if (urlPrefix === prefix) return true;
  const cookie = readCookie(req.headers.cookie);
  return cookie !== null && prefixHash !== null && safeEqual(cookie, prefixHash);
}

/**
 * 把 URL 路径映射到磁盘路径，并拒绝一切越界。
 *
 * 三道防线：拒绝含 NUL、拒绝任何 `..` 段、解析后必须仍在 ROOT 之内。
 * 只靠 normalize 不够 —— 符号链接也能把解析结果带出 ROOT，所以最后再用
 * realpath 复核（见 resolveInsideRoot）。
 */
function resolveFile(relative) {
  if (relative.includes('\0')) return null;
  const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return null;
  const absolute = path.resolve(ROOT, ...segments);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) return null;
  return absolute;
}

/**
 * 符号链接复核：真实路径也必须在 ROOT 内。
 *
 * 为什么不能只靠 resolveFile 的字符串检查：`public/link -> /etc` 这种符号链接
 * 在字符串层面完全合法（`public/link/passwd` 没有 `..`，也前缀匹配 ROOT），
 * 但 realpath 之后跑到 ROOT 外面去了。所以打开前必须再核一次真实路径。
 *
 * 返回值是**真实路径**（用它去读，别用 originalPath），解析失败/越界返回 null。
 */
async function resolveInsideRoot(absolute) {
  if (absolute === null) return null;
  let real;
  try {
    real = await realpath(absolute);
  } catch {
    return null; // 不存在 / 权限不足：一律按 404，不区分（区分等于探测工具）
  }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) return null;
  try {
    const info = await stat(real);
    if (!info.isFile()) return null; // 目录由调用方拼过 index.html，这里只发文件
  } catch {
    return null;
  }
  return real;
}

function send(res, status, headers, body) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  if (body === undefined) res.end();
  else res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host ?? 'localhost'}`);
    const host = req.headers.host ?? '';

    // Host 白名单：防 DNS rebinding（tailnet 里也可能有奇怪的东西）。
    // 只接受"绑定地址:端口"与 localhost 变体。
    const allowedHosts = new Set([
      `${BIND}:${PORT}`,
      `localhost:${PORT}`,
      `127.0.0.1:${PORT}`,
      `[::1]:${PORT}`,
    ]);
    if (host !== '' && !allowedHosts.has(host)) {
      send(res, 421, { 'content-type': 'text/plain; charset=utf-8' }, 'misdirected request');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'method not allowed');
      return;
    }

    // 路径令牌：`/<prefix>/...` 或 `/<prefix>`
    const pathname = decodeURIComponent(url.pathname);
    let rest = null;
    if (pathname === `/${prefix}` || pathname.startsWith(`/${prefix}/`)) {
      rest = pathname.slice(prefix.length + 1) || '/';
    }

    // 未知路径 → 404（不暴露"存在一个前缀"这个事实）。
    if (rest === null) {
      // 已授权用户访问 `/` 时直接送到前缀下，省一次手打。
      if (pathname === '/' && isAuthorized(req, null)) {
        send(res, 302, { location: `/${prefix}/` });
        return;
      }
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
      return;
    }

    // 带对了前缀就跑：种 cookie（以后 `/` 与短链接都能进）。
    const cookieHeader = {
      'set-cookie': `${COOKIE_NAME}=${prefixHash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
    };

    // 目录 → index.html
    let relative = rest === '/' ? '/index.html' : rest;
    if (relative.endsWith('/')) relative += 'index.html';
    const absolute = resolveFile(relative);
    if (absolute === null) {
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
      return;
    }

    const realFile = await resolveInsideRoot(absolute);
    if (realFile === null) {
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
      return;
    }

    const extension = path.extname(realFile).toLowerCase();
    const type = MIME.get(extension);
    if (type === undefined) {
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
      return;
    }

    const headers = { 'content-type': type, ...cookieHeader };
    // 页面与脚本每次都问一次（这里是我们自己的小文件，几 KB；
    // 缓存带来的"改了看不到"比省这点流量更烦）。
    headers['cache-control'] = 'no-store';

    if (req.method === 'HEAD') {
      send(res, 200, headers);
      return;
    }
    res.writeHead(200, headers);
    createReadStream(realFile).on('error', (error) => {
      log('读取失败', relative, error.message);
      res.destroy();
    }).pipe(res);
  } catch (error) {
    log('请求异常', error?.message ?? error);
    if (!res.headersSent) {
      send(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'internal error');
    } else {
      res.destroy();
    }
  }
});

async function main() {
  await loadToken();
  // 静态根必须存在：悄悄返回 404 会让人以为"页面没写对"。
  const rootInfo = await stat(ROOT).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory()) {
    throw new Error(`静态根不是目录：${ROOT}`);
  }
  server.listen(PORT, BIND, () => {
    log(`dsh-arcade 监听 http://${BIND}:${PORT}（静态根 ${ROOT}）`);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`收到 ${signal}，关闭中`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

main().catch((error) => {
  console.error('启动失败：', error?.message ?? error);
  process.exit(1);
});
