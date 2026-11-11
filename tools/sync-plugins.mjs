#!/usr/bin/env node
/**
 * dsh-guava-pack/tools/sync-plugins.mjs — 把工作副本单向同步进 pack。
 *
 * 为什么需要：插件有两份 —— 工作副本（本机在跑的那份）与 pack 里的分发副本。
 * 两边会漂移，这个脚本把 pack 对齐到工作副本的**当前状态**（永远同步到最新）。
 *
 * 规则：
 *   · 按 package.json 的 name 配对，不按目录名（如 theme-manager → dsh-theme-manager）。
 *   · 只增改、不删除：pack 独有文件（LICENSE、providers.example.json）一律保留。
 *   · 以 pack 自己的 .gitignore 为准，绝不同步运行态与备份
 *     （router.log、mode.json、router.pid、*.bak-*、captures/…）。
 *   · pack 里有、工作副本已没有的 → 跳过并报告，**不删**（之前被删掉的就不用管了）。
 *   · 工作副本有、pack 里没有的 → 只报告；要纳入得改 cordis.patch.yml + install.mjs。
 *
 * 方向：默认「工作副本 -> pack」。加了 --from-pack 就反过来（pack -> 工作副本），
 * 用于把分发副本里领先的实现回收进工作副本（本机就是这样：pack 更新了 6 个插件，
 * 工作副本还停在旧版，此时按默认方向跑会用旧的覆盖新的）。
 *
 * 保护：任何**目标侧比源侧更新**的文件都会跳过并点名（--force 才覆盖）。
 * 这条是踩出来的 —— 曾经用旧的工作副本把 pack 里 2228 行新代码覆盖掉，
 * 事后只能 git checkout 回滚。
 *
 * 用法（在 pack 目录下）：
 *   node tools/sync-plugins.mjs --dry-run               # 只看会改什么
 *   node tools/sync-plugins.mjs                         # 真同步（工作副本 -> pack）
 *   node tools/sync-plugins.mjs --from-pack              # 反向（pack -> 工作副本）
 *   node tools/sync-plugins.mjs --from <dir>             # 指定工作副本根目录
 *   node tools/sync-plugins.mjs --force                  # 忽略「目标侧更新」保护
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
/** 反向同步：pack -> 工作副本。 */
const REVERSE = argv.includes('--from-pack');
/** 忽略「目标侧更新」保护。 */
const FORCE = argv.includes('--force');
/** 被保护挡下的文件（目标侧 mtime 更新），跑完统一汇报。 */
const AHEAD = [];
const fromFlag = argv.indexOf('--from');
const FROM = fromFlag >= 0 && argv[fromFlag + 1] ? argv[fromFlag + 1] : join(PACK, '..');

/** 永不镜像的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

const ok = (m) => console.log(`  \u2705 ${m}`);
const skip = (m) => console.log(`  \u23ed\ufe0f  ${m}`);
const warn = (m) => console.log(`  \u26a0\ufe0f  ${m}`);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 递归列出相对文件路径（跳过 SKIP_DIRS）。 */
function walk(root, base = root, out = []) {
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    if (isDir(full)) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

/**
 * 读 pack 自己的 .gitignore，作为"绝不同步"的权威清单 —— 它是这个包
 * 「什么不该进版本库」的唯一真相，同步逻辑不该另立一套。
 */
function loadIgnorePatterns() {
  const file = join(PACK, '.gitignore');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const body = (negated ? line.slice(1) : line).replace(/^\/+/, '');
      const isDir = body.endsWith('/');
      const core = body.replace(/\/+$/, '');
      const esc = core
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*');
      return { negated, re: isDir ? new RegExp(`(^|/)${esc}(/|$)`) : new RegExp(`(^|/)${esc}$`) };
    });
}

const IGNORE = loadIgnorePatterns();

/** 另外永远不同步的：备份文件、依赖、git 元数据。 */
const BUILTIN = [/\.bak(-|$)/, /(^|\/)node_modules\//, /(^|\/)\.git\//];

/** rel 是相对 pack 根目录的路径。 */
function ignored(rel) {
  let hit = false;
  for (const { negated, re } of IGNORE) if (re.test(rel)) hit = !negated;
  return hit || BUILTIN.some((re) => re.test(rel));
}

/**
 * 镜像一个目录：**只复制新增/变更，绝不删除**。
 *
 * 为什么不做删除：pack 里有些文件是工作副本里没有、但分发必须的
 * （LICENSE、providers.example.json），删了会静默破坏安装流程。
 * 目标独有的一律保留并报告。
 */
function mirror(src, dst, packRel) {
  const all = walk(src);
  const srcFiles = all.filter((rel) => !ignored(join(packRel, rel)));
  const skipped = all.filter((rel) => ignored(join(packRel, rel)));
  const srcSet = new Set(srcFiles);
  const dstFiles = existsSync(dst) ? walk(dst).filter((rel) => !ignored(join(packRel, rel))) : [];

  const added = [];
  const changed = [];
  for (const rel of srcFiles) {
    const target = join(dst, rel);
    if (!existsSync(target)) {
      added.push(rel);
      continue;
    }
    if (readFileSync(join(src, rel)).equals(readFileSync(target))) continue;
    // 目标侧更新 = 反向漂移。覆盖它会丢掉更新的那份（真实事故：-2228 行）。
    if (!FORCE && statSync(target).mtimeMs > statSync(join(src, rel)).mtimeMs) {
      AHEAD.push({ rel, target });
      continue;
    }
    changed.push(rel);
  }
  const kept = dstFiles.filter((rel) => !srcSet.has(rel));

  if (!DRY) {
    for (const rel of added.concat(changed)) {
      const target = join(dst, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(src, rel)));
    }
  }
  return { added, changed, kept, skipped };
}

