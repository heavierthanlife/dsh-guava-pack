#!/usr/bin/env node
// DSH Console — VPS 统一图形入口（单文件、仅 Node 标准库）
//
// 设计要点：
//   * 只监听 tailnet 地址（默认 100.109.125.37:8090），绝不绑 0.0.0.0；
//   * 全部路径 HTTP Basic 认证，密码从 /etc/dsh-console/password 读取（600 root）；
//   * 动作是**硬编码白名单**，不拼接 shell、不接受用户命令字符串；
//   * 状态采集逐项独立超时降级，任何一项失败只影响自己的卡片；
//   * 日志只写 stdout（journal 可查），绝不打印口令或 Authorization 头。
//
// 环境变量（systemd 单元里固定）：DSH_CONSOLE_BIND / DSH_CONSOLE_PORT /
// DSH_CONSOLE_PASSWORD_FILE。无第三方依赖。

import { createServer, request as httpRequest } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 端口映射：唯一真相源是 config/machines.json ────────────────────────────
// 三个候选位置（VPS 部署副本 / 仓库内 / 环境变量），第一个能解析的生效；
// 全都失败就回退到写死的两台 —— 保证没拉取新配置的机器照常工作。
const DEFAULT_TUNNEL_PORTS = [22022, 22023];
function tunnelPorts() {
  const candidates = [
    process.env.DSH_MACHINES_JSON,
    path.join(__dirname, 'machines.json'),
    path.join(__dirname, '..', '..', 'config', 'machines.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      const ports = (cfg.machines || [])
        .map((m) => Number(m && m.tunnel_port))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ports.length) return ports;
    } catch {
      // 换下一个候选
    }
  }
  return DEFAULT_TUNNEL_PORTS;
}

const VERSION = '1.0.0';
const BIND = process.env.DSH_CONSOLE_BIND || '100.109.125.37';
const PORT = Number(process.env.DSH_CONSOLE_PORT || 8090);
const PASSWORD_FILE = process.env.DSH_CONSOLE_PASSWORD_FILE || '/etc/dsh-console/password';
// 可选的一次性令牌（点开即用）：/etc/dsh-console/token，32 位十六进制。
// 手机/平板输入 Basic 口令太痛苦（键盘自动大写、反复弹框），
// 访问 `/?k=<token>` 会种一个 HttpOnly cookie 再跳到 `/`，之后不再要求输入。
const TOKEN_FILE = process.env.DSH_CONSOLE_TOKEN_FILE || '/etc/dsh-console/token';
const COOKIE_NAME = 'dsh_console_session';
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const INDEX_PATH = path.join(__dirname, 'index.html');

const USERNAME = 'dsh';
const RESTIC_REPO = '/srv/backup/dsh';
const RESTIC_CACHE = '/var/cache/dsh-console/restic';
const GIT_MIRROR_STAMP = '/srv/git-mirror/.last-run';
const MINISERVE_ENV = '/etc/miniserve/env';
const MINISERVE_BASE = 'http://100.109.125.37:8081';

const SERVICES = ['tailscaled', 'ssh', 'rest-server', 'uptime-kuma', 'ntfy', 'miniserve'];

const BASE_ENV = {
  ...process.env,
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
};

const HOST_ALLOW = new Set([
  `${BIND}:${PORT}`,
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
]);
const ORIGIN_ALLOW = new Set([
  `http://${BIND}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`,
]);

const execFileAsync = promisify(execFile);

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------- 口令 / 认证

function loadPassword() {
  let raw;
  try {
    raw = readFileSync(PASSWORD_FILE, 'utf8');
  } catch (err) {
    console.error(`[fatal] 读不到口令文件 ${PASSWORD_FILE}: ${err.message}`);
    process.exit(1);
  }
  const pw = raw.trim();
  if (!pw) {
    console.error(`[fatal] 口令文件为空：${PASSWORD_FILE}`);
    process.exit(1);
  }
  if (/\s/.test(pw)) {
    console.error('[fatal] 口令包含空白字符，拒绝启动（请重新生成）');
    process.exit(1);
  }
  return pw;
}

