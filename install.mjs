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

import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_DIR = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

const ok = (m) => console.log(`  \u2705 ${m}`);
const bad = (m) => console.log(`  \u274c ${m}`);
const info = (m) => console.log(`  \u2139\ufe0f  ${m}`);

/** 包里必须存在的条目：patch + 每个插件的 package.json 及其自身 patch 层。 */
const REQUIRED = [
  'cordis.patch.yml',
  'package.json',
  'config/cordis.patch.example.yml',
  'LICENSES/README.md',
  'ops/bootstrap-machine.sh',
  'ops/restart-dsh.sh',
  'ops/tailnet-entry.mjs',
  'ops/dsh-entry.service',
  'ops/install-tailnet-autostart.sh',
  'ops/tailnet-url.sh',
  'ops/dsh.service',
  'ops/model-policy.service',
  'ops/model-policy.timer',
  'ops/bashrc.dsh.example',
  'ops/wsl.conf.example',
  'ops/NETWORK-NOTES.md',
  'plugins/dsh-mobile-ui/package.json',
  'plugins/dsh-mobile-ui/cordis.patch.yml',
  'plugins/dsh-theme-manager/package.json',
  'plugins/dsh-theme-manager/cordis.patch.yml',
  'plugins/dsh-theme-cyberpunk2077/package.json',
  'plugins/dsh-theme-cyberpunk2077/cordis.patch.yml',
  'plugins/provider-router/package.json',
  'plugins/provider-router/cordis.patch.yml',
  'plugins/provider-router/lib/router.mjs',
  'plugins/provider-router/lib/auto-mode.mjs',
  'plugins/provider-router/lib/profile-providers.mjs',
  'plugins/provider-router/start.sh',
  'plugins/provider-router/providers.example.json',
  'plugins/dsh-opencode-session-header/package.json',
  'plugins/dsh-opencode-session-header/cordis.patch.yml',
  // 上游自带的 smoke 测试（原样收录）。存在的意义是 `npm test` 真的能跑 ——
  // 以前 package.json 指着 tests/ 而目录不存在，`npm test` 直接 ENOENT。
  'plugins/dsh-opencode-session-header/tests/smoke.mjs',
  'plugins/dsh-context-guard/package.json',
  'plugins/dsh-context-guard/cordis.patch.yml',
  'plugins/dsh-context-guard/index.js',
  'plugins/dsh-context-guard/client.js',
  'plugins/dsh-context-guard/lib/trigger.mjs',
  'plugins/dsh-context-guard/lib/scheduler.mjs',
  'plugins/dsh-session-purge/package.json',
  'plugins/dsh-session-purge/cordis.patch.yml',
  'plugins/dsh-session-purge/lib/core.mjs',
  'plugins/dsh-session-purge/clean-roster.sh',
  // 同步/异步等价性自检（`npm test` 跑的就是它）。会删数据的插件，这条测试不能少。
  'plugins/dsh-session-purge/tests/sync-async.mjs',
  'plugins/dsh-code-theme/package.json',
  'plugins/dsh-code-theme/cordis.patch.yml',
  'plugins/dsh-code-theme/client.js',
  'plugins/dsh-code-theme/tools/check-contrast.mjs',
  // 搜索后端一键切换（ctx.web 搜索 provider：官方 DeepSeek / Tavily）
  'plugins/dsh-web-search-switch/package.json',
  'plugins/dsh-web-search-switch/cordis.patch.yml',
  'plugins/dsh-web-search-switch/lib/index.js',
  'plugins/dsh-web-search-switch/lib/client.js',
  'plugins/dsh-web-search-switch/lib/pin.mjs',
  // 模型驱动的上下文压缩（ACP）：引擎/工具/账本/nudge/面板 + preset 覆盖生成器。
  // 生成物（config/*.generated.yml、runtime.json）也必须提交 —— `--check` 会比对。
  'plugins/dsh-context-acp/package.json',
  'plugins/dsh-context-acp/cordis.patch.yml',
  'plugins/dsh-context-acp/config/acp.json',
  'plugins/dsh-context-acp/config/preset-override.generated.yml',
  'plugins/dsh-context-acp/config/runtime.json',
  'plugins/dsh-context-acp/lib/index.js',
  'plugins/dsh-context-acp/lib/engine.mjs',
  'plugins/dsh-context-acp/lib/barriers.mjs',
  'plugins/dsh-context-acp/lib/tools-compress.mjs',
  'plugins/dsh-context-acp/lib/ledger.mjs',
  'plugins/dsh-context-acp/lib/tools-restore.mjs',
  'plugins/dsh-context-acp/lib/tools-status.mjs',
  'plugins/dsh-context-acp/lib/nudge.mjs',
  'plugins/dsh-context-acp/lib/fallback.mjs',
  'plugins/dsh-context-acp/lib/handoff.mjs',
  'plugins/dsh-context-acp/lib/prompt.mjs',
  'plugins/dsh-context-acp/lib/command.mjs',
  'plugins/dsh-context-acp/lib/settings.mjs',
  'plugins/dsh-context-acp/lib/state.mjs',
  'plugins/dsh-context-acp/client.js',
  'tools/gen-acp-preset.mjs',
  'tools/tests/acp-engine.mjs',
  'tools/tests/acp-ledger.mjs',
  'tools/tests/acp-nudge.mjs',
  'tools/tests/acp-fallback.mjs',
  'tools/tests/acp-handoff.mjs',
  'tools/tests/acp-mount.mjs',
  'tools/tests/acp-e2e.mjs',
  'tools/tests/acp-client.mjs',
  'tools/tests/lib/acp-driver.mjs',
  'services/commandcode-bridge/server.mjs',
  'services/commandcode-bridge/start.sh',
  'services/commandcode-bridge/stop.sh',
  'tools/sync-plugins.mjs',
  'tools/sync-models.mjs',
  'tools/sync-model-policy.mjs',
  'tools/lib/model-config.mjs',
  'tools/lib/probe.mjs',
  // js-yaml 的统一解析层：以前两个工具把 `/home/<user>/dsh/node_modules/...`
  // 写死在 import 里，换机器/换用户名就直接 ERR_MODULE_NOT_FOUND。
  'tools/lib/yaml.mjs',
  'tools/tests/model-policy.mjs',
  'tools/tests/web-search-switch.mjs',
  'tools/tests/provider-router-adaptive.mjs',
  'tools/tests/context-guard-trigger.mjs',
  'tools/set-search-provider.mjs',
  // 一条命令体检（补丁 / pack 位置 / 端口 / mode.json / key / 模型引用）
  'tools/preflight.mjs',
  // 定时任务入口：补 provider key 与每台机器的 DSH_* 环境
  'tools/run-model-policy.sh',
  'tools/export-provider-keys.mjs',
  'config/model-policy.yml',
  'patches/apply-required-array.sh',
  'patches/apply-anthropic-tool-fixes.sh',
];

