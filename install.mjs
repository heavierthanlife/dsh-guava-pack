#!/usr/bin/env node
/**
 * dsh-guava-pack — 安装自检与本机配置助手。
 *
 * 用法：
 *   node install.mjs --check     只检查包是否完整、补丁是否已打
 *   node install.mjs --patch     应用两个 node_modules 补丁（幂等；不打则 agentrouter 400）
 *   node install.mjs --init      生成 providers.json（若不存在）并打印后续步骤
 *   node install.mjs             等同于 --check
 *
 * 为什么需要它：这个包只负责「把插件挂上去」。路由代理要真的工作，还需要
 * providers.json（上游表）与 baseURL 指向它 —— 这脚本把这一步显式化，避免
 * 装完发现「面板在但没生效」。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_DIR = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

const ok = (m) => console.log(`  \u2705 ${m}`);
const bad = (m) => console.log(`  \u274c ${m}`);
const info = (m) => console.log(`  \u2139\ufe0f  ${m}`);

/** 包里必须存在的条目：patch + 每个插件的 package.json。 */
const REQUIRED = [
  'cordis.patch.yml',
  'package.json',
  'config/cordis.patch.example.yml',
  'plugins/dsh-mobile-ui/package.json',
  'plugins/dsh-theme-manager/package.json',
  'plugins/dsh-theme-cyberpunk2077/package.json',
  'plugins/provider-router/package.json',
  'plugins/provider-router/lib/router.mjs',
  'plugins/dsh-opencode-session-header/package.json',
  'plugins/dsh-context-guard/package.json',
  'plugins/dsh-session-purge/package.json',
  'plugins/dsh-session-purge/lib/core.mjs',
  'services/commandcode-bridge/server.mjs',
  'patches/apply-required-array.sh',
  'patches/apply-anthropic-tool-fixes.sh',
];

/**
 * DSH 安装目录（这两个补丁打的是它下面的 node_modules，不是本包）。
 * 与补丁脚本用同一套判断：DSH_HOME > ~/dsh。
 */
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');

/**
 * 两个补丁都是「node_modules 级」的，dsh 依赖一升级就丢，必须能随时重跑。
 * 所以这里只做「检测 + 调用包里那份脚本」，不重复实现打补丁逻辑
 * （脚本自带幂等标记与锚点断言，锚点找不到会直接报错而不是静默改坏）。
 */
