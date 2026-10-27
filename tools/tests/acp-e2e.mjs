#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/tests/acp-e2e.mjs — P1/P4 端到端门禁（隔离 profile，不碰 live）。
 *
 * 做的事：
 *   1. 建一个临时 DSH_HOME + profile（bundles: base + web-app + dsh-context-acp）；
 *   2. 用 `--patch` 叠加一个测试驱动插件（tools/tests/lib/acp-driver.mjs）；
 *   3. 启动隔离 web 进程（--port 0，无浏览器），驱动插件在进程内创建挂了标准
 *      preset 的 Agent、种历史、执行真实工具、断言日志契约，然后写报告并退出；
 *   4. 本脚本校验报告。
 *
 * 为什么不用模型：agent 的 provider/model 指向不存在的路由；任何真实 LLM 调用都会
 * 让 compress 失败。compress 成功 = 摘要完全由工具投递、零额外模型调用。
 *
 * 用法：
 *   node tools/tests/acp-e2e.mjs                 # P1 级别（引擎 + compress + 屏障）
 *   node tools/tests/acp-e2e.mjs --strict        # P2/P4 级别（账本/恢复/检索/tier2 硬断言）
 *   node tools/tests/acp-e2e.mjs --keep          # 保留临时目录
 *
 * @module tools/tests/acp-e2e
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL_FILE = fileURLToPath(import.meta.url);
const PACK_DIR = dirname(dirname(dirname(TOOL_FILE)));
const PLUGIN_DIR = join(PACK_DIR, 'plugins', 'dsh-context-acp');
const DRIVER = join(PACK_DIR, 'tools', 'tests', 'lib', 'acp-driver.mjs');
const STRICT = process.argv.includes('--strict');
const KEEP = process.argv.includes('--keep');
// --rollback：生成器切 --backend basic → 隔离进程里验证回滚语义 → 恢复生成物。
const ROLLBACK = process.argv.includes('--rollback');

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
  const tried = [];
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      const require = createRequire(pathToFileURL(anchor).href);
      return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
    } catch (error) {
      tried.push(`${anchor} → ${error?.code ?? error}`);
    }
  }
  throw new Error(`找不到 @deepseek-ai/dsh：${tried.join('; ')}`);
}

function makeLab(scenario = 'full') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acp-e2e-'));
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
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const report = join(root, 'report.json');
  const overlay = join(root, 'overlay-driver.yml');
  writeFileSync(overlay, [
    '# 测试专用 overlay：挂载进程内 e2e 驱动（随报告退出进程）。',
    '- insert:',
    '    - id: acp-e2e-driver',
    `      name: ${pathToFileURL(DRIVER).href}`,
    '      config:',
    `        report: ${JSON.stringify(report)}`,
    `        cwd: ${JSON.stringify(work)}`,
    `        scenario: ${scenario}`,
    '',
  ].join('\n'), 'utf8');
  return { root, home, profileDir, work, report, overlay };
}