/**
 * 内容文件的最小字节数：只查存在会被空文件 / 被截断的文件骗过。
 * 阈值都取得远小于当前实际大小，仅用于抓「空壳」。
 */
const MIN_BYTES = {
  'package.json': 200,
  'cordis.patch.yml': 200,
  'config/cordis.patch.example.yml': 5000,
  'LICENSES/README.md': 200,
  'ops/bootstrap-machine.sh': 1000,
  'ops/restart-dsh.sh': 300,
  'ops/tailnet-entry.mjs': 2000,
  'ops/dsh-entry.service': 300,
  'ops/install-tailnet-autostart.sh': 2000,
  'ops/NETWORK-NOTES.md': 500,
  'plugins/provider-router/lib/router.mjs': 2000,
  'plugins/provider-router/lib/auto-mode.mjs': 2000,
  'plugins/provider-router/lib/profile-providers.mjs': 1000,
  'plugins/provider-router/start.sh': 300,
  'plugins/provider-router/providers.example.json': 100,
  'plugins/dsh-context-guard/index.js': 20000,
  'plugins/dsh-context-guard/client.js': 20000,
  'plugins/dsh-context-guard/lib/trigger.mjs': 2000,
  'plugins/dsh-context-guard/lib/scheduler.mjs': 2000,
  'plugins/dsh-session-purge/lib/core.mjs': 2000,
  'plugins/dsh-session-purge/clean-roster.sh': 100,
  'plugins/dsh-session-purge/tests/sync-async.mjs': 1500,
  'plugins/dsh-opencode-session-header/tests/smoke.mjs': 3000,
  'plugins/dsh-code-theme/client.js': 2000,
  'plugins/dsh-code-theme/tools/check-contrast.mjs': 500,
  'plugins/dsh-web-search-switch/lib/index.js': 3000,
  'plugins/dsh-web-search-switch/lib/client.js': 2000,
  'plugins/dsh-web-search-switch/lib/pin.mjs': 2000,
  'plugins/dsh-context-acp/config/acp.json': 200,
  'plugins/dsh-context-acp/config/preset-override.generated.yml': 15000,
  'plugins/dsh-context-acp/config/runtime.json': 200,
  'plugins/dsh-context-acp/lib/index.js': 4000,
  'plugins/dsh-context-acp/lib/engine.mjs': 8000,
  'plugins/dsh-context-acp/lib/fallback.mjs': 1500,
  'plugins/dsh-context-acp/lib/handoff.mjs': 3000,
  'plugins/dsh-context-acp/lib/barriers.mjs': 5000,
  'plugins/dsh-context-acp/lib/tools-compress.mjs': 8000,
  'plugins/dsh-context-acp/lib/ledger.mjs': 6000,
  'plugins/dsh-context-acp/lib/tools-restore.mjs': 6000,
  'plugins/dsh-context-acp/lib/tools-status.mjs': 4000,
  'plugins/dsh-context-acp/lib/nudge.mjs': 8000,
  'plugins/dsh-context-acp/lib/settings.mjs': 8000,
  'plugins/dsh-context-acp/client.js': 8000,
  'tools/gen-acp-preset.mjs': 5000,
  'tools/tests/acp-engine.mjs': 5000,
  'tools/tests/acp-ledger.mjs': 5000,
  'tools/tests/acp-nudge.mjs': 5000,
  'tools/tests/acp-fallback.mjs': 3000,
  'tools/tests/acp-handoff.mjs': 3000,
  'tools/tests/acp-mount.mjs': 5000,
  'tools/tests/acp-e2e.mjs': 5000,
  'tools/tests/acp-client.mjs': 4000,
  'tools/tests/lib/acp-driver.mjs': 5000,
  'services/commandcode-bridge/server.mjs': 2000,
  'services/commandcode-bridge/start.sh': 300,
  'services/commandcode-bridge/stop.sh': 100,
  'tools/sync-plugins.mjs': 1000,
  'tools/sync-models.mjs': 1000,
  'tools/sync-model-policy.mjs': 3000,
  'tools/lib/model-config.mjs': 3000,
  'tools/lib/probe.mjs': 3000,
  'tools/lib/yaml.mjs': 500,
  'tools/tests/model-policy.mjs': 2000,
  'tools/tests/web-search-switch.mjs': 2000,
  'tools/tests/provider-router-adaptive.mjs': 2000,
  'tools/tests/context-guard-trigger.mjs': 2000,
  'tools/set-search-provider.mjs': 2000,
  'tools/preflight.mjs': 2000,
  'tools/run-model-policy.sh': 300,
  'tools/export-provider-keys.mjs': 500,
  'config/model-policy.yml': 1000,
  'patches/apply-required-array.sh': 300,
  'patches/apply-anthropic-tool-fixes.sh': 500,
};

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
    // 脚本自己的 guard 要求 Fix A + Fix B 的标记**都**在才算打过；
    // 只认一个的话，机器上只有 Fix A 时会被误判成「已打」，Fix B 永远补不上。
    markers: ['enforceToolResultAdjacency', 'tool_use always trails'],
    why: '修 400 tool_use ids were found without tool_result blocks',
  },
];