const PASSWORD = loadPassword();
const EXPECTED_DIGEST = createHash('sha256').update(USERNAME).update('\0').update(PASSWORD).digest();

/** 读可选令牌；格式不对/不存在一律当作"没配置"。 */
function loadAccessToken() {
  let raw;
  try {
    raw = readFileSync(TOKEN_FILE, 'utf8');
  } catch {
    return null;
  }
  const token = raw.trim();
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    console.error(`[warn] ${TOKEN_FILE} 格式不对（期望 16-64 位十六进制），忽略令牌登录`);
    return null;
  }
  return token;
}

const ACCESS_TOKEN = loadAccessToken();

/** 常量时间比较两个字符串（长度不同直接 false）。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** cookie 里带着有效令牌 = 已登录（等同 Basic）。 */
function cookieAllowed(req) {
  if (ACCESS_TOKEN === null) return false;
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw === '') return false;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== COOKIE_NAME) continue;
    return safeEqual(part.slice(idx + 1).trim(), ACCESS_TOKEN);
  }
  return false;
}

function checkAuth(req) {
  if (cookieAllowed(req)) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Basic\s+/i.test(header)) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  const digest = createHash('sha256').update(user).update('\0').update(pass).digest();
  return digest.length === EXPECTED_DIGEST.length && timingSafeEqual(digest, EXPECTED_DIGEST);
}

// ---------------------------------------------------------------- 通用执行

/**
 * 执行固定命令（不经过 shell）。永不抛异常，返回统一结果。
 * @returns {Promise<{ok:boolean, rc:number|null, timedOut:boolean, stdout:string, stderr:string, ms:number}>}
 */
async function run(cmd, args, { timeout = 5000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      maxBuffer,
      killSignal: 'SIGKILL',
      env: BASE_ENV,
      windowsHide: true,
    });
    return { ok: true, rc: 0, timedOut: false, stdout: String(stdout), stderr: String(stderr), ms: Date.now() - started };
  } catch (err) {
    const timedOut = err.killed === true || err.signal === 'SIGKILL' || err.code === 'ETIMEDOUT';
    const rc = typeof err.code === 'number' ? err.code : null;
    return {
      ok: false,
      rc,
      timedOut,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
      ms: Date.now() - started,
    };
  }
}