function runGenerator(args) {
  return spawnSync(process.execPath, [join(PACK_DIR, 'tools', 'gen-acp-preset.mjs'), ...args], {
    cwd: PACK_DIR,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function assertRollbackReport(report) {
  if (report.ok !== true) {
    fail('回滚驱动整体', report.error ? String(report.error).slice(0, 2000) : 'ok=false');
    return;
  }
  pass('回滚驱动整体 ok');
  const presets = report.steps?.find((step) => step.name === 'rollbackPresets')?.value ?? [];
  const tools = report.steps?.find((step) => step.name === 'rollbackTools')?.value ?? null;
  if (presets.length >= 4 && presets.every((item) => item.basicRows >= 1 && item.acpRows === 0)) {
    pass('回滚后 4 个 preset 都挂回内置 compaction-basic', `${presets.length} presets`);
  } else {
    fail('回滚 preset', JSON.stringify(presets));
  }
  if (Array.isArray(tools) && tools.length === 0) pass('回滚后根插件惰性（ACP 工具不注册）');
  else fail('回滚根插件', JSON.stringify(tools));
}

function runLab(bin, lab) {
  const result = spawnSync(process.execPath, [
    bin,
    '--profile', 'acp-lab',
    '--patch', lab.overlay,
    '--port', '0',
    '--no-open',
  ], {
    cwd: lab.root,
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      ...process.env,
      DSH_HOME: lab.home,
      // 测试钩子：nudge 判定需要「已用/窗口」压力；隔离进程里强制 88:100，
      // 这样不依赖真实模型 contextWindow。生产/正常启动不设该变量。
      DSH_ACP_TEST_PRESSURE: '88:100',
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function assertReport(report) {
  const get = (name) => report.steps?.find((step) => step.name === name)?.value;
  if (report.ok !== true) {
    fail('驱动整体', report.error ? String(report.error).slice(0, 3000) : 'ok=false');
    return;
  }
  pass('驱动整体 ok');

  const engine = get('engineConstructor');
  if (engine === 'AcpEngine') pass('preset realm 引擎 = AcpEngine');
  else fail('preset realm 引擎', String(engine));

  const compressed = get('compressResult');
  if (compressed?.ok === true) pass('compress 成功', `compactionId=${compressed.compactionId}`);
  else fail('compress', JSON.stringify(compressed));

  const blocked = get('protectedAttempt');
  if (blocked?.ok === false && blocked?.code === 'protected') pass('活动用户消息被拒绝（protected）', blocked.message);
  else fail('屏障 protected', JSON.stringify(blocked));

  const event = get('compactionEvent');
  if (event !== undefined && event.shadowedTokenCount > 0) pass('compaction/summary 账本字段完整', `shadowedTokens=${event.shadowedTokenCount}`);
  else fail('compaction/summary 事件', JSON.stringify(event));

  if (!STRICT) return;

  const drop = get('pressureDrop');
  if (typeof drop?.before === 'number' && typeof drop?.after === 'number' && drop.after < drop.before) pass('compress 后上下文压力下降', `${drop.before} -> ${drop.after}`);
  else fail('压力下降', JSON.stringify(drop));

  const status = report.status;
  if (status?.ok === true && (status.blocks?.length ?? 0) >= 1) pass('acp_status 账本有块', `blocks=${status.blocks.length}`);
  else fail('acp_status 账本', JSON.stringify(status)?.slice(0, 600));

  const tier2 = report.tier2;
  if (tier2?.tier === 2) pass('二次压缩 checkpoint = tier 2', `compactionId=${tier2.compactionId}`);
  else fail('tier 2', JSON.stringify(tier2));

  const nudge = get('nudge');
  const auto = get('autoCompaction');
  if (nudge?.injected === 1 && auto?.before === auto?.after) pass('nudge 注入且不自动压', nudge.text?.slice(0, 40));
  else fail('nudge / 不自动压', JSON.stringify({ nudge, auto }));

  if (get('compactIfNeededPressure') === 'null') pass('compactIfNeeded(pressure) 返回 null');
  else fail('compactIfNeeded(pressure)', JSON.stringify(get('compactIfNeededPressure')));

  const instr = get('instructionsBarrier');
  if (instr?.code === 'protected' && String(instr?.message ?? '').includes('protected-agent-instructions')) pass('AGENTS.md 当前副本被拒');
  else fail('AGENTS.md 屏障', JSON.stringify(instr)?.slice(0, 500));

  const skill = get('skillBarrier');
  if (skill?.code === 'protected' && String(skill?.message ?? '').includes('protected-skill-catalog')) pass('skill 目录最新副本被拒');
  else fail('skill 目录屏障', JSON.stringify(skill)?.slice(0, 500));

  const decompress = report.decompress;
  const decompressedText = JSON.stringify(decompress ?? {});
  // b1 覆盖被压的第 2..4 条消息；E_MIGRATE_LOCKED 只出现在被压原文里（ORCHID-11 在第 1 条，未压）。
  if (decompress?.ok === true && decompressedText.includes('E_MIGRATE_LOCKED')) pass('decompress 取回原文', `total=${decompress.total}`);
  else fail('decompress', decompressedText.slice(0, 800));

  const search = report.search;
  if (search?.ok === true && (search.hits?.length ?? 0) >= 1) pass('search_context 命中被压内容', `hits=${search.hits.length}`);
  else fail('search_context', JSON.stringify(search)?.slice(0, 800));
}

const started = Date.now();
let lab;
try {
  const bin = resolveDshBin();

  if (ROLLBACK) {
    // 回滚验收：用生成器把 preset 与 runtime.json 一起切到 basic（这是文档里的
    // 唯一回滚入口），在隔离进程里验证，然后无论成败都恢复 acp 生成物。
    const toBasic = runGenerator(['--write', '--backend', 'basic']);
    if (toBasic.status !== 0) throw new Error(`生成器切 basic 失败：${toBasic.stdout}${toBasic.stderr}`);
    lab = makeLab('rollback');
    console.log(`\n[acp-e2e] dsh bin = ${bin}`);
    console.log(`[acp-e2e] 隔离 DSH_HOME = ${lab.home}（rollback → backend=basic）\n`);
    const result = runLab(bin, lab);
    if (!existsSync(lab.report)) fail('回滚驱动报告', `进程没写出报告（status=${result.status}）\nstderr:\n${result.stderr.slice(-3000)}`);
    else assertRollbackReport(JSON.parse(readFileSync(lab.report, 'utf8')));
  } else {
    lab = makeLab('full');
    console.log(`\n[acp-e2e] dsh bin = ${bin}`);
    console.log(`[acp-e2e] 隔离 DSH_HOME = ${lab.home}${STRICT ? '（strict）' : ''}\n`);
    const result = runLab(bin, lab);
  if (!existsSync(lab.report)) {
    fail('驱动报告', `进程没写出报告（status=${result.status}）\nstderr tail:\n${result.stderr.slice(-4000)}`);
  } else {
    const report = JSON.parse(readFileSync(lab.report, 'utf8'));
    for (const item of report.steps ?? []) {
      if (!item.name?.startsWith?.('assert')) console.log(`  · ${item.name}: ${JSON.stringify(item.value ?? '').slice(0, 300)}`);
    }
    assertReport(report);
  }
}
} catch (error) {
  fail('测试框架', String(error?.stack ?? error));
} finally {
  if (ROLLBACK) {
    // 恢复 acp 生成物（无论本次验收成败），再确认 --check 干净。
    const restore = runGenerator(['--write']);
    if (restore.status === 0) {
      const check = runGenerator(['--check']);
      if (check.status === 0) pass('回滚验收后已恢复 acp 生成物（--check 干净）');
      else fail('恢复后 --check', `${check.stdout}${check.stderr}`);
    } else {
      fail('恢复生成物', `${restore.stdout}${restore.stderr}`);
    }
  }
  if (lab !== undefined && !KEEP) {
    try {
      rmSync(lab.root, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  } else if (lab !== undefined) {
    console.log(`\n[acp-e2e] 保留临时目录：${lab.root}`);
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n[acp-e2e] ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} in ${elapsed}s`);
process.exit(failures.length === 0 ? 0 : 1);