/** 统一取标记：单条用 marker，多条用 markers（全部存在才算已打）。 */
function patchMarkers(p) {
  return Array.isArray(p.markers) ? p.markers : [p.marker];
}

function patchState() {
  return PATCHES.map((p) => {
    const markers = patchMarkers(p);
    if (!existsSync(p.file)) return { ...p, markers, state: 'missing' };
    try {
      const content = readFileSync(p.file, 'utf8');
      const missing = markers.filter((m) => !content.includes(m));
      return { ...p, markers, missing, state: missing.length === 0 ? 'applied' : 'pending' };
    } catch {
      return { ...p, markers, state: 'unreadable' };
    }
  });
}

function reportPatches() {
  console.log('\nnode_modules \u8865\u4e01\uff08\u4e0d\u6253\u5c31\u7528\u4e0d\u4e86 agentrouter\uff09\uff1a');
  // 注意：不能叫 bad —— 那会遮蔽模块级的 bad() 报告函数。
  let failures = 0;
  for (const p of patchState()) {
    if (p.state === 'applied') ok(`${p.name} \u5df2\u6253`);
    else if (p.state === 'missing') { bad(`${p.name}\uff1a\u627e\u4e0d\u5230 ${p.file}`); failures++; }
    else {
      const lack = p.state === 'pending' && p.missing?.length ? `\uff08\u8fd8\u7f3a ${p.missing.join(' + ')}\uff09` : '';
      bad(`${p.name} \u672a\u6253${lack} \u2014\u2014 ${p.why}`);
      failures++;
    }
  }
  return failures;
}

