#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/tests/acp-mount.mjs — P0 尖刀验证（隔离 profile，不碰 live）。
 *
 * ## 为什么必须隔离
 *
 * 本机 live DSH 在 `/home/guava5tar_/dsh/profiles/web`，改它要重启（会杀掉正在跑的
 * 会话）。P0 只需要证明机制可行，不值得动 live。所以这里用**临时 DSH_HOME**：
 *   - `$DSH_HOME/profiles/<name>/` 自己一套（sessions/logs 全隔离）；
 *   - 通过 `<profile>/node_modules/dsh-context-acp` symlink 让 bundle 解析到本包；
 *   - `--patch` 叠加测试专用覆盖层（不写进任何 profile 文件）。
 *
 * ## 三个断言（对应 ACP-PLAN §5 P0 门禁）
 *
 * A. `--dump-config` 组合结果里，四个 preset 的 `compaction` group 都换成了
 *    `dsh-context-acp/engine`，且没有任何 preset 还挂着启用的 `compaction-basic`；
 *    根平面的 `compaction-basic` 仍被 web-app disabled（不产生双 provider）。
 * B. 隔离 web 进程里 `ctx.compaction.constructor.name === 'AcpEngine'`，
 *    且 compress/decompress/search_context/acp_status 四个工具都在注册表里。
 * C. 回滚开关：同样组合换成 `backend: basic` → `constructor.name ===
 *    'BasicCompactionEngine'`（挂的是上游类本身）。
 *
 * 用法：
 *   node tools/tests/acp-mount.mjs            # 跑全部
 *   node tools/tests/acp-mount.mjs --keep     # 保留临时目录（排障）
 *
 * @module tools/tests/acp-mount
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** 定位 dsh CLI 的 bin.js（从 pack 位置解析 @deepseek-ai/dsh，换机器也成立）。 */
function resolveDshBin() {
  const anchors = [join(PACK_DIR, 'package.json')];
  if (process.env.DSH_HOME) anchors.push(join(process.env.DSH_HOME, 'package.json'));
  if (process.env.HOME) anchors.push(join(process.env.HOME, 'dsh', 'package.json'));
  const tried = [];
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      const require = createRequire(pathToFileURL(anchor).href);
      const pkgPath = require.resolve('@deepseek-ai/dsh/package.json');
      return join(dirname(pkgPath), 'lib', 'bin.js');
    } catch (error) {
      tried.push(`${anchor} → ${error?.code ?? error}`);
    }
  }
  throw new Error(`找不到 @deepseek-ai/dsh。已尝试：\n${tried.join('\n')}`);
}

/** 建一个隔离 DSH_HOME，里面只有测试 profile。 */
function makeLab() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acp-p0-'));
  const home = join(root, 'home');
  const profiles = join(home, 'profiles');
  const profileDir = join(profiles, 'acp-lab');
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
  // Node 解析：profile 里的 bare specifier `dsh-context-acp/engine` 必须能解析到包，
  // 所以造一个 profile 级 node_modules 软链（等价于 `dsh plugin add` 之后的形态）。
  try {
    symlinkSync(PLUGIN_DIR, join(nodeModules, 'dsh-context-acp'), 'dir');
  } catch (error) {
    throw new Error(`创建 ${join(nodeModules, 'dsh-context-acp')} 软链失败：${error?.message ?? error}`);
  }
  return { root, home, profileDir };
}

/** 生成测试覆盖层：把根平面 compaction 换成目标引擎（隔离进程专用）。 */
function writeRuntimeOverlay(lab, backend) {
  const file = join(lab.root, `overlay-${backend}.yml`);
  writeFileSync(file, [
    '# 测试专用 overlay：把根平面 compaction-basic 换成被测引擎。',
    '- id: compaction-basic',
    '  disabled: true',
    // 回滚语义 = 生成器把 runtime.json 与 preset 行一起换成 basic；
    // 这里用行配置覆盖同一效果（行配置最后合并，优先级与生成配置一致）。
    ...(backend === 'basic' ? ['- id: context-acp', '  config: { backend: basic }'] : []),
    '- insert:',
    '    - id: compaction-acp-root',
    '      name: dsh-context-acp/engine',
    `      config: { backend: ${backend} }`,
    '',
  ].join('\n'), 'utf8');
  return file;
}

