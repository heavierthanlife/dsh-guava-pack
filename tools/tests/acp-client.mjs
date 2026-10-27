#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/tests/acp-client.mjs — 面板客户端门禁（隔离 web 进程）。
 *
 * 验证的不只是「client.js 语法正确」，而是**宿主真的把我们的客户端模块编进了
 * 浏览器 bundle**：
 *   1. 隔离 profile 启动 web 进程（--port 0），从 stdout 抓 URL；
 *   2. 带 token 取首页（先拿 cookie，再跟 303）；
 *   3. 在首页的 `__DSH_BOOT__` 里找到包含 `dsh-context-acp/client.js` 的
 *      `/plugins/??...&rev=...` combo URL；
 *   4. 取该 bundle：HTTP 200 且内容是 JS（含 `__ModuleLoader__`），说明
 *      esbuild 编译通过、模块 id 被客户端运行时接受。
 *
 * 这是 P3「面板 pill」的门禁：面板丑/交互好不好无法自动判定（人工验收），
 * 但「客户端模块根本编不出来」必须在 CI 拦住。
 *
 * 用法：node tools/tests/acp-client.mjs [--keep]
 *
 * @module tools/tests/acp-client
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL_FILE = fileURLToPath(import.meta.url);
const PACK_DIR = dirname(dirname(dirname(TOOL_FILE)));
const PLUGIN_DIR = join(PACK_DIR, 'plugins', 'dsh-context-acp');
const KEEP = process.argv.includes('--keep');

const failures = [];
const pass = (name, detail) => console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail) => {
  failures.push({ name, detail });
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
};

function resolveDshBin() {
  const anchors = [join(PACK_DIR, 'package.json')];
  if (process.env.DSH_HOME) anchors.push(join(process.env.DSH_HOME, 'package.json'));
  if (process.env.HOME) anchors.push(join(process.env.HOME, 'dsh', 'package.json'));
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      return join(dirname(createRequire(pathToFileURL(anchor).href).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
    } catch {
      /* 下一个锚点 */
    }
  }
  throw new Error('找不到 @deepseek-ai/dsh');
}

function makeLab() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acp-client-'));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'acp-lab');
  const nodeModules = join(profileDir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-acp-lab',
    private: true,
    dependencies: { 'dsh-context-acp': `file:${PLUGIN_DIR}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-context-acp'] } },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
  symlinkSync(PLUGIN_DIR, join(nodeModules, 'dsh-context-acp'), 'dir');
  return { root, home, work: root };
}

/** 启动隔离 web 进程，等它打印 URL；返回 { child, base, token, stop }。 */
async function bootWeb({ bin, lab }) {
  const child = spawn(process.execPath, [
    bin,
    '--profile', 'acp-lab',
    '--port', '0',
    '--no-open',
  ], {
    cwd: lab.work,
    env: { ...process.env, DSH_HOME: lab.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const urlPattern = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const match = urlPattern.exec(stdout);
    if (match !== null) {
      return {
        child,
        base: `http://127.0.0.1:${match[1]}`,
        token: match[2],
        url: match[0],
        getStderr: () => stderr,
        stop: () => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* 已退出 */
          }
        },
      };
    }
    if (child.exitCode !== null) throw new Error(`web 进程提前退出（code=${child.exitCode}）：\n${stderr.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  throw new Error(`90s 内没等到 web URL。stderr:\n${stderr.slice(-3000)}`);
}

/** 带 token/cookie 取首页 HTML。 */
async function fetchIndex(web) {
  // 第一次带 token：服务端会 303 并下发会话 cookie。
  const first = await fetch(web.url, { redirect: 'manual' });
  const cookies = (first.headers.getSetCookie?.() ?? [first.headers.get('set-cookie') ?? ''])
    .filter(Boolean)
    .map((value) => value.split(';')[0])
    .join('; ');
  const second = await fetch(`${web.base}/`, { headers: cookies.length > 0 ? { cookie: cookies } : {} });
  const html = await second.text();
  return { html, cookies, status: second.status };
}

const started = Date.now();
let lab;
let web;
try {
  const bin = resolveDshBin();
  lab = makeLab();
  console.log(`\n[acp-client] dsh bin = ${bin}`);
  console.log(`[acp-client] 隔离 DSH_HOME = ${lab.home}\n`);
  web = await bootWeb({ bin, lab });
  console.log(`[acp-client] web = ${web.base}`);

  const { html, cookies, status } = await fetchIndex(web);
  if (status === 200) pass('首页可取', `status=200, ${html.length} bytes`);
  else fail('首页', `status=${status}`);

  // 首页 __DSH_BOOT__ 里的 combo URL：`plugins/??...,dsh-context-acp/client.js,...&rev=...`
  const comboMatch = /plugins\/\?\?[^"']*dsh-context-acp\/client\.js[^"']*/.exec(html);
  if (comboMatch === null) {
    fail('客户端模块进入 boot 清单', '首页里没有包含 dsh-context-acp/client.js 的 /plugins/?? combo URL（dsh.client/package exports 未生效？）');
  } else {
    pass('客户端模块进入 boot 清单');
    const combo = comboMatch[0].replaceAll('&amp;', '&');
    const response = await fetch(`${web.base}/${combo}`, {
      headers: {
        ...(cookies.length > 0 ? { cookie: cookies } : {}),
        host: web.base.replace('http://', ''),
        origin: web.base,
        referer: `${web.base}/`,
      },
    });
    const body = await response.text();
    if (response.status === 200) pass('client bundle 编译并可取', `200, ${body.length} bytes`);
    else fail('client bundle', `status=${response.status}，body 头：${body.slice(0, 500)}`);
    if (body.includes('__ModuleLoader__') && body.includes('dsh-context-acp')) pass('bundle 内容是我们模块的 ModuleLoader 产物');
    else fail('bundle 内容', '没找到 __ModuleLoader__ 或 dsh-context-acp 标记');
    if (/esbuild|Transform failed|Unexpected|SyntaxError/i.test(body) && body.length < 4096) fail('bundle 编译错误', body.slice(0, 800));
  }

  // 宿主侧装配错误（例如 preset override 失效）也会写 stderr，一并检查。
  const stderr = web.getStderr();
  if (/failed to import|did not activate|Duplicate export/i.test(stderr)) fail('宿主 stderr 有装配错误', stderr.slice(-1500));
  else pass('宿主 stderr 无装配/导入错误');
} catch (error) {
  fail('测试框架', String(error?.stack ?? error));
} finally {
  web?.stop?.();
  if (lab !== undefined && !KEEP) {
    try {
      rmSync(lab.root, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  } else if (lab !== undefined) {
    console.log(`\n[acp-client] 保留临时目录：${lab.root}`);
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n[acp-client] ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} in ${elapsed}s`);
process.exit(failures.length === 0 ? 0 : 1);
