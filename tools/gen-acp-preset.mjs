#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/gen-acp-preset.mjs — 生成 dsh-context-acp 的 preset 覆盖层。
 *
 * ## 为什么需要生成器（而不是手写 profile patch）
 *
 * web 组合把压缩能力放在 **agent preset** 里：`dsh-web-app/presets/*.patch.yml`
 * 的四个 preset 各自声明一份 `compaction` group，group 里挂着 `compaction-basic`。
 * profile patch 只能按**行 id** 覆盖整行 `config` —— 而 `preset-*` 行的 `config`
 * 是整棵 `config.plugins` 数组。上游每加/删一行，手写副本就失配（而且失配是
 * 静默的：少挂一个 tool 不会报错）。
 *
 * 所以这里做确定性变换 + 上游哈希校验：
 *   1. 读上游四个 preset 文件（`@deepseek-ai/dsh-web-app/presets/*.patch.yml`）；
 *   2. 逐字深拷贝每个 preset 的 `config`，只把 `compaction` group 里的
 *      `compaction-basic` 行换成 `dsh-context-acp/engine`（backend=acp 时）；
 *   3. 写出 `plugins/dsh-context-acp/config/preset-override.generated.yml`；
 *   4. 同时写出 `config/runtime.json`（根插件的唯一配置源）。
 *
 * `--check` 重新生成并与磁盘比对：上游升级而没重跑生成器 → 退出码 1。
 * 这条检查进 `install.mjs --check` 与 `npm test`，所以漂移不会混过去。
 *
 * ## 用法
 *
 *   node tools/gen-acp-preset.mjs                 # 等价 --check（默认不写盘）
 *   node tools/gen-acp-preset.mjs --write         # 重新生成两个文件
 *   node tools/gen-acp-preset.mjs --check         # 校验（CI/门禁）
 *   node tools/gen-acp-preset.mjs --write --backend basic   # 回滚到内置压缩
 *   node tools/gen-acp-preset.mjs --presets-dir <dir>       # 测试用：指定上游目录
 *
 * @module tools/gen-acp-preset
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL_FILE = fileURLToPath(import.meta.url);
const PACK_DIR = dirname(dirname(TOOL_FILE));
const PLUGIN_DIR = join(PACK_DIR, 'plugins', 'dsh-context-acp');
const CONFIG_DIR = join(PLUGIN_DIR, 'config');
const SOURCE_CONFIG = join(CONFIG_DIR, 'acp.json');
const OUT_PRESET = join(CONFIG_DIR, 'preset-override.generated.yml');
const OUT_RUNTIME = join(CONFIG_DIR, 'runtime.json');

/** 必须被覆盖的 preset 文件（顺序即输出顺序，保证确定性）。 */
const PRESET_FILES = ['standard', 'ptc', 'minimal', 'cordis'];

/**
 * 引擎 row 的模块说明符。
 *
 * 为什么必须是**包名**而不是相对路径：preset 行由 `dsh-web-app/presets/*.patch.yml`
 * 声明，profile patch 只是按行 id 覆盖它的 `config`；preset 子行的模块解析 baseUrl
 * 仍是**声明该 preset 的那个 patch 文件**（实测相对路径 `../lib/engine.mjs`
 * 会解析到 dsh-web-app 目录，preset 直接激活失败）。所以这里只能是可被
 * `createRequire(profileDir)` 解析的裸说明符。
 *
 * 安装形态要求：插件必须作为**独立包**出现在 profile 的 node_modules 里。
 * 两种支持的装法：
 *   - 直接把 `plugins/dsh-context-acp` 加进 profile bundles（本机开发/验收用）；
 *   - 随 dsh-guava-pack 安装：pack 的 package.json 里 `dsh-context-acp` 是
 *     `file:./plugins/dsh-context-acp` 依赖，pnpm 会把它装进 profile node_modules。
 */