function applyPatches() {
  console.log('dsh-guava-pack \u8865\u4e01\n');
  console.log(`DSH_HOME = ${DSH_HOME}\n`);
  let failures = 0;
  for (const p of patchState()) {
    const script = join(PACK_DIR, p.script);
    if (p.state === 'applied') { ok(`${p.name}\uff1a\u5df2\u6253\u8fc7\uff0c\u8df3\u8fc7`); continue; }
    if (p.state === 'missing') {
      bad(`${p.name}\uff1a\u76ee\u6807\u6587\u4ef6\u4e0d\u5b58\u5728\uff08${p.file}\uff09\u2014\u2014 DSH_HOME \u5bf9\u5417\uff1f`);
      failures++;
      continue;
    }
    try {
      const out = execFileSync('bash', [script], { encoding: 'utf8', env: { ...process.env, DSH_HOME } });
      ok(`${p.name}\uff1a${out.trim().split('\n').pop()}`);
    } catch (err) {
      bad(`${p.name} \u5931\u8d25\uff1a${(err.stdout || err.message || '').toString().trim().split('\n').pop()}`);
      info('\u811a\u672c\u81ea\u5e26\u9526\u70b9\u65ad\u8a00\uff1b\u62a5\u300c\u9526\u70b9\u672a\u627e\u5230\u300d\u901a\u5e38\u662f dsh \u4f9d\u8d56\u5347\u7ea7\u4e86\uff0c\u9700\u4eba\u5de5\u6838\u5bf9');
      failures++;
    }
  }
  if (failures === 0) {
    console.log('\n\u6253\u5b8c\u540e\u91cd\u542f DSH \u751f\u6548\uff1asystemctl --user restart dsh.service');
  } else {
    console.log(`\n${failures} \u4e2a\u8865\u4e01\u672a\u80fd\u5e94\u7528 \u2014\u2014 \u5148\u89e3\u51b3\u4e0a\u9762\u7684\u95ee\u9898\uff08\u4f8b\u5982 DSH_HOME \u6307\u5411\uff09\uff0c\u4e0d\u8981\u76f4\u63a5\u91cd\u542f`);
  }
  return failures;
}