/** 找 pack 里同名的插件目录（按 package.json 的 name 配对）。 */
function packPluginByName(name) {
  const root = join(PACK, 'plugins');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const pkg = readJson(join(root, dir, 'package.json'));
    if (pkg?.name === name) return join(root, dir);
  }
  return null;
}

function main() {
  if (REVERSE) return mainReverse();
  console.log(`dsh-guava-pack 插件同步${DRY ? '（dry-run）' : ''}\n`);
  console.log(`  工作副本根: ${FROM}`);
  console.log(`  pack:       ${PACK}\n`);

  if (!isDir(FROM)) {
    console.error(`工作副本根目录不存在：${FROM}`);
    return 1;
  }

  const packRoot = join(PACK, 'plugins');
  const packDirs = existsSync(packRoot) ? readdirSync(packRoot).filter((d) => isDir(join(packRoot, d))) : [];
  const packNames = new Map(); // package name -> dir
  for (const dir of packDirs) {
    const pkg = readJson(join(packRoot, dir, 'package.json'));
    if (pkg?.name) packNames.set(pkg.name, dir);
  }

  const matched = new Set();
  let synced = 0;
  let clean = 0;

  console.log('插件：');
  for (const dir of readdirSync(FROM)) {
    const src = join(FROM, dir);
    if (!isDir(src)) continue;
    if (src === PACK) continue; // 别把 pack 自己同步进自己
    const pkg = readJson(join(src, 'package.json'));
    if (!pkg?.dsh?.bundle?.patch) continue; // 不是可挂载的 bundle，跳过
    const targetDir = packPluginByName(pkg.name);
    if (!targetDir) {
      warn(`${pkg.name}：工作副本有，pack 里没有 —— 要纳入得改 cordis.patch.yml + install.mjs`);
      continue;
    }
    matched.add(relative(packRoot, targetDir));
    const packRel = join('plugins', relative(packRoot, targetDir));
    const diff = mirror(src, targetDir, packRel);
    const n = diff.added.length + diff.changed.length;
    if (n === 0) {
      clean++;
      console.log(`  = ${pkg.name}：已是最新`);
    } else {
      synced++;
      ok(`${pkg.name}：+${diff.added.length} ~${diff.changed.length}${DRY ? '（dry-run，未写）' : ''}`);
      for (const f of diff.added) console.log(`      + ${f}`);
      for (const f of diff.changed) console.log(`      ~ ${f}`);
    }
    if (diff.skipped.length > 0) console.log(`      跳过（.gitignore/备份）: ${diff.skipped.join(', ')}`);
    if (diff.kept.length > 0) console.log(`      保留 pack 独有: ${diff.kept.join(', ')}`);
  }

  // pack 里有、工作副本已没有的：报告但不删。
  const orphans = packDirs.filter((d) => !matched.has(d));
  if (orphans.length > 0) {
    console.log('\npack 里有、工作副本已没有（按约定跳过，不删）：');
    for (const d of orphans) skip(d);
  }

  // 服务（services/）按目录名配对。
  const svcRoot = join(PACK, 'services');
  if (existsSync(svcRoot)) {
    const svcDirs = readdirSync(svcRoot).filter((d) => isDir(join(svcRoot, d)));
    const pending = svcDirs.filter((d) => isDir(join(FROM, d)));
    if (pending.length > 0) {
      console.log('\n服务：');
      for (const d of pending) {
        const diff = mirror(join(FROM, d), join(svcRoot, d), join('services', d));
        const n = diff.added.length + diff.changed.length;
        if (n === 0) console.log(`  = ${d}：已是最新`);
        else {
          ok(`${d}：+${diff.added.length} ~${diff.changed.length}`);
          for (const f of diff.added) console.log(`      + ${f}`);
          for (const f of diff.changed) console.log(`      ~ ${f}`);
        }
        if (diff.skipped.length > 0) console.log(`      跳过（.gitignore/备份）: ${diff.skipped.join(', ')}`);
        if (diff.kept.length > 0) console.log(`      保留 pack 独有: ${diff.kept.join(', ')}`);
      }
    }
  }

  reportAhead();
  console.log(`\n结果：${synced} 个已同步、${clean} 个本来就一致${DRY ? '（dry-run）' : ''}`);
  if (!DRY && synced > 0) console.log('建议接着跑：node install.mjs --check');
  return 0;
}