async function attempt(label, fn) {
  try {
    return await fn();
  } catch (err) {
    log(`status collector failed label=${label} error=${err && err.message ? err.message : err}`);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

const round = (n, digits = 2) => {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function tailText(value, max = 16000) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `…（输出过长，仅保留末尾 ${max} 字符）\n${s.slice(-max)}`;
}

function firstLine(value, max = 300) {
  const s = String(value ?? '').trim().split('\n').find((l) => l.trim()) || '';
  return s.slice(0, max);
}

// ---------------------------------------------------------------- 状态采集

async function collectServices() {
  const items = await Promise.all(
    SERVICES.map(async (name) => {
      const r = await run('systemctl', ['is-active', name], { timeout: 3000 });
      const state = r.stdout.trim() || r.stderr.trim() || (r.timedOut ? 'timeout' : 'unknown');
      return { name, state, active: r.ok && state === 'active', ok: r.ok || state !== '' };
    }),
  );
  return { ok: items.every((i) => i.active), items };
}

async function collectDisk() {
  const s = await statfs('/');
  const total = s.blocks * s.bsize;
  const free = s.bfree * s.bsize;
  const avail = s.bavail * s.bsize;
  return {
    ok: true,
    totalBytes: total,
    usedBytes: total - free,
    availBytes: avail,
    usePct: round(((total - free) / total) * 100, 1),
  };
}

async function collectMemory() {
  const txt = await readFile('/proc/meminfo', 'utf8');
  const pick = (key) => {
    const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = pick('MemTotal');
  const avail = pick('MemAvailable');
  if (!total) throw new Error('无法解析 /proc/meminfo');
  return {
    ok: true,
    totalBytes: total,
    availBytes: avail,
    usedBytes: total - avail,
    usePct: round(((total - avail) / total) * 100, 1),
  };
}

function probeTunnel(port) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ port, ms: Date.now() - started, ...result });
    };
    // sshd 的 GatewayPorts clientspecified 只绑 tailnet 地址，127.0.0.1 不通，
    // 因此这里探测 BIND（100.109.125.37）；本机访问 tailnet 地址是通的。
    const req = httpRequest(
      {
        host: BIND,
        port,
        path: '/go',
        method: 'GET',
        headers: { 'User-Agent': `dsh-console/${VERSION}`, Accept: '*/*' },
      },
      (res) => {
        const status = res.statusCode || 0;
        res.resume();
        res.on('end', () => done({ ok: true, listening: true, status }));
        res.on('error', () => done({ ok: true, listening: true, status }));
      },
    );
    req.setTimeout(3000, () => {
      req.destroy(new Error('probe timeout'));
      done({ ok: false, listening: false, error: '超时（3s）' });
    });
    req.on('error', (err) => {
      const code = err && err.message === 'probe timeout' ? 'TIMEOUT' : err && err.code;
      done({
        ok: false,
        listening: false,
        error: code === 'ECONNREFUSED' ? '未监听' : code === 'TIMEOUT' ? '超时（3s）' : firstLine(err && err.message, 80),
      });
    });
    req.end();
  });
}

async function collectTunnels() {
  const items = await Promise.all(tunnelPorts().map((port) => probeTunnel(port)));
  return { ok: true, items };
}

async function countLocks() {
  try {
    const names = await readdir(`${RESTIC_REPO}/locks`);
    return { ok: true, count: names.filter((n) => !n.startsWith('.')).length, error: null };
  } catch (err) {
    return { ok: false, count: null, error: firstLine(err.message, 200) };
  }
}

async function collectRestic() {
  const [snapR, sizeR, lockR] = await Promise.all([
    run(
      'runuser',
      [
        '-u', 'restic', '--', 'env',
        `RESTIC_REPOSITORY=${RESTIC_REPO}`,
        'RESTIC_PASSWORD_FILE=/etc/restic/repo-password',
        `RESTIC_CACHE_DIR=${RESTIC_CACHE}`,
        '/usr/local/bin/restic', 'snapshots', '--no-lock', '--json',
      ],
      { timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
    ),
    run('du', ['-sb', RESTIC_REPO], { timeout: 10000, maxBuffer: 64 * 1024 }),
    countLocks(),
  ]);

  const out = {
    ok: false,
    snapshots: null,
    latest: null,
    latestAgeHours: null,
    sizeBytes: null,
    locks: lockR.ok ? lockR.count : null,
    error: null,
  };

  if (!lockR.ok) out.error = `锁目录读取失败：${lockR.error}`;

  if (sizeR.ok) {
    const bytes = Number(sizeR.stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(bytes)) out.sizeBytes = bytes;
  }

  if (snapR.ok) {
    try {
      const parsed = JSON.parse(snapR.stdout);
      if (!Array.isArray(parsed)) throw new Error('snapshots 输出不是数组');
      out.snapshots = parsed.length;
      if (parsed.length > 0) {
        const newest = parsed
          .map((s) => ({ s, t: Date.parse(s.time) }))
          .filter((x) => Number.isFinite(x.t))
          .sort((a, b) => b.t - a.t)[0];
        if (newest) {
          out.latest = new Date(newest.t).toISOString();
          out.latestAgeHours = round((Date.now() - newest.t) / 3600000, 2);
        }
      }
      out.ok = true;
    } catch (err) {
      out.error = `快照解析失败：${firstLine(err.message, 200)}`;
    }
  } else {
    out.error = outline(
      snapR.timedOut ? 'restic snapshots 超时（15s）' : `restic snapshots 失败 rc=${snapR.rc}: ${firstLine(snapR.stderr, 200)}`,
      out.error,
    );
  }

  return out;
}

function outline(a, b) {
  return b ? `${b}；${a}` : a;
}

async function collectGitMirror() {
  const raw = await readFile(GIT_MIRROR_STAMP, 'utf8');
  let when = new Date(raw.trim());
  if (Number.isNaN(when.getTime())) when = (await stat(GIT_MIRROR_STAMP)).mtime;
  const ageHours = (Date.now() - when.getTime()) / 3600000;
  return { ok: true, at: when.toISOString(), ageHours: round(ageHours, 2) };
}

// miniserve 已从 Basic 改为「令牌路径」：入口是 /<PREFIX>/，根路径 404。
// PREFIX 只从 VPS 的 /etc/miniserve/env 读取，不硬编码、不写日志。
async function collectMiniserve() {
  const txt = await readFile(MINISERVE_ENV, 'utf8');
  let prefix = null;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*PREFIX\s*=\s*(.*?)\s*$/);
    if (m) {
      prefix = m[1].replace(/^["']|["']$/g, '');
      break;
    }
  }
  if (!prefix) throw new Error('未配置（/etc/miniserve/env 缺少 PREFIX）');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(prefix)) throw new Error('未配置（PREFIX 格式异常）');
  return { ok: true, url: `${MINISERVE_BASE}/${prefix}/` };
}

