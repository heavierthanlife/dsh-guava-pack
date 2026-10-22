#!/usr/bin/env node
/**
 * preflight — 整套规则书的**一条命令体检**。
 *
 * ## 为什么需要它
 *
 * 这套东西由五个独立进程 + 两个配置文件 + 两个 node_modules 补丁组成：
 *   启动器 · host 插件 · provider-router(8318) · commandcode-bridge(8317) · DSH(3080)
 * 任意一环坏掉时，用户看到的现象都差不多（"模型报错 / 页面卡住"），但根因完全不同。
 * 逐个 ssh 进去翻日志的成本太高，而**大多数故障其实是几条确定性的前提坏了**：
 *
 *   · node_modules 的两个补丁被 `pnpm install` 覆盖 → agentrouter 工具格式 400
 *   · GUAVA_PACK 路径解析错 → 8317/8318 起不来 → 所有经路由的供应商 ECONNREFUSED
 *   · DSH_SSR_PROXY 端口写错（每台机器不同）→ 只有走 SSR 的供应商挂
 *   · 缺 provider key → 探测全是 401，免费模型被"保守保留"
 *   · 默认/子代理引用的模型已下线或该协议不支持工具 → 新会话每轮失败
 *
 * 所以这里把上述前提逐条断言，失败时直接给出**下一步该敲什么**。
 *
 * ## 用法
 *
 *   node tools/preflight.mjs           # 体检（只读，不改任何东西）
 *   node tools/preflight.mjs --json    # 机器可读（给别的脚本用）
 *
 * 退出码：0 全部通过；1 有致命问题；2 只有告警。
 *
 * ## 设计约束（很重要）
 *
 * **只读**。不写配置、不重启服务、不打补丁 —— 体检工具一旦有副作用，就没人敢在
 * 出问题时跑它了。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
const JSON_MODE = process.argv.includes('--json');

/** 收集结果：ok / warn / fail 三类，最后统一汇总。 */
const results = [];
const ok = (area, msg) => results.push({ level: 'ok', area, msg });
const warn = (area, msg, fix) => results.push({ level: 'warn', area, msg, fix });
const fail = (area, msg, fix) => results.push({ level: 'fail', area, msg, fix });
/** 纯信息项：既不告警也不失败，只是让报告完整（例如"还没切过搜后端"）。 */
const info = (area, msg) => results.push({ level: 'info', area, msg });

/** 跑一条命令，返回 { code, out }；不抛错（我们要自己判退出码）。 */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      cwd: opts.cwd ?? PACK_DIR,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

/** GET 一个本地 health 端点（超时短一点，避免体检本身卡住）。 */
async function probeHttp(url, timeoutMs = 2500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 160) };
  } catch (err) {
    return { ok: false, status: 0, body: String(err?.message ?? err).slice(0, 120) };
  }
}

/* ── 1. 运行环境 ──────────────────────────────────────────────────────── */

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) ok('runtime', `Node ${process.versions.node}`);
else fail('runtime', `Node ${process.versions.node} 太旧（pack 要求 >= 20）`, '升级 Node 到 20+');

if (existsSync(join(DSH_HOME, 'node_modules', '@deepseek-ai', 'dsh'))) {
  ok('runtime', `DSH_HOME=${DSH_HOME}`);
} else {
  fail('runtime', `DSH_HOME=${DSH_HOME} 下找不到 @deepseek-ai/dsh`,
    '设 $DSH_HOME 指向真正的 DSH 安装目录（默认 ~/dsh）');
}

/* ── 2. pack 位置（双机最容易错的一环）──────────────────────────────── */

const packCandidates = [
  process.env.DSH_GUAVA_PACK,
  join(DSH_HOME, 'playground', 'themes', 'dsh-guava-pack'),
  join(process.env.HOME || '', 'dsh-guava-pack'),
].filter(Boolean);
const resolvedPack = packCandidates.find((p) => existsSync(join(p, 'services', 'commandcode-bridge')));
if (resolvedPack) {
  const same = resolve(resolvedPack) === resolve(PACK_DIR);
  if (same) ok('pack', `运行中的 pack = ${PACK_DIR}`);
  else warn('pack', `正在体检的 pack (${PACK_DIR}) 与启动器会用的 pack (${resolvedPack}) 不一致`,
    `设 DSH_GUAVA_PACK=${PACK_DIR} 并同步启动器，否则"改了没生效"`);
} else {
  fail('pack', `没有任何候选路径像 dsh-guava-pack（试过：${packCandidates.join(' / ')}）`,
    '把 pack 放到 $DSH_HOME/playground/themes/dsh-guava-pack，或设 DSH_GUAVA_PACK');
}