const PATCHES = [
  {
    name: 'dsh-tools 恒输出 required:[]',
    script: 'patches/apply-required-array.sh',
    file: join(DSH_HOME, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
    marker: 'Always emit `required`',
    why: 'AgentRouter 的 deepseek-v4-flash 通道把「缺失的 required」判成 null 并 400',
  },
  {
    name: 'pi-ai Anthropic 两处协议兜底',
    script: 'patches/apply-anthropic-tool-fixes.sh',
    file: join(DSH_HOME, 'node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js'),
    marker: 'enforceToolResultAdjacency',
    why: '修 400 tool_use ids were found without tool_result blocks',
  },
];

function patchState() {
  return PATCHES.map((p) => {
    if (!existsSync(p.file)) return { ...p, state: 'missing' };
    try {
      const applied = readFileSync(p.file, 'utf8').includes(p.marker);
      return { ...p, state: applied ? 'applied' : 'pending' };
    } catch {
      return { ...p, state: 'unreadable' };
    }
  });
}

function reportPatches() {
  console.log('\nnode_modules \u8865\u4e01\uff08\u4e0d\u6253\u5c31\u7528\u4e0d\u4e86 agentrouter\uff09\uff1a');
  let bad = 0;
  for (const p of patchState()) {
    if (p.state === 'applied') ok(`${p.name} \u5df2\u6253`);
    else if (p.state === 'missing') { info(`${p.name}\uff1a\u627e\u4e0d\u5230 ${p.file}`); bad++; }
    else { bad(`${p.name} \u672a\u6253 \u2014\u2014 ${p.why}`); bad++; }
  }
  return bad;
}

function applyPatches() {
  console.log('dsh-guava-pack \u8865\u4e01\n');
  console.log(`DSH_HOME = ${DSH_HOME}\n`);
  for (const p of patchState()) {
    const script = join(PACK_DIR, p.script);
    if (p.state === 'applied') { ok(`${p.name}\uff1a\u5df2\u6253\u8fc7\uff0c\u8df3\u8fc7`); continue; }
    if (p.state === 'missing') { bad(`${p.name}\uff1a\u76ee\u6807\u6587\u4ef6\u4e0d\u5b58\u5728\uff08${p.file}\uff09\u2014\u2014 DSH_HOME \u5bf9\u5417\uff1f`); continue; }
    try {
      const out = execFileSync('bash', [script], { encoding: 'utf8', env: { ...process.env, DSH_HOME } });
      ok(`${p.name}\uff1a${out.trim().split('\n').pop()}`);
    } catch (err) {
      bad(`${p.name} \u5931\u8d25\uff1a${(err.stdout || err.message || '').toString().trim().split('\n').pop()}`);
      info('\u811a\u672c\u81ea\u5e26\u9526\u70b9\u65ad\u8a00\uff1b\u62a5\u300c\u9526\u70b9\u672a\u627e\u5230\u300d\u901a\u5e38\u662f dsh \u4f9d\u8d56\u5347\u7ea7\u4e86\uff0c\u9700\u4eba\u5de5\u6838\u5bf9');
    }
  }
  console.log('\n\u6253\u5b8c\u540e\u91cd\u542f DSH \u751f\u6548\uff1asystemctl --user restart dsh.service');
}

function check() {
  console.log('dsh-guava-pack \u5b89\u88c5\u81ea\u68c0\n');
  let failed = 0;

  console.log('\u5305\u5185\u5bb9\uff1a');
  for (const rel of REQUIRED) {
    if (existsSync(join(PACK_DIR, rel))) ok(rel);
    else { bad(`${rel} \u7f3a\u5931`); failed++; }
  }

  console.log('\nbundle \u58f0\u660e\uff1a');
  try {
    const pkg = JSON.parse(readFileSync(join(PACK_DIR, 'package.json'), 'utf8'));
    const patch = pkg?.dsh?.bundle?.patch;
    if (typeof patch === 'string' && existsSync(join(PACK_DIR, patch))) {
      ok(`dsh.bundle.patch = ${patch}`);
    } else {
      bad('package.json \u7f3a dsh.bundle.patch\uff0cDSH \u4e0d\u4f1a\u628a\u5b83\u5f53 bundle \u52a0\u8f7d');
      failed++;
    }
    if (pkg?.dsh?.client) {
      info('\u5305\u672c\u8eab\u6709 dsh.client\uff08\u4e0d\u5e94\u8be5\uff09\u2014\u2014 \u5ba2\u6237\u7aef\u7531\u5b50\u63d2\u4ef6\u63d0\u4f9b');
    }
  } catch (err) {
    bad(`package.json \u8bfb\u4e0d\u4e86\uff1a${err.message}`);
    failed++;
  }

  console.log('\npatch \u884c\uff08\u76f8\u5bf9\u8def\u5f84\u5e94\u951a\u5728 patch \u65c1\u8fb9\uff09\uff1a');
  try {
    const yml = readFileSync(join(PACK_DIR, 'cordis.patch.yml'), 'utf8');
    const names = [...yml.matchAll(/^\s*name:\s*['"]?(\.\/[^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
    if (names.length === 0) {
      bad('\u6ca1\u627e\u5230\u76f8\u5bf9\u8def\u5f84\u884c');
      failed++;
    }
    for (const rel of names) {
      const target = rel.replace(/^\.\//, '');
      if (existsSync(join(PACK_DIR, target))) ok(`${rel} \u2192 \u5b58\u5728`);
      else { bad(`${rel} \u2192 \u76ee\u6807\u4e0d\u5b58\u5728`); failed++; }
    }
  } catch (err) {
    bad(`cordis.patch.yml \u8bfb\u4e0d\u4e86\uff1a${err.message}`);
    failed++;
  }

  console.log('\u73af\u5883\uff1a');
  info(`DSH_SSR_PROXY = ${process.env.DSH_SSR_PROXY || process.env.SSR_PROXY || '(未设，路由代理默认 http://127.0.0.1:2080)'}`);
  info(`DSH_ROUTER_PORT = ${process.env.DSH_ROUTER_PORT || '(未设，默认 8318)'}`);
  if (process.env.DSH_ROUTER_CAPTURE === '1') {
    bad('DSH_ROUTER_CAPTURE=1 \u2014\u2014 \u4f1a\u628a\u63d0\u793a\u8bcd\u660e\u6587\u843d\u76d8\uff0c\u9664\u975e\u6b63\u5728\u6392\u969c\u5426\u5219\u8bf7\u5173\u6389');
  } else {
    ok('DSH_ROUTER_CAPTURE \u672a\u5f00\uff08\u6b63\u5e38\uff09');
  }

  failed += reportPatches();

  console.log(`\n\u7ed3\u679c\uff1a${failed === 0 ? '\u5305\u5b8c\u6574\uff0c\u53ef\u4ee5\u88c5' : failed + ' \u9879\u9700\u5904\u7406'}`);
  return failed === 0 ? 0 : 1;
}

function init() {
  const example = join(PACK_DIR, 'plugins/provider-router/providers.example.json');
  const target = join(PACK_DIR, 'plugins/provider-router/providers.json');
  if (existsSync(target)) {
    info(`providers.json \u5df2\u5b58\u5728\uff0c\u4e0d\u8986\u76d6\uff1a${target}`);
  } else if (existsSync(example)) {
    copyFileSync(example, target);
    ok(`\u5df2\u4ece\u793a\u4f8b\u751f\u6210 providers.json\uff1a${target}`);
    info('\u91cc\u9762\u7684 my-cloud-llm \u662f\u5360\u4f4d\u793a\u4f8b\uff0c\u8bf7\u6309\u9700\u6539\u6210\u4f60\u7684\u4e0a\u6e38');
  } else {
    bad('\u627e\u4e0d\u5230 providers.example.json');
  }

  console.log(`
\u63a5\u4e0b\u6765\uff1a
  1) \u628a\u5305\u88c5\u8fdb profile\uff1a
       dsh plugin --profile web add ${PACK_DIR}
  2) \u91cd\u542f DSH\uff1a
       systemctl --user restart dsh.service
  3) \u8ba9\u4f9b\u5e94\u5546\u8d70\u8def\u7531\u4ee3\u7406\uff08profiles/web/cordis.patch.yml\uff09\uff1a
       - id: llm-pi-ai
         name: "@deepseek-ai/dsh-llm-pi-ai"
         config:
           providers:
             opencode-go:
               baseURL: http://127.0.0.1:8318/opencode-go
  4) \u9700\u8981\u7ffb\u5899\u65f6\u8bbe DSH_SSR_PROXY\uff1b\u6ca1\u6709\u5c31\u4e0d\u7ba1\uff08\u76f4\u8fde\u7167\u6837\u5de5\u4f5c\uff09
  5) \u9700\u8981 CommandCode \u5c31\u8bbe COMMANDCODE_API_KEY \u5e76\u8d77 services/commandcode-bridge/start.sh
`);
}

if (args.has('--patch')) applyPatches();
else if (args.has('--init')) init();
else process.exit(check());