let securityCache = { at: 0, value: null };
const SECURITY_TTL_MS = 5 * 60 * 1000;

async function collectSecurityFresh() {
  const r = await run('apt-get', ['-s', '-o', 'Debug::NoLocking=true', 'dist-upgrade'], {
    timeout: 25000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = r.stdout.split('\n');
  const count = lines.filter((line) => /^Inst.*security/i.test(line)).length;
  if (!r.ok && !r.stdout.trim()) {
    throw new Error(r.timedOut ? 'apt-get 模拟超时（25s）' : `apt-get 失败 rc=${r.rc}`);
  }
  return { ok: r.ok, count, ms: r.ms, error: r.ok ? null : `apt-get rc=${r.rc}（计数可能不完整）` };
}

async function collectSecurity() {
  const now = Date.now();
  if (securityCache.value && now - securityCache.at < SECURITY_TTL_MS) {
    return { ...securityCache.value, cached: true };
  }
  try {
    const value = await collectSecurityFresh();
    securityCache = { at: now, value };
    return value;
  } catch (err) {
    if (securityCache.value) {
      return { ...securityCache.value, ok: false, stale: true, cached: true, error: firstLine(err.message, 200) };
    }
    throw err;
  }
}

async function collectStatus() {
  const started = Date.now();
  const [services, disk, memory, tunnels, restic, gitmirror, security, miniserve] = await Promise.all([
    attempt('services', collectServices),
    attempt('disk', collectDisk),
    attempt('memory', collectMemory),
    attempt('tunnels', collectTunnels),
    attempt('restic', collectRestic),
    attempt('gitmirror', collectGitMirror),
    attempt('security', collectSecurity),
    attempt('miniserve', collectMiniserve),
  ]);
  return {
    ok: true,
    version: VERSION,
    host: os.hostname(),
    ts: new Date().toISOString(),
    durationMs: Date.now() - started,
    services,
    disk,
    memory,
    load: { one: round(os.loadavg()[0], 2), five: round(os.loadavg()[1], 2), fifteen: round(os.loadavg()[2], 2) },
    uptimeSec: Math.round(os.uptime()),
    tunnels,
    restic,
    gitmirror,
    security,
    miniserve,
    busy: actionRunning,
  };
}

let statusCache = null; // { at, data }
let statusInflight = null;
const STATUS_TTL_MS = 8000;

async function getStatus() {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return { ...statusCache.data, cached: true };
  }
  if (statusInflight) return statusInflight;
  statusInflight = (async () => {
    const data = await collectStatus();
    statusCache = { at: Date.now(), data };
    return data;
  })().finally(() => {
    statusInflight = null;
  });
  return statusInflight;
}

// ---------------------------------------------------------------- 动作白名单

const ACTIONS = Object.freeze({
  prune: { kind: 'unit', unit: 'restic-prune.service', timeoutMs: 120000, label: 'prune（回收仓库空间）' },
  check: { kind: 'unit', unit: 'restic-check.service', timeoutMs: 120000, label: 'check（仓库完整性校验）' },
  unlock: { kind: 'unit', unit: 'restic-lock-janitor.service', timeoutMs: 60000, label: 'unlock（清理陈旧锁）' },
  doctor: { kind: 'bin', bin: '/usr/local/sbin/dsh-doctor.sh', args: ['--short'], timeoutMs: 30000, label: 'doctor（只读诊断）' },
});

let actionRunning = false;

async function runAction(action) {
  const def = ACTIONS[action];
  const started = Date.now();
  const finishedAt = () => new Date().toISOString();

  if (def.kind === 'unit') {
    const startedR = await run('systemctl', ['start', def.unit], { timeout: def.timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    const journalR = await run('journalctl', ['--no-pager', '-n', '30', '-o', 'short-iso', '-u', def.unit], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const lockR = await countLocks();
    const ok = startedR.ok && startedR.rc === 0;
    const result = {
      ok,
      action,
      label: def.label,
      rc: startedR.rc,
      timedOut: startedR.timedOut,
      stdout: tailText(startedR.stdout),
      stderr: tailText(startedR.stderr),
      journal: journalR.ok ? tailText(journalR.stdout) : '',
      journalError: journalR.ok ? null : firstLine(journalR.stderr, 200),
      locksAfter: lockR.ok ? lockR.count : null,
      durationMs: Date.now() - started,
      finishedAt: finishedAt(),
    };
    if (startedR.timedOut) {
      result.stderr = outline(`等待 systemctl 超时（${def.timeoutMs / 1000}s）；单元可能仍在后台运行，请看 journal。`, result.stderr);
    }
    log(`action=${action} unit=${def.unit} ok=${ok} rc=${result.rc} dur=${result.durationMs}ms locksAfter=${result.locksAfter}`);
    return result;
  }

  const r = await run(def.bin, def.args, { timeout: def.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  const ok = r.ok && r.rc === 0;
  const result = {
    ok,
    action,
    label: def.label,
    rc: r.rc,
    timedOut: r.timedOut,
    stdout: tailText(r.stdout),
    stderr: tailText(r.stderr),
    journal: null,
    durationMs: Date.now() - started,
    finishedAt: finishedAt(),
  };
  log(`action=${action} bin=${def.bin} ok=${ok} rc=${result.rc} dur=${result.durationMs}ms`);
  return result;
}

// ---------------------------------------------------------------- HTTP 工具

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function sendText(req, res, status, text) {
  const body = Buffer.from(`${text}\n`, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req, res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readJsonBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = text ? JSON.parse(text) : {};
        settled = true;
        resolve(parsed);
      } catch {
        fail(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', (err) => fail(Object.assign(err, { status: 400 })));
  });
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return HOST_ALLOW.has(host);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 同源 GET 情形
  return ORIGIN_ALLOW.has(String(origin).toLowerCase());
}

// ---------------------------------------------------------------- 请求处理

let indexHtml;
try {
  indexHtml = await readFile(INDEX_PATH, 'utf8');
} catch (err) {
  console.error(`[fatal] 读不到页面 ${INDEX_PATH}: ${err.message}`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const ip = req.socket.remoteAddress || '-';
  let pathname = '-';
  try {
    setCommonHeaders(res);
    const url = new URL(req.url || '/', `http://${BIND}`);
    pathname = url.pathname;

    if (!hostAllowed(req)) {
      log(`reject host=${req.headers.host || '-'} path=${pathname} ip=${ip}`);
      return sendText(req, res, 421, '不接受的 Host');
    }

    // 一次性令牌入口：GET /?k=<token> → 种 cookie → 302 回首页。
    // 不记录 k 的值（日志只写 pathname）。
    if ((req.method === 'GET' || req.method === 'HEAD') && ACCESS_TOKEN !== null) {
      const supplied = url.searchParams.get('k');
      if (supplied !== null) {
        if (safeEqual(supplied, ACCESS_TOKEN)) {
          res.statusCode = 302;
          res.setHeader('Set-Cookie', `${COOKIE_NAME}=${ACCESS_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`);
          res.setHeader('Location', '/');
          return res.end();
        }
        log(`token rejected ip=${ip}`);
      }
    }

    if (!checkAuth(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="DSH Console", charset="UTF-8"');
      log(`auth failed ip=${ip} method=${req.method} path=${pathname}`);
      return sendText(req, res, 401, '需要认证');
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
      const body = Buffer.from(indexHtml, 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', body.length);
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (pathname === '/api/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      const data = await getStatus();
      return sendJson(req, res, 200, data);
    }

    if (pathname === '/api/action') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(req, res, 405, { error: '只接受 POST' });
      }
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (!ctype.startsWith('application/json')) {
        return sendJson(req, res, 415, { error: 'Content-Type 必须是 application/json' });
      }
      if (req.headers['x-requested-with'] !== 'dsh-console') {
        return sendJson(req, res, 403, { error: '缺少 CSRF 防护头 X-Requested-With' });
      }
      if (!originAllowed(req)) {
        log(`action origin rejected origin=${req.headers.origin} ip=${ip}`);
        return sendJson(req, res, 403, { error: 'Origin 不被允许' });
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(req, res, err.status || 400, { error: err.message });
      }
      const action = body && typeof body.action === 'string' ? body.action : '';
      if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
        log(`action rejected name=${JSON.stringify(action).slice(0, 60)} ip=${ip}`);
        return sendJson(req, res, 400, { error: '未知动作（只允许 prune / check / unlock / doctor）' });
      }
      if (actionRunning) {
        log(`action busy rejected name=${action} ip=${ip}`);
        return sendJson(req, res, 409, { error: '已有动作在执行，请稍候再试' });
      }
      actionRunning = true;
      let result;
      try {
        result = await runAction(action);
      } finally {
        actionRunning = false;
      }
      return sendJson(req, res, 200, result);
    }

    if (pathname === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.statusCode = 204;
      return res.end();
    }

    return sendText(req, res, 404, 'Not Found');
  } catch (err) {
    log(`error path=${pathname} ip=${ip} error=${err && err.stack ? err.stack : err}`);
    if (!res.headersSent) return sendText(req, res, 500, '内部错误');
    return res.end();
  } finally {
    log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms ip=${ip}`);
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.on('clientError', (err, socket) => {
  if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

let listenRetries = 0;
function startListening() {
  const onError = (err) => {
    if ((err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE') && listenRetries < 120) {
      listenRetries += 1;
      console.error(`[warn] 监听 ${BIND}:${PORT} 失败（${err.code}），5s 后重试（${listenRetries}/120）`);
      setTimeout(startListening, 5000);
      return;
    }
    console.error(`[fatal] 监听 ${BIND}:${PORT} 失败：${err.stack || err}`);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(PORT, BIND, () => {
    server.removeListener('error', onError);
    listenRetries = 0;
    server.on('error', (err) => console.error(`[error] server: ${err.stack || err}`));
    log(`DSH Console ${VERSION} listening on http://${BIND}:${PORT} (auth user=${USERNAME}, password file=${PASSWORD_FILE})`);
  });
}

startListening();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`收到 ${sig}，关闭服务`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