const ENGINE_MODULE = 'dsh-context-acp/engine';

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const flagValue = (flag) => {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`);
  return value;
};

const ok = (message) => console.log(`  ✅ ${message}`);
const bad = (message) => console.log(`  ❌ ${message}`);
const info = (message) => console.log(`  ℹ️  ${message}`);

/**
 * 定位 js-yaml 与上游 preset 目录。
 *
 * 解析顺序与 `tools/lib/yaml.mjs` 保持一致：pack 通常在 DSH_HOME 之下，
 * 裸解析最稳；否则按 DSH_HOME 显式找。全部失败时把尝试过的路径打出来 ——
 * 换机器/换用户名导致的 `ERR_MODULE_NOT_FOUND` 不能变成一句"生成失败"。
 */
async function loadYaml() {
  const tried = [];
  try {
    const mod = await import('js-yaml');
    if (mod?.default?.load) return mod.default;
    if (mod?.load) return mod;
  } catch (error) {
    tried.push(`import("js-yaml") → ${error?.code ?? error?.message ?? error}`);
  }
  const homes = [process.env.DSH_HOME, process.env.HOME ? join(process.env.HOME, 'dsh') : undefined].filter(Boolean);
  for (const home of homes) {
    const anchor = join(home, 'package.json');
    if (!existsSync(anchor)) continue;
    try {
      const require = createRequire(pathToFileURL(anchor).href);
      const mod = await import(pathToFileURL(require.resolve('js-yaml')).href);
      const yaml = mod.default ?? mod;
      if (yaml?.load) return yaml;
    } catch (error) {
      tried.push(`createRequire(${anchor}) → ${error?.code ?? error?.message ?? error}`);
    }
  }
  throw new Error(`找不到 js-yaml。已尝试：\n${tried.map((line) => `    - ${line}`).join('\n')}`);
}

/**
 * 定位上游 preset 目录。
 * @param {string|undefined} explicit `--presets-dir`
 * @returns {{ dir: string, version: string }}
 */
function locatePresets(explicit) {
  if (explicit !== undefined) {
    const dir = resolve(explicit);
    if (!existsSync(dir)) throw new Error(`--presets-dir 不存在：${dir}`);
    return { dir, version: 'local' };
  }
  const anchors = [
    join(PACK_DIR, 'package.json'),
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'package.json') : undefined,
    process.env.HOME ? join(process.env.HOME, 'dsh', 'package.json') : undefined,
  ].filter((value) => value !== undefined && existsSync(value));
  const tried = [];
  for (const anchor of anchors) {
    try {
      const require = createRequire(pathToFileURL(anchor).href);
      const pkgPath = require.resolve('@deepseek-ai/dsh-web-app/package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const dir = join(dirname(pkgPath), 'presets');
      if (existsSync(dir)) return { dir, version: String(pkg.version ?? 'unknown') };
      tried.push(`${pkgPath} → presets/ 不存在`);
    } catch (error) {
      tried.push(`createRequire(${anchor}) → ${error?.code ?? error?.message ?? error}`);
    }
  }
  throw new Error(`找不到 @deepseek-ai/dsh-web-app 的 presets 目录。已尝试：\n${tried.map((line) => `    - ${line}`).join('\n')}`);
}

/**
 * js-yaml schema：把 `!!js` 标量当作可 round-trip 的表达式节点。
 *
 * 必须与 Loader 的 dialect 等价（`dsh-app-boot` 内部用
 * `JSON_SCHEMA.extend(JsExpr)`）。我们只需要"保留表达式文本、输出时仍写 !!js"，
 * 不在生成器里求值 —— 求值发生在 Loader 激活那一行时。
 */
function makeSchema(yaml) {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: (data) => data !== null && typeof data === 'object' && typeof data.__jsExpr === 'string',
    represent: (data) => data.__jsExpr,
  });
  return yaml.JSON_SCHEMA.extend(JsExpr);
}

/** 递归深拷贝普通 JSON 值（`!!js` 节点的形状是 `{__jsExpr}`，必须原样保留）。 */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item);
    return out;
  }
  return value;
}

/**
 * 在一个 preset 的 `config` 里就地替换 compaction 行。
 *
 * @param {object} config preset 行的 config（已深拷贝）
 * @param {'acp'|'basic'} backend
 * @param {string} presetLabel 仅用于错误消息
 * @returns {{ config: object, replaced: boolean }}
 */
function transformPresetConfig(config, backend, presetLabel) {
  const plugins = config?.plugins;
  if (!Array.isArray(plugins)) throw new Error(`${presetLabel}: config.plugins 不是数组，上游结构变了`);
  const group = plugins.find((row) => row !== null && typeof row === 'object' && row.id === 'compaction' && row.group === true);
  if (group === undefined) throw new Error(`${presetLabel}: 找不到 id=compaction 的 group，上游结构变了`);
  if (!Array.isArray(group.config)) throw new Error(`${presetLabel}: compaction group 的 config 不是数组，上游结构变了`);
  const index = group.config.findIndex((row) => row !== null && typeof row === 'object' && row.id === 'compaction-basic');
  if (index < 0) throw new Error(`${presetLabel}: compaction group 里没有 compaction-basic 行，上游结构变了`);
  if (backend === 'basic') {
    // 回滚：原样保留上游行（连 name 都不动）——真正的内置实现，插件代码不在路径上。
    return { config, replaced: false };
  }
  const upstream = group.config[index];
  const droppedKeys = Object.keys(upstream).filter((key) => !['id', 'name', 'config'].includes(key));
  // 只保留 id/name/config：行上的其它字段（例如 disabled）属于上游行为，
  // 原样带进引擎行会污染引擎配置；丢弃时在摘要里报告，不静默。
  group.config[index] = { id: 'compaction-basic', name: ENGINE_MODULE, config: { backend: 'acp' } };
  return { config, replaced: true, droppedKeys };
}

/**
 * 计算上游指纹：文件名 + 内容，按固定顺序。上游重排/改一个字符都会变。
 * @param {{name:string,text:string}[]} files
 */
function fingerprint(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.name);
    hash.update('\u0000');
    hash.update(file.text);
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/** 序列化 YAML（确定性：保留键序、禁用 flow style 的随机换行）。 */
function dumpYaml(yaml, schema, value) {
  return yaml.dump(value, { schema, lineWidth: 120, noRefs: true, sortKeys: false, quotingType: '"' });
}

/** 读源配置（acp.json）。 */
function readSourceConfig() {
  try {
    const parsed = JSON.parse(readFileSync(SOURCE_CONFIG, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是对象');
    return parsed;
  } catch (error) {
    throw new Error(`读取 ${SOURCE_CONFIG} 失败：${error?.message ?? error}`);
  }
}

/**
 * 生成两个输出文件的文本。
 * @returns {{ presetText: string, runtimeText: string, backend: string, upstreamHash: string, upstreamVersion: string, replaced: string[] }}
 */
function generate({ explicitPresetsDir, backendOverride }) {
  const source = readSourceConfig();
  const backend = backendOverride ?? (source.backend === 'basic' ? 'basic' : 'acp');
  if (backend !== 'acp' && backend !== 'basic') throw new Error(`acp.json 的 backend 必须是 'acp' 或 'basic'，实际是 ${JSON.stringify(source.backend)}`);

  const { dir, version } = locatePresets(explicitPresetsDir);
  const present = readdirSync(dir).filter((name) => name.endsWith('.patch.yml')).sort();
  const expected = PRESET_FILES.map((name) => `${name}.patch.yml`).sort();
  const missing = expected.filter((name) => !present.includes(name));
  const extra = present.filter((name) => !expected.includes(name));
  if (missing.length > 0) throw new Error(`上游 presets 缺文件：${missing.join(', ')}（生成器需要同步更新）`);
  if (extra.length > 0) throw new Error(`上游 presets 多出文件：${extra.join(', ')}（新 preset 需要纳入覆盖列表）`);

  const files = expected.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
  const upstreamHash = fingerprint(files);
  const replaced = [];

  return (async () => {
    const yaml = await loadYaml();
    const schema = makeSchema(yaml);
    const patchList = [];
    for (const file of files) {
      const label = file.name.replace(/\.patch\.yml$/, '');
      let parsed;
      try {
        parsed = yaml.load(file.text, { schema });
      } catch (error) {
        throw new Error(`解析上游 ${file.name} 失败：${error?.message ?? error}`);
      }
      const entry = Array.isArray(parsed) ? parsed.find((item) => item?.insert?.[0]?.config?.id !== undefined)?.insert?.[0] : undefined;
      if (entry === undefined) throw new Error(`${file.name}: 找不到 preset 声明行，上游结构变了`);
      const config = cloneValue(entry.config);
      const result = transformPresetConfig(config, backend, label);
      if (result.replaced) replaced.push(entry.id);
      if ((result.droppedKeys ?? []).length > 0) info(`${label}: 上游 compaction-basic 行的额外字段被丢弃：${result.droppedKeys.join(', ')}`);
      // 只覆盖 config，不重复 insert（行已由上游 layer 创建；重复 insert 会撞 id）。
      patchList.push({ id: entry.id, config: result.config });
    }

    const header = [
      '# ⚠️ 生成文件，不要手改。',
      '# 生成器: tools/gen-acp-preset.mjs（dsh-context-acp）',
      `# upstream: @deepseek-ai/dsh-web-app@${version}`,
      `# upstream-sha256: ${upstreamHash}`,
      `# backend: ${backend}`,
      `# 覆盖: ${patchList.map((row) => row.id).join(', ')}`,
      '#',
      '# 为什么是这个形状：profile/loader 只能按行 id 覆盖 preset-* 的整行 config，',
      '# 而 config.plugins 是整棵数组 —— 上游每加删一行手写副本就静默失配。',
      '# 所以这里保留上游全部行，只把 compaction group 的 compaction-basic 行换成',
      '# dsh-context-acp/engine（backend=acp）；backend=basic 时原样不动 = 内置压缩。',
      '',
    ].join('\n');
    const presetText = `${header}${dumpYaml(yaml, schema, patchList)}`;

    const runtime = { ...source, backend, $generated: { upstream: `@deepseek-ai/dsh-web-app@${version}`, upstreamSha256: upstreamHash } };
    const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`;

    return {
      presetText,
      runtimeText,
      backend,
      upstreamHash,
      upstreamVersion: version,
      replaced,
      presetRows: patchList.map((row) => row.id),
    };
  })();
}

const mode = hasFlag('--write') ? 'write' : 'check';
const backendOverride = flagValue('--backend');
const explicitPresetsDir = flagValue('--presets-dir');

try {
  const generated = await generate({ explicitPresetsDir, backendOverride });
  const currentPreset = existsSync(OUT_PRESET) ? readFileSync(OUT_PRESET, 'utf8') : undefined;
  const currentRuntime = existsSync(OUT_RUNTIME) ? readFileSync(OUT_RUNTIME, 'utf8') : undefined;
  const presetMatches = currentPreset === generated.presetText;
  const runtimeMatches = currentRuntime === generated.runtimeText;

  info(`上游：@deepseek-ai/dsh-web-app@${generated.upstreamVersion}；backend=${generated.backend}；替换 ${generated.replaced.length} 个 preset`);
  info(`上游指纹：${generated.upstreamHash}`);

  if (mode === 'write') {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(OUT_PRESET, generated.presetText, 'utf8');
    writeFileSync(OUT_RUNTIME, generated.runtimeText, 'utf8');
    ok(`已写出 ${OUT_PRESET}`);
    ok(`已写出 ${OUT_RUNTIME}`);
    if (generated.backend === 'basic') info('backend=basic：根插件会保持惰性、preset 行不动 —— 重启后回到内置压缩');
    process.exit(0);
  }

  if (presetMatches && runtimeMatches) {
    ok('preset 覆盖层与上游一致（无漂移）');
    ok('runtime.json 与 acp.json 一致');
    process.exit(0);
  }
  if (!presetMatches) bad(`${OUT_PRESET} 与重新生成的结果不一致（上游升级或手改过）`);
  if (!runtimeMatches) bad(`${OUT_RUNTIME} 与 ${SOURCE_CONFIG} 不一致`);
  console.log('  提示：跑 `node tools/gen-acp-preset.mjs --write` 重生成后提交。');
  process.exit(1);
} catch (error) {
  bad(`生成失败：${error?.message ?? error}`);
  process.exit(1);
}