/** 跑一次 CLI，返回 { status, stdout, stderr }。 */
function runDsh({ bin, lab, args, env = {} }) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: lab.root,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      DSH_HOME: lab.home,
      // 本测试不碰网络/模型；把 provider 相关环境压掉，避免误连真服务。
      DSH_ACP_TEST: '1',
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', signal: result.signal };
}

/** 解析 dump（YAML 列表；`!!js` 标量转成可比较的对象）。 */
async function parseDump(bin, lab) {
  const require = createRequire(pathToFileURL(join(PACK_DIR, 'package.json')).href);
  const yaml = await import(pathToFileURL(require.resolve('js-yaml')).href);
  const mod = yaml.default ?? yaml;
  const JsExpr = new mod.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  });
  const schema = mod.JSON_SCHEMA.extend(JsExpr);
  const result = runDsh({ bin, lab, args: ['--profile', 'acp-lab', '--dump-config'] });
  if (result.status !== 0) throw new Error(`--dump-config 失败（status=${result.status}）：\n${result.stderr.slice(-4000)}`);
  return mod.load(result.stdout, { schema });
}

/** 取某个 id 的**最后一次**出现（后层 patch 覆盖前层）。 */
function lastById(rows, id) {
  const hits = rows.filter((row) => row !== null && typeof row === 'object' && row.id === id);
  return hits.length === 0 ? undefined : hits[hits.length - 1];
}

async function checkDumpComposition(bin, lab) {
  const rows = await parseDump(bin, lab);
  const presetIds = ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'];
  let engineRows = 0;
  let enabledBasicInPresets = 0;
  for (const presetId of presetIds) {
    const row = lastById(rows, presetId);
    if (row === undefined) {
      fail(`preset 覆盖/${presetId}`, 'dump 里找不到该 preset 行');
      continue;
    }
    const compaction = (row.config?.plugins ?? []).find((child) => child?.id === 'compaction' && child?.group === true);
    if (compaction === undefined) {
      fail(`preset 覆盖/${presetId}`, 'preset 里没有 compaction group');
      continue;
    }
    const engine = (compaction.config ?? []).find((child) => child?.name === 'dsh-context-acp/engine');
    if (engine === undefined) {
      fail(`preset 覆盖/${presetId}`, 'compaction group 里没有 dsh-context-acp/engine');
      continue;
    }
    engineRows += 1;
    const basic = (compaction.config ?? []).find((child) => child?.name === '@deepseek-ai/dsh-compaction-basic');
    if (basic !== undefined && basic.disabled !== true) enabledBasicInPresets += 1;
  }
  if (engineRows === 4) pass('四个 preset 都换成 dsh-context-acp/engine', 'standard/ptc/minimal/cordis');
  if (enabledBasicInPresets === 0) pass('preset 里没有残留启用的 compaction-basic（无双 provider）');
  else fail('preset 双 provider', `${enabledBasicInPresets} 个 preset 仍挂着启用的 compaction-basic`);

  const rootBasic = lastById(rows, 'compaction-basic');
  if (rootBasic?.disabled === true) pass('根平面 compaction-basic 仍 disabled（web-app 原策略）');
  else fail('根平面 compaction-basic', `期望 disabled:true，实际 ${JSON.stringify(rootBasic ?? null).slice(0, 200)}`);

  const rootPlugin = lastById(rows, 'context-acp');
  if (rootPlugin?.name === 'dsh-context-acp') pass('根平面插件 dsh-context-acp 已挂载');
  else fail('根插件', `dump 里 context-acp 行不是 dsh-context-acp：${JSON.stringify(rootPlugin ?? null).slice(0, 200)}`);
}