/* ── 3. node_modules 补丁（被 pnpm install 覆盖就 400）───────────────── */

const patchCheck = run(process.execPath, [join(PACK_DIR, 'install.mjs'), '--check']);
if (patchCheck.code === 0) {
  ok('patches', 'node_modules 补丁已打，包完整性通过');
} else {
  fail('patches', 'install.mjs --check 未通过（补丁缺失或包不完整）',
    `node ${join(PACK_DIR, 'install.mjs')} --patch   # 幂等，打完重试`);
}

/* ── 4. 服务与端口 ────────────────────────────────────────────────────── */

const [router, bridge, web] = await Promise.all([
  probeHttp('http://127.0.0.1:8318/health'),
  probeHttp('http://127.0.0.1:8317/health'),
  probeHttp('http://127.0.0.1:3080/'),
]);
if (router.ok) ok('service', `provider-router 8318 → ${router.body}`);
else warn('service', `provider-router 8318 无响应（${router.body}）`,
  `${join(PACK_DIR, 'plugins/provider-router/start.sh')}`);

if (bridge.ok) ok('service', `commandcode-bridge 8317 → ${bridge.body}`);
else warn('service', `commandcode-bridge 8317 无响应（${bridge.body}）`,
  `${join(PACK_DIR, 'services/commandcode-bridge/start.sh')}`);

if (web.status === 200 || web.status === 401) ok('service', `DSH web 3080（HTTP ${web.status}，401=需要 token，正常）`);
else warn('service', `DSH web 3080 响应异常（HTTP ${web.status}）`, 'systemctl --user status dsh.service');

/* ── 5. mode.json 三方共用 + 可写 ─────────────────────────────────────── */

const modeFile = process.env.DSH_ROUTER_MODE_FILE
  || join(DSH_HOME, 'playground', 'themes', 'provider-router', 'mode.json');
if (existsSync(modeFile)) {
  try {
    accessSync(modeFile, fsConstants.W_OK);
    const parsed = JSON.parse(readFileSync(modeFile, 'utf8'));
    ok('mode', `mode.json 可写：${modeFile}（${Object.keys(parsed).length} 家）`);
  } catch (err) {
    warn('mode', `mode.json 存在但不可写或无法解析：${err.message}`,
      '检查文件权限；面板开关切换不生效通常是这里');
  }
} else {
  warn('mode', `mode.json 不存在：${modeFile}`,
    '面板里切换一次 direct/ssr 会自动生成；缺失时一切默认 direct');
}

/* ── 6. provider key 可得性（只报有没有，绝不打印值）──────────────────── */