/** 「目标侧更新」统一汇报：这些文件一个字都没写。 */
function reportAhead() {
  if (AHEAD.length === 0) return;
  console.log(`\n\u26a0\ufe0f  ${AHEAD.length} 个文件在目标侧更新，已跳过（疑似反向漂移）：`);
  for (const item of AHEAD) console.log(`      \u23eb ${relative(PACK, item.target) || item.target}`);
  console.log('      确认要覆盖就加 --force；否则先把方向搞对（--from-pack 是 pack -> 工作副本）。');
}

/** 反向：pack -> 工作副本。按 package.json 的 name 配对，只增改不删除。 */
function mainReverse() {
  console.log(`dsh-guava-pack 插件同步：pack -> 工作副本${DRY ? '（dry-run）' : ''}\n`);
  console.log(`  pack:       ${PACK}`);
  console.log(`  工作副本根: ${FROM}\n`);

  if (!isDir(FROM)) {
    console.error(`工作副本根目录不存在：${FROM}`);
    return 1;
  }

  // 工作副本根下按 package name 建索引（目录名可能与包名不同：theme-manager）
  const wsByName = new Map();
  for (const dir of readdirSync(FROM)) {
    const full = join(FROM, dir);
    if (!isDir(full) || full === PACK) continue;
    const pkg = readJson(join(full, 'package.json'));
    if (pkg?.name) wsByName.set(pkg.name, full);
  }

  const packRoot = join(PACK, 'plugins');
  const packDirs = existsSync(packRoot) ? readdirSync(packRoot).filter((d) => isDir(join(packRoot, d))) : [];

  let synced = 0;
  let clean = 0;
  let missing = 0;

  console.log('插件：');
  for (const dir of packDirs) {
    const src = join(packRoot, dir);
    const pkg = readJson(join(src, 'package.json'));
    if (pkg?.name === undefined) continue;
    const target = wsByName.get(pkg.name);
    if (target === undefined) {
      missing++;
      warn(`${pkg.name}：pack 有、工作副本没有 —— 跳过（不新建目录，改点只发生在已有镜像上）`);
      continue;
    }
    // packRel 仍按 pack 根算：.gitignore 里的跳过规则（router.log / mode.json / …）才对得上
    const diff = mirror(src, target, join('plugins', dir));
    const n = diff.added.length + diff.changed.length;
    if (n === 0) {
      clean++;
      console.log(`  = ${pkg.name}：已是最新`);
    } else {
      synced++;
      ok(`${pkg.name}：+${diff.added.length} ~${diff.changed.length}${DRY ? '（dry-run，未写）' : ''}`);
      for (const f of diff.added) console.log(`      + ${f}`);
      for (const f of diff.changed) console.log(`      ~ ${f}`);
    }
    if (diff.skipped.length > 0) console.log(`      跳过（.gitignore/备份）: ${diff.skipped.join(', ')}`);
    if (diff.kept.length > 0) console.log(`      保留工作副本独有: ${diff.kept.join(', ')}`);
  }

  const svcRoot = join(PACK, 'services');
  if (existsSync(svcRoot)) {
    const svcDirs = readdirSync(svcRoot).filter((d) => isDir(join(svcRoot, d)));
    const pending = svcDirs.filter((d) => isDir(join(FROM, d)));
    if (pending.length > 0) {
      console.log('\n服务：');
      for (const d of pending) {
        const diff = mirror(join(svcRoot, d), join(FROM, d), join('services', d));
        const n = diff.added.length + diff.changed.length;
        if (n === 0) console.log(`  = ${d}：已是最新`);
        else {
          ok(`${d}：+${diff.added.length} ~${diff.changed.length}`);
          for (const f of diff.added) console.log(`      + ${f}`);
          for (const f of diff.changed) console.log(`      ~ ${f}`);
        }
        if (diff.skipped.length > 0) console.log(`      跳过（.gitignore/备份）: ${diff.skipped.join(', ')}`);
        if (diff.kept.length > 0) console.log(`      保留工作副本独有: ${diff.kept.join(', ')}`);
      }
    }
  }

  reportAhead();
  console.log(`\n结果：${synced} 个已同步、${clean} 个本来就一致、${missing} 个无对应工作副本${DRY ? '（dry-run）' : ''}`);
  if (!DRY && synced > 0) console.log('工作副本变了 —— 记得在 ~/dsh 里提交。');
  return 0;
}

process.exit(main());