/** 跑一次隔离 web 进程，读探针 JSON。 */
function checkRuntimeMount(bin, lab, backend) {
  const probeFile = join(lab.root, `probe-${backend}.json`);
  const overlay = writeRuntimeOverlay(lab, backend);
  const result = runDsh({
    bin,
    lab,
    args: ['--profile', 'acp-lab', '--patch', overlay, '--port', '0', '--no-open'],
    env: {
      DSH_ACP_MOUNT_PROBE: probeFile,
      DSH_ACP_MOUNT_PROBE_EXIT: '1',
    },
  });
  if (!existsSync(probeFile)) {
    const errorFile = `${probeFile}.error`;
    const error = existsSync(errorFile) ? readFileSync(errorFile, 'utf8') : '';
    fail(`runtime mount/${backend}`, `探针没写出（status=${result.status}, signal=${result.signal}）${error ? `\n${error.slice(0, 2000)}` : ''}\nstderr tail:\n${result.stderr.slice(-3000)}`);
    return;
  }
  const report = JSON.parse(readFileSync(probeFile, 'utf8'));
  const expected = backend === 'basic' ? 'BasicCompactionEngine' : 'AcpEngine';
  if (report.engineConstructor === expected) pass(`runtime mount/${backend}`, `ctx.compaction = ${report.engineConstructor}`);
  else fail(`runtime mount/${backend}`, `期望 ${expected}，实际 ${JSON.stringify(report.engineConstructor)}（stderr tail: ${result.stderr.slice(-1500)}）`);
  if (backend === 'basic') {
    // 回滚路径不再注册 ACP 工具（根插件惰性）。
    if (report.acpToolCount === 0) pass('rollback/basic 不注册 ACP 工具（根插件惰性）');
    else fail('rollback/basic', `仍注册了 ${report.acpToolCount} 个 ACP 工具`);
    return;
  }
  const expectedTools = ['compress', 'decompress', 'search_context', 'acp_status'];
  const missing = expectedTools.filter((tool) => !report.acpTools?.includes(tool));
  if (missing.length === 0) pass('四个 ACP 工具已注册', expectedTools.join(', '));
  else fail('ACP 工具注册', `缺：${missing.join(', ')}（实际 ${JSON.stringify(report.acpTools)}）`);
  checkPresetRealmActivation(report);
}

/**
 * P0 的关键运行时断言：四个 preset 的 **已激活 revision** 里确实挂载了
 * `dsh-context-acp/engine`，没有内置 compaction-basic，且 isolate 没有泄漏
 * compaction 服务到 realm 外（泄漏 = 根平面与 preset 双 provider 的隐患）。
 */
function checkPresetRealmActivation(report) {
  const presets = Array.isArray(report.presets) ? report.presets : [];
  const editable = ['standard', 'ptc', 'minimal', 'cordis'].map((id) => presets.find((item) => item.id === id));
  const broken = editable.filter((item) => item === undefined || item.error !== undefined);
  if (broken.length > 0) {
    fail('preset realm 激活', `inspectCompositions 缺 preset 或失败：${JSON.stringify(broken)}`);
    return;
  }
  const bad = editable.filter((item) => !(item.engineRows >= 1) || item.basicRows !== 0 || (item.leakedServices ?? []).some((name) => name === 'compaction'));
  if (bad.length === 0) pass('preset realm 里引擎已真实激活', '4/4 preset，无 basic 残留，compaction 未泄漏出 isolate');
  else fail('preset realm 激活', JSON.stringify(bad));
}

function checkGenerator() {
  const result = spawnSync(process.execPath, [join(PACK_DIR, 'tools', 'gen-acp-preset.mjs'), '--check'], {
    cwd: PACK_DIR,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? '' },
  });
  if (result.status === 0) pass('gen-acp-preset --check（无上游漂移）');
  else fail('gen-acp-preset --check', `status=${result.status}\n${result.stdout}${result.stderr}`);
}

const started = Date.now();
let lab;
try {
  const bin = resolveDshBin();
  lab = makeLab();
  console.log(`\n[acp-mount] dsh bin = ${bin}`);
  console.log(`[acp-mount] 隔离 DSH_HOME = ${lab.home}\n`);
  checkGenerator();
  await checkDumpComposition(bin, lab);
  checkRuntimeMount(bin, lab, 'acp');
  checkRuntimeMount(bin, lab, 'basic');
} catch (error) {
  fail('测试框架', String(error?.stack ?? error));
} finally {
  if (lab !== undefined && !KEEP) {
    try {
      rmSync(lab.root, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  } else if (lab !== undefined) {
    console.log(`\n[acp-mount] 保留临时目录：${lab.root}`);
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n[acp-mount] ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} in ${elapsed}s`);
// 这行给"证明跑了"留指纹（CI 里区分"没跑"和"跑过且绿"）。
console.log(`[acp-mount] fingerprint=${createHash('sha256').update(failures.map((item) => item.name).join(',') + elapsed).digest('hex').slice(0, 12)}`);
process.exit(failures.length === 0 ? 0 : 1);