const NEEDED_KEYS = ['COMMANDCODE_API_KEY', 'AGENTROUTER_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'DEEPSEEK_API_KEY'];
const fromEnv = new Set(NEEDED_KEYS.filter((k) => process.env[k]));
const fromBashrc = new Set();
try {
  const rc = readFileSync(join(process.env.HOME || '', '.bashrc'), 'utf8');
  for (const k of NEEDED_KEYS) {
    if (new RegExp(`^export ${k}=`, 'm').test(rc)) fromBashrc.add(k);
  }
} catch { /* 没 .bashrc 就算了 */ }
const missing = NEEDED_KEYS.filter((k) => !fromEnv.has(k) && !fromBashrc.has(k));
if (missing.length === 0) ok('keys', `${NEEDED_KEYS.length} 个 provider key 都能取到（env 或 ~/.bashrc）`);
else if (missing.length === NEEDED_KEYS.length) {
  warn('keys', '环境里一个 provider key 都没有（可能都在 DSH 凭证库里）',
    '独立进程（桥接 / 定时任务）需要 key 在 env 或 .bashrc；启动器会从凭证库导出');
} else {
  warn('keys', `这些 key 在 env 与 .bashrc 都找不到：${missing.join(', ')}`,
    '写进 ~/.bashrc 或 DSH 凭证库；否则桥接/定时任务相关供应商不可用');
}

/* ── 7. 引用完整性 + 被引用模型可用性 ─────────────────────────────────── */

const refs = run(process.execPath, [join(PACK_DIR, 'tools', 'sync-model-policy.mjs'), '--check-refs']);
const refsOut = refs.out.trim();
if (refs.code === 0) {
  ok('models', '被引用的模型全部有定义且可用（--check-refs 通过）');
} else if (refs.code === 2) {
  fail('models', '存在悬空引用（provider::model 没有定义）', refsOut.split('\n').filter((l) => l.includes('❌')).join(' ; '));
} else if (refs.code === 3) {
  fail('models', '被引用的模型确认不可用（下线/限流/不支持工具）',
    '在 设置 → 模型 里换掉；详见 node tools/sync-model-policy.mjs --check-refs');
} else {
  warn('models', `--check-refs 退出码 ${refs.code}`, refsOut.split('\n').slice(-3).join(' ; '));
}

/* ── 8. 搜索后端接线（官方 ↔ Tavily 一键切换）────────────────────────── */

try {
  const { loadYaml } = await import('./lib/yaml.mjs');
  const yaml = await loadYaml();
  const patchFile = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
  const doc = yaml.load(readFileSync(patchFile, 'utf8'));
  const webEntry = (Array.isArray(doc) ? doc : []).find((e) => e?.id === 'web');
  const pinned = webEntry?.config?.searchProvider;
  if (pinned === 'switch') {
    ok('search', 'web.searchProvider = switch（可在 设置 → 搜索后端 里切官方/Tavily）');
  } else if (pinned === undefined) {
    warn('search', 'web.searchProvider 未钉住 → base 默认用 deepseek-official，切换插件不会生效',
      `在 ${patchFile} 加：- id: web / config: { searchProvider: switch, fetchProvider: http }`);
  } else {
    warn('search', `web.searchProvider = ${pinned}（不是 switch）→ 搜索后端切换不生效`, '改成 switch 后重启 DSH');
  }
  const preferFile = join(DSH_HOME, 'storages', 'web-search-switch.json');
  if (existsSync(preferFile)) {
    try {
      const backend = JSON.parse(readFileSync(preferFile, 'utf8'))?.backend;
      ok('search', `当前偏好后端：${backend}（${preferFile}）`);
      if (backend === 'tavily' && !process.env.TAVILY_API_KEY) {
        warn('search', '偏好是 Tavily 但环境里没有 TAVILY_API_KEY',
          '写进 ~/.bashrc 或 DSH 凭证库；否则每次搜索都会报 CREDENTIAL_MISSING');
      }
    } catch {
      warn('search', '偏好文件存在但解析不了（搜索会回落 official）', preferFile);
    }
  } else {
    info('search', '还没有偏好文件 → 搜索走 official（切换一次就会生成）');
  }
} catch (err) {
  warn('search', `读不到搜索后端配置：${String(err?.message ?? err)}`, '');
}

/* ── 输出 ─────────────────────────────────────────────────────────────── */

const failures = results.filter((r) => r.level === 'fail');
const warnings = results.filter((r) => r.level === 'warn');

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: results.filter((r) => r.level === 'ok'), warn: warnings, fail: failures }, null, 2));
} else {
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ' };
  const label = { runtime: '运行环境', pack: 'pack 位置', patches: '依赖补丁', service: '本地服务',
    mode: '路由模式', keys: '凭证', models: '模型引用', search: '搜索后端' };
  let area = null;
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n── ${label[area] ?? area} ──`); }
    console.log(`  ${icon[r.level]} ${r.msg}`);
    if (r.fix) console.log(`       ↳ ${r.fix}`);
  }
  console.log();
  if (failures.length === 0 && warnings.length === 0) {
    console.log('  🎉 全部通过：这套规则书当前是"能跑"的状态');
  } else if (failures.length === 0) {
    console.log(`  ✅ 无致命问题（${warnings.length} 条告警）`);
  } else {
    console.log(`  ❌ ${failures.length} 个致命问题 + ${warnings.length} 条告警（按上面 ↳ 处理）`);
  }
}

process.exit(failures.length > 0 ? 1 : warnings.length > 0 ? 2 : 0);