function check() {
  console.log('dsh-guava-pack \u5b89\u88c5\u81ea\u68c0\n');
  let failed = 0;

  /** plugins/ 下的一级目录（每个插件一个）。 */
  let pluginDirs = [];
  try {
    pluginDirs = readdirSync(join(PACK_DIR, 'plugins'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    bad(`plugins/ \u8bfb\u4e0d\u4e86\uff1a${err.message}`);
    failed++;
  }

  console.log('\u5305\u5185\u5bb9\uff1a');
  for (const rel of REQUIRED) {
    const abs = join(PACK_DIR, rel);
    if (!existsSync(abs)) { bad(`${rel} \u7f3a\u5931`); failed++; continue; }
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch (err) {
      bad(`${rel} \u8bfb\u4e0d\u4e86\uff1a${err.message}`);
      failed++;
      continue;
    }
    if (size === 0) { bad(`${rel} \u662f\u7a7a\u6587\u4ef6`); failed++; continue; }
    const min = MIN_BYTES[rel];
    if (min && size < min) { bad(`${rel} \u53ea\u6709 ${size} \u5b57\u8282\uff08\u5e94 \u2265 ${min}\uff09\u2014\u2014 \u7591\u4f3c\u88ab\u622a\u65ad`); failed++; continue; }
    ok(rel);
  }

  console.log('\nbundle \u58f0\u660e\uff1a');
  try {
    const pkg = JSON.parse(readFileSync(join(PACK_DIR, 'package.json'), 'utf8'));
    const patch = pkg?.dsh?.bundle?.patch;
    // patch 可以是单个字符串或数组（上游 dsh-web-app 就是数组）。
    const patchList = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : [];
    if (patchList.length > 0 && patchList.every((item) => typeof item === 'string' && existsSync(join(PACK_DIR, item)))) {
      ok(`dsh.bundle.patch = ${patchList.join(', ')}`);
    } else {
      bad('package.json \u7f3a dsh.bundle.patch\uff08\u6216\u6307\u5411\u4e0d\u5b58\u5728\u7684\u6587\u4ef6\uff09\uff0cDSH \u4e0d\u4f1a\u628a\u5b83\u5f53 bundle \u52a0\u8f7d');
      failed++;
    }
    // 模型驱动压缩要求：插件包必须能从 profile node_modules 解析（preset 里的
    // `dsh-context-acp/engine` 是裸说明符），所以 pack 要把它声明成 file: 依赖。
    const acpDep = pkg?.dependencies?.['dsh-context-acp'];
    if (typeof acpDep === 'string' && acpDep.includes('./plugins/dsh-context-acp')) ok('dsh-context-acp \u5df2\u58f0\u660e\u4e3a file: \u4f9d\u8d56\uff08preset \u5f15\u64ce\u88f8\u8bf4\u660e\u7b26\u53ef\u89e3\u6790\uff09');
    else { bad('package.json \u7f3a dsh-context-acp \u7684 file: \u4f9d\u8d56 \u2014\u2014 \u88c5\u6210 bundle \u540e preset \u91cc\u7684 dsh-context-acp/engine \u4f1a\u89e3\u6790\u5931\u8d25'); failed++; }
    if (pkg?.dsh?.client) {
      info('\u5305\u672c\u8eab\u6709 dsh.client\uff08\u4e0d\u5e94\u8be5\uff09\u2014\u2014 \u5ba2\u6237\u7aef\u7531\u5b50\u63d2\u4ef6\u63d0\u4f9b');
    }
  } catch (err) {
    bad(`package.json \u8bfb\u4e0d\u4e86\uff1a${err.message}`);
    failed++;
  }

  console.log('\n\u5b50\u63d2\u4ef6\u7684 dsh.bundle.patch\uff08\u6bcf\u4e2a\u63d2\u4ef6\u81ea\u5df1\u7684 package.json\uff09\uff1a');
  for (const dir of pluginDirs) {
    const pkgRel = `plugins/${dir}/package.json`;
    let sub;
    try {
      sub = JSON.parse(readFileSync(join(PACK_DIR, pkgRel), 'utf8'));
    } catch (err) {
      bad(`${pkgRel} \u8bfb\u4e0d\u4e86\uff1a${err.message}`);
      failed++;
      continue;
    }
    const subPatchRaw = sub?.dsh?.bundle?.patch;
    const subPatchList = typeof subPatchRaw === 'string' ? [subPatchRaw] : Array.isArray(subPatchRaw) ? subPatchRaw : [];
    if (subPatchList.length === 0) {
      bad(`${pkgRel} \u7f3a dsh.bundle.patch\uff0cDSH \u4e0d\u4f1a\u52a0\u8f7d\u8fd9\u4e2a\u5b50\u63d2\u4ef6`);
      failed++;
      continue;
    }
    for (const subPatch of subPatchList) {
      const subTarget = join(PACK_DIR, 'plugins', dir, subPatch);
      if (existsSync(subTarget)) ok(`${dir}: ${subPatch} \u2192 \u5b58\u5728`);
      else { bad(`${dir}: dsh.bundle.patch=${subPatch} \u2192 \u76ee\u6807\u4e0d\u5b58\u5728`); failed++; }
    }
  }

  console.log('\npatch \u884c\uff08\u76f8\u5bf9\u8def\u5f84\u5e94\u951a\u5728 patch \u65c1\u8fb9\uff09\uff1a');
  try {
    const lines = readFileSync(join(PACK_DIR, 'cordis.patch.yml'), 'utf8').split(/\r?\n/);
    const names = [];
    let idCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*-\s*id:\s*\S/.test(lines[i])) continue;
      idCount++;
      // 「- id:」的下一行必须是带值的 name: —— 光有 name: 空行不能静默跳过。
      const m = (lines[i + 1] ?? '').match(/^\s*name:\s*(.*)$/);
      const value = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
      if (value === '') {
        bad(`\u7b2c ${i + 1} \u884c\u7684\u300c- id:\u300d\u540e\u9762\u6ca1\u6709\u5e26\u503c\u7684 name: \u884c`);
        failed++;
      } else {
        names.push(value);
      }
    }
    if (idCount === 0) {
      bad('\u6ca1\u627e\u5230\u300c- id:\u300d\u6761\u76ee');
      failed++;
    } else if (pluginDirs.length === 0) {
      // plugins/ 读不到时前面已经报错，这里不重复报
    } else if (idCount !== pluginDirs.length) {
      bad(`cordis.patch.yml \u6709 ${idCount} \u4e2a\u300c- id:\u300d\u6761\u76ee\uff0cplugins/ \u4e0b\u6709 ${pluginDirs.length} \u4e2a\u76ee\u5f55 \u2014\u2014 \u4e24\u8fb9\u5fc5\u987b\u4e00\u4e00\u5bf9\u5e94`);
      failed++;
    } else {
      ok(`\u6761\u76ee\u6570 ${idCount} == plugins/ \u76ee\u5f55\u6570 ${pluginDirs.length}`);
    }
    for (const rel of names) {
      if (!rel.startsWith('./')) { info(`name: ${rel}\uff08\u975e\u76f8\u5bf9\u8def\u5f84\uff0c\u8df3\u8fc7\u5b58\u5728\u6027\u68c0\u67e5\uff09`); continue; }
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

  console.log('\nACP preset \u8986\u76d6\u5c42\uff08\u4e0a\u6e38\u6f02\u79fb\uff09\uff1a');
  try {
    // 生成物必须与上游 preset 一致：DSH 升级后不重跑生成器 = preset 静默失配
    // （少挂一行工具不会报错），所以这条必须进安装自检。
    execFileSync(process.execPath, [join(PACK_DIR, 'tools/gen-acp-preset.mjs'), '--check'], { cwd: PACK_DIR, stdio: 'pipe' });
    ok('gen-acp-preset --check \u5e72\u51c0\uff08preset \u8986\u76d6\u5c42\u4e0e\u4e0a\u6e38\u4e00\u81f4\uff09');
  } catch (err) {
    bad('gen-acp-preset --check \u5931\u8d25\uff08\u4e0a\u6e38\u5347\u7ea7\u6216\u624b\u6539\u8fc7\u751f\u6210\u7269\uff09\u2014\u2014 \u8dd1 node tools/gen-acp-preset.mjs --write \u91cd\u751f\u6210');
    const detail = String(err?.stdout ?? '') + String(err?.stderr ?? '');
    if (detail.trim() !== '') info(detail.trim().split('\n').slice(-4).join(' | '));
    failed++;
  }

  failed += reportPatches();

  console.log(`\n\u7ed3\u679c\uff1a${failed === 0 ? '\u5305\u5b8c\u6574\uff0c\u53ef\u4ee5\u88c5' : failed + ' \u9879\u9700\u5904\u7406'}`);
  return failed === 0 ? 0 : 1;
}

function init() {
  const example = join(PACK_DIR, 'plugins/provider-router/providers.example.json');
  const target = join(PACK_DIR, 'plugins/provider-router/providers.json');
  let failures = 0;
  if (existsSync(target)) {
    info(`providers.json \u5df2\u5b58\u5728\uff0c\u4e0d\u8986\u76d6\uff1a${target}`);
  } else if (existsSync(example)) {
    copyFileSync(example, target);
    ok(`\u5df2\u4ece\u793a\u4f8b\u751f\u6210 providers.json\uff1a${target}`);
    info('\u91cc\u9762\u7684 my-cloud-llm \u662f\u5360\u4f4d\u793a\u4f8b\uff0c\u8bf7\u6309\u9700\u6539\u6210\u4f60\u7684\u4e0a\u6e38');
  } else {
    bad('\u627e\u4e0d\u5230 providers.example.json');
    failures++;
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
  return failures === 0 ? 0 : 1;
}

if (args.has('--patch')) process.exit(applyPatches());
else if (args.has('--init')) process.exit(init());
else process.exit(check());
