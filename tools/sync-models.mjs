#!/usr/bin/env node
/**
 * sync-models.mjs — 让 DSH 的模型列表跟上服务商端。
 *
 * ## 为什么需要它
 *
 * DSH 的可选模型来自 profile 里**静态声明**的 `models:` 数组
 * （`dsh-llm-pi-ai` 的 `listModels()` 读的是编译后的配置，不查端点）。
 * 而各家 `/models` 是随时变的：commandcode 的免费模型换了一茬、
 * antigravity 反代已经提供 29 个而配置里只声明了 10 个、还有 3 个已下线。
 *
 * 两个松绑让「同步」成为可行方案：
 *   1. `llm` 服务文档明确：**Catalog membership does not constrain core routing**
 *      ——没列出的 id 照样能调用，列表只影响 UI 里选不选得到。
 *   2. profile 的用户 patch 层是**热重载**的（dsh-app-boot:486
 *      "The user patch layer inside a profile directory (hot-reloaded on
 *      long-lived surfaces)"）——改完配置**不用重启 DSH**。
 *
 * ## 设计要点
 *
 * - **合并，不是替换**：已存在的模型保留它原来的整段 YAML（人工写的
 *   contextWindow / maxTokens / reasoningEfforts / compat 都不丢），
 *   只新增端点有而配置没有的。
 * - **默认绝不删模型**：这点是实测逼出来的。antigravity 反代上
 *   `gemini-2.5-flash` 已不在 /models 里，但调用它**仍然成功**，服务端
 *   静默别名到 `gemini-3.1-flash-lite`；`claude-opus-4-6` → `-thinking`
 *   同理。说明「端点没列」≠「不能用」。所以要删得显式加 `--prune`。
 * - **只动 `models:` 块**：纯文本手术，不重排你的文件、不动注释与其它字段。
 * - **默认 dry-run**：不加 `--write` 就只打印 diff，绝不落盘。
 * - 落盘前自动备份（`cordis.patch.yml.bak-modelsync-<时间戳>`）。
 *
 * ## 用法
 *
 *   node tools/sync-models.mjs                    # 预览（默认，不改文件）
 *   node tools/sync-models.mjs --write             # 落盘
 *   node tools/sync-models.mjs --free-only         # 只要 id 含 free 的
 *   node tools/sync-models.mjs --exclude "tts|asr|embed"   # 排除非对话模型
 *   node tools/sync-models.mjs --prune --write     # 顺手删掉端点已无的（慎用）
 *   node tools/sync-models.mjs --only antigravity  # 只同步某一家
 *
 * ## 已知边界（诚实说明）
 *
 * - 端点只告诉「有哪些模型」，**不告诉**「免费额度还剩多少 / 每日上限」——
 *   那些在服务商条款里，同步器只能按 id 里的 `free` 标记判断是否免费。
 * - **端点列表 ≠ 可用列表**：旧 id 可能被服务端别名到新模型而继续可用
 *   （见上），所以默认不删。
 * - 「自动升级到新模型」这种事同步器查不到。实测 antigravity 的
 *   `gemini-3.5-flash` 直接返回 "Gemini 3.5 Flash is no longer…"，
 *   **并没有**自动连到 3.8 —— 官方说法和实际行为不一致，以实测为准。
 * - 新模型没有 endpoint 元数据时**按 id 家族**给兜底值（`gemini-*` → 1M/65536、
 *   `claude-*` → 200k/64k、`gpt-oss*` → 128k/32k 且纯文本、其余 200k/64k）。
 *   家族表是**启发式**，不是端点事实 —— 需要精确值请手工改，改过之后
 *   下次同步会**保留**你的值。
 * - 有意**不**自动生成 `reasoningEfforts`：它改变请求负载，跨协议容忍度未知；
 *   且档位已写在 id 后缀（`-low`/`-high`/…）的型号本来就不需要选择器。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 解析/渲染/家族兜底都从共享 lib 来 —— `sync-model-policy.mjs` 必须与这里
// 逐字节一致，否则同一个文件会被两个工具写出两种结果。**别在这里复制。**
import {
  IND,
  detectIndent,
  scanProviders,
  field,
  parseModels,
  modelsUrl,
  fetchModels,
  familyOf,
  humanize,
  isFree,
  renderModel,
  envFromBashrc,
  sp,
} from './lib/model-config.mjs';

const PACK_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WRITE = has('--write');
const FREE_ONLY = has('--free-only');
const PRUNE = has('--prune');
const ONLY = valueOf('--only');
const EXCLUDE = valueOf('--exclude') ? new RegExp(valueOf('--exclude')) : undefined;
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
const PROFILE = valueOf('--profile') || join(DSH_HOME, 'profiles', 'web');
const PATCH = join(PROFILE, 'cordis.patch.yml');
const TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS || 20000);

// ── 小工具 ───────────────────────────────────────────────────────────────

const ok = (m) => console.log(`  \u2705 ${m}`);
const bad = (m) => console.log(`  \u274c ${m}`);
const info = (m) => console.log(`  \u2139\ufe0f  ${m}`);


// ── 主流程 ───────────────────────────────────────────────────────────────

async function main() {
  console.log('sync-models — 让 DSH 模型列表跟上服务商端');
  console.log(`  profile : ${PROFILE}`);
  console.log(`  模式    : ${WRITE ? '写入' : '预览（dry-run，加 --write 才落盘）'}${FREE_ONLY ? ' + 仅免费' : ''}${PRUNE ? ' + 删除端点已无的' : ' + 不删除'}${EXCLUDE ? ` + 排除 /${EXCLUDE.source}/` : ''}${ONLY ? ` + 只同步 ${ONLY}` : ''}`);
  console.log();

  if (!existsSync(PATCH)) { bad(`找不到 ${PATCH}`); process.exit(1); }

  const original = readFileSync(PATCH, 'utf8');
  const lines = original.split('\n');
  detectIndent(lines);
  const providers = scanProviders(lines);
  if (providers.length === 0) { bad('没在 patch 里找到 providers 块'); process.exit(1); }
  info(`探测到缩进：providers=${IND.providers} 名称=${IND.name} 字段=${IND.field} 模型=${IND.model}`);

  // 从后往前替换，避免下标漂移
  const edits = [];
  let failures = 0;
  let changedProviders = 0;

  for (const p of providers) {
    if (ONLY && p.name !== ONLY) continue;
    const api = field(p.body, 'api');
    const baseURL = field(p.body, 'baseURL');
    const apiKeyEnv = field(p.body, 'apiKeyEnv');
    const { headerIdx, models: existing, tail } = parseModels(p.body);

    if (!baseURL) { info(`${p.name}: 没声明 baseURL（走 pi-ai 内置目录），跳过`); continue; }
    if (headerIdx === -1) { info(`${p.name}: 没声明 models，跳过`); continue; }

    const url = modelsUrl(baseURL, api);
    let remote;
    try {
      remote = await fetchModels(url, apiKeyEnv ? envFromBashrc(apiKeyEnv) : undefined, api, TIMEOUT_MS);
    } catch (err) {
      bad(`${p.name}: 查询 ${url} 失败 —— ${err.message}`);
      failures++;
      continue;
    }
    if (remote.length === 0) { info(`${p.name}: 端点没返回模型，跳过`); continue; }

    let candidates = remote;
    if (EXCLUDE) candidates = candidates.filter((m) => !EXCLUDE.test(m.id));
    if (FREE_ONLY) {
      const free = candidates.filter((m) => isFree(m.id));
      // --free-only 的语义是「只碰有免费模型的供应商」：没有就整家跳过，
      // 而不是退回全量 —— 否则会把一堆付费/非对话模型塞进列表，违背意图。
      if (free.length === 0) { info(`${p.name}: 无免费模型，跳过（--free-only）`); continue; }
      candidates = free;
    }

    const existingById = new Map(existing.map((m) => [m.id, m]));
    const candidateIds = new Set(candidates.map((m) => m.id));
    const added = candidates.filter((m) => !existingById.has(m.id));
    // 端点已不再列出 —— 但**不等于不能用**（可能被服务端别名，见文件头说明）
    const missing = existing.filter((m) => !candidateIds.has(m.id));

    const freeCount = candidates.filter((m) => isFree(m.id)).length;
    console.log(`  ${p.name}  (${api || 'api?'})  →  ${url}`);
    console.log(`    端点 ${remote.length} 个${freeCount ? `（筛后 ${candidates.length}，其中 ${freeCount} 个免费）` : ''} | 配置原有 ${existing.length} 个`);
    if (added.length) { console.log(`    + 新增 ${added.length}:`); for (const m of added) console.log(`        ${isFree(m.id) ? '🆓' : '  '} ${m.id}`); }
    if (missing.length) {
      console.log(`    ~ 端点已不列出 ${missing.length}${PRUNE ? '（将移除）' : '（**保留**，可能仍是有效别名）'}:`);
      for (const m of missing) console.log(`        ${m.id}`);
    }
    if (!added.length && !(PRUNE && missing.length)) console.log('    = 无需变更');

    if (!added.length && !(PRUNE && missing.length)) continue;

    // 保留原有顺序（UI 里不跳位），新模型追加在后
    const keptExisting = existing.filter((m) => !PRUNE || candidateIds.has(m.id));
    const newOnes = candidates.filter((m) => !existingById.has(m.id));
    const newModelLines = [
      ...keptExisting.flatMap((m) => m.lines),
      ...newOnes.flatMap((m) => renderModel(m)),
    ];
    const before = p.body.slice(0, headerIdx + 1);
    // `tail` 是本 provider 在 `models:` **之后**声明的其它字段（如 opencode 的
    // baseURL）——必须原样跟回来，否则它们会被挤到新增模型前面。
    edits.push({ start: p.start, end: p.end, lines: [...before, ...newModelLines, ...tail] });
    changedProviders++;
  }

  console.log();
  if (changedProviders === 0) {
    ok('没有任何变化，文件不用动');
    return;
  }
  if (failures) info(`${failures} 家查询失败，已跳过（不会误删它们的模型）`);

  if (!WRITE) {
    info(`预览结束：${changedProviders} 家需要更新。加 --write 落盘。`);
    return;
  }

  // 从后往前替换
  const out = lines.slice();
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out.splice(e.start, e.end - e.start, ...e.lines);
  }
  const backup = `${PATCH}.bak-modelsync-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  copyFileSync(PATCH, backup);
  writeFileSync(PATCH, out.join('\n'), 'utf8');
  ok(`已写入 ${changedProviders} 家`);
  ok(`备份：${backup}`);
  info('profile patch 是热重载的 —— 刷新页面即可看到新列表，通常不用重启 DSH');
  info('若没生效再重启：systemctl --user restart dsh.service');
}

main().catch((err) => { bad(err.stack || String(err)); process.exit(1); });
