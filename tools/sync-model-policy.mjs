#!/usr/bin/env node
/**
 * sync-model-policy.mjs — 按 `config/model-policy.yml` 的**意图**把 profile 的模型列表
 * 收敛到目标清单。
 *
 * ## 与 sync-models.mjs 的分工
 *
 *   · `sync-models.mjs`       —— 只"补端点新增的"，**默认一个都不删**（保守、无偏好）
 *   · `sync-model-policy.mjs` —— 按策略**增删到目标清单**（激进，但意图明确、可复现）
 *
 * 两者共用 `tools/lib/model-config.mjs` 的解析/渲染/家族兜底，所以对同一份文件
 * 不会写出两种格式的结果。
 *
 * ## 为什么需要这份脚本（诚实说明）
 *
 * 实测 6 家 `/models` **都只回 id/name/created/context，没有任何能力字段**，而且
 * `created` 是**假时间戳**（agentrouter 全 1626777600）。所以：
 *   - "最新" 只能按 id 里的**版本号**启发式判断，不是真实发布时间；
 *   - "视觉" 只能按 id 关键词推断（`vision_hints`）；
 *   - "旗舰 / 最好的五个" **完全无法自动判断** —— antigravity 那份是**人工点名**的。
 *
 * 因此本脚本的定位是"**忠实执行你写在策略表里的意图**"，而不是"替你做审美判断"。
 *
 * ## 硬保护：被引用的模型永不删
 *
 * `agent-default-model` 与 `subagent-model-selection-settings.allowedModels` 引用的
 * `provider::model` 一律保留，即使策略说不要。本机 `agent-default-model` 现在指着
 * `commandcode::stealth/glyph-cluster:free`（一个免费模型）—— 扫描器很容易把它当"不要的"
 * 删掉，然后主 agent 就没有默认模型了。这类破坏是静默的，所以做成硬保护。
 *
 * ## 用法
 *
 *   node tools/sync-model-policy.mjs                    # 预览（默认 dry-run）
 *   node tools/sync-model-policy.mjs --write            # 落盘（先备份）
 *   node tools/sync-model-policy.mjs --only xiaomi-token-plan-cn
 *   node tools/sync-model-policy.mjs --check-refs       # 只查引用完整性
 *   node tools/sync-model-policy.mjs --policy config/model-policy.yml
 *   node tools/sync-model-policy.mjs --profile <dir>
 *
 * 退出码：0 正常（含"没有变化"）/ 1 出错 / 2 `--check-refs` 发现悬空引用
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from '/home/guava5tar_/dsh/node_modules/js-yaml/dist/js-yaml.mjs';

import {
  probeMany,
  loadCache,
  saveCache,
  cachedKind,
  kindLabel,
  KIND,
} from './lib/probe.mjs';

import {
  detectIndent,
  scanProviders,
  field,
  parseModels,
  modelsUrl,
  fetchModels,
  renderModel,
  familyOf,
  isFree,
  bareId,
  effortsFor,
  collectModelRefs,
  envFromBashrc,
  sp,
  IND,
} from './lib/model-config.mjs';

const PACK_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WRITE = has('--write');
const CHECK_REFS = has('--check-refs');
const PROBE = has('--probe');
const ONLY = valueOf('--only');
const POLICY_PATH = resolve(valueOf('--policy') || join(PACK_DIR, 'config', 'model-policy.yml'));
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
const PROFILE = valueOf('--profile') || join(DSH_HOME, 'profiles', 'web');
const PATCH = join(PROFILE, 'cordis.patch.yml');
const TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS || 20000);

const ok = (m) => console.log(`  \u2705 ${m}`);
const bad = (m) => console.log(`  \u274c ${m}`);
const info = (m) => console.log(`  \u2139\ufe0f  ${m}`);
const warn = (m) => console.log(`  \u26a0\ufe0f  ${m}`);

// ── 版本号抽取与比较（"最新"的唯一可行判据）────────────────────────────────

/**
 * 从 id 里抽版本号数组。
 *
 * 实测端点不给真实发布时间（`created` 是假的），所以只能读 id：
 *   `gemini-3.8-flash-high`   → [3, 8]
 *   `deepseek-v4.1-flash`     → [4, 1]
 *   `claude-opus-4-6`         → [4, 6]   （连字符数字 = 多段版本）
 *   `mimo-v2.6-pro`           → [2, 6]
 *   `qwen3.8-max`             → [3, 8]
 *   `step-5-preview-free`     → [5]
 *
 * 抓不到版本号时返回 `[]`（排序时视为最旧，但会被 family/关键字规则列为候选）。
 */
export function versionOf(id) {
  const bare = bareId(id);
  // 1) 显式 v 前缀
  let m = bare.match(/v(\d+(?:\.\d+)*)/i);
  if (m) return m[1].split('.').map(Number);
  // 2) 紧跟字母后的数字：qwen3.8 / gpt-5.6 / hy4 / ling-3.1
  m = bare.match(/[a-z](\d+(?:\.\d+)*)/i);
  if (m) return m[1].split('.').map(Number);
  // 3) 纯数字段（含连字符分段）：claude-opus-4-6 → 用所有数字段
  const nums = [...bare.matchAll(/(\d+)/g)].map((x) => Number(x[1]));
  if (nums.length) return nums;
  return [];
}

/** 版本号比较：a 比 b 新 → >0。逐段数值比较。 */
export function compareVersion(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 判断一个模型是否支持视觉。
 *
 * **优先读现有条目里人工写的 `input:`** —— 那是真数据（`input: [text, image]`），
 * 比按 id 猜准得多。只有**新模型**（profile 里还没有）才退回到 id 关键词猜测。
 *
 * 踩过的坑：一开始只按 id 猜，于是 `mimo-v2.6-pro`（人工条目里明明写了 image）
 * 被判成"不带视觉"，触发了"旗舰没视觉就补一个"的错误分支。
 */
function looksVision(id, hints, existingById) {
  const prev = existingById?.get(id);
  if (prev) {
    const text = prev.lines.join('\n');
    const m = text.match(/^\s*input:\s*\n((?:\s*-\s*\w+\s*\n?)+)/m);
    if (m) return /\bimage\b/.test(m[1]);
  }
  const bare = bareId(id).toLowerCase();
  return hints.some((h) => bare.includes(h.toLowerCase()));
}

/**
 * 给已有模型的 `name:` 行套上用途后缀，形如 `Cat Jam（仅推理，不出正文）`。
 *
 * ## 为什么改 name 而不是加字段
 *
 * 模型选择器**只渲染 `model.name`**（实测 dsh-client-ui-model-selection：
 * 只用 `model.name` 做 label 与 title），而 pi-ai 的 modelFields 里**没有
 * description**。所以"这是特殊用途模型"只能写进 name。
 *
 * ## 幂等性
 *
 * 已有的 `（…）` / `(…)` 后缀会被**替换**而不是叠加，所以反复跑不会变成
 * `Cat Jam（仅推理）（仅推理）`。手工加的其它括号（如 `(Antigravity)`、
 * `(free)`）按 `stripOnly` 的规则决定保留还是替换 —— 默认只剥我们自己的标记。
 *
 * @param {string[]} lines - 该模型条目的原始 YAML 行
 * @param {string|null} tag - 要加的后缀文字；null = 不加
 * @param {RegExp} ownTagRe - 识别"我们自己加过的后缀"的正则
 * @returns {{lines: string[], changed: boolean, before?: string, after?: string}}
 */
export function annotateName(lines, tag, ownTagRe, stripList) {
  const idx = lines.findIndex((l) => /^\s*name:\s*/.test(l));
  if (idx < 0) return { lines, changed: false };
  const line = lines[idx];
  const m = line.match(/^(\s*name:\s*)(.*?)\s*$/);
  if (!m) return { lines, changed: false };
  const [, prefix, rawName] = m;
  // 先做"剥离"：把末尾的括号按规则去掉。要剥的包括
  //   ① 我们自己加过的标签（保证幂等）
  //   ② `strip` 里列出的（用户说 `(Antigravity)` / `(free)` 不用保留）
  const stripRes = (stripList ?? []).map((x) => { try { return new RegExp(x); } catch { return null; } }).filter(Boolean);
  let stripped = rawName;
  for (;;) {
    const bm = stripped.match(/^(.*?)\s*[（(]([^）)]*)[）)]\s*$/);
    if (!bm) break;
    const inner = bm[2];
    const drop = (ownTagRe && ownTagRe.test(inner)) || stripRes.some((re) => re.test(inner));
    if (!drop) break;             // 不认识的括号 → 留着（可能是用户想保留的）
    stripped = bm[1];
  }
  if (!tag) {
    if (stripped === rawName) return { lines, changed: false };
    const out0 = lines.slice();
    out0[idx] = `${prefix}${stripped}`;
    return { lines: out0, changed: true, before: rawName, after: stripped };
  }
  const next = `${prefix}${stripped}（${tag}）`;
  if (next === line) return { lines, changed: false, before: rawName, after: stripped };
  const out = lines.slice();
  out[idx] = next;
  return { lines: out, changed: true, before: rawName, after: `${stripped}（${tag}）` };
}

/** 按 annotations 表找出适用于某 id 的 tag（第一条匹配生效）。 */
export function tagFor(id, annotations, ownTagRe) {
  if (!Array.isArray(annotations)) return null;
  const bare = bareId(id);
  for (const a of annotations) {
    if (!a?.match) continue;
    let re;
    try { re = new RegExp(a.match); } catch { continue; }
    if (re.test(id) || re.test(bare)) return a.tag ?? null;
  }
  void ownTagRe;
  return null;
}

// ── 选型：把策略 + 端点候选算成目标 id 集合 ────────────────────────────────

/**
 * 对一家 provider 求目标 id 列表。
 *
 * @returns {{ids: string[], notes: string[]}} 目标 id（保持"旗舰在前"的稳定顺序）+ 说明
 */
export function solveProvider(providerName, rule, candidates, defaults, existingById, probeInfo) {
  const notes = [];
  const pick = rule.pick ?? {};
  const hints = rule.vision_hints ?? defaults.vision_hints ?? [];
  const excl = [];
  if (defaults.exclude) excl.push(new RegExp(defaults.exclude, defaults.exclude_flags ?? ''));
  for (const e of pick.exclude ?? []) excl.push(new RegExp(e));

  const usable = candidates.filter((m) => !excl.some((re) => re.test(m.id)));

  // 形态 A：人工点名（唯一能表达"最好的五个"的方式）
  if (Array.isArray(pick.explicit) && pick.explicit.length) {
    const have = new Set(candidates.map((m) => m.id));
    const chosen = [];
    for (const id of pick.explicit) {
      if (have.has(id)) chosen.push(id);
      else if ((pick.on_missing ?? 'keep') === 'keep') {
        chosen.push(id);
        notes.push(`点名的 \`${id}\` 端点没列出 → 按 on_missing:keep **保留**（可能被服务端别名）`);
      } else {
        notes.push(`点名的 \`${id}\` 端点没列出 → 按 on_missing:drop 移除`);
      }
    }
    return { ids: chosen, notes };
  }

  // 形态 B：family/most-recent 规则
  const chosen = [];
  const famRe = pick.family ? new RegExp(pick.family) : null;
  const famMatches = famRe ? usable.filter((m) => famRe.test(bareId(m.id))) : [];
  const byNewest = (arr) =>
    [...arr].sort((a, b) => {
      const c = compareVersion(versionOf(b.id), versionOf(a.id));
      return c !== 0 ? c : a.id.localeCompare(b.id); // 同版本按 id 稳定排序
    });

  // 免费模型的**额度优先序**：只靠端点拿不到额度（实测 `/models` 没有这些字段），
  // 数字来自策略表里的 `free_notices`（人工从供应商 UI 抄的）。
  // 排序规则：unlimited(0) → 有额度(1) → 未知(2) → 公告标了 priority: low(3)。
  // 目的：UI 选择器里第一个免费模型就是"最划算的那个"。
  const noticeOf = (id) => (rule.free_notices ?? []).find((n) => n.model === id);
  const freeRank = (id) => {
    const n = noticeOf(id);
    // 排序层级：top(-1) → 无上限(0) → 有额度(1) → 未知(2) → low(3)
    // `top` 是显式覆盖："这个综合能力最强，排第一"，比额度更能反映实际好用程度
    // （Beam 就是这种：额度未知，但 1M 上下文 + 会推理 + 正文正常）。
    if (n?.priority === 'top') return -1;
    if (!n) return 2;
    if (n.priority === 'low') return 3;
    const q = String(n.quota ?? '').toLowerCase();
    if (q === 'unlimited') return 0;
    if (q && q !== 'unknown') return 1;
    return 2;
  };
  const byFreeRank = (arr) =>
    [...arr].sort((a, b) => {
      const r = freeRank(a.id) - freeRank(b.id);
      if (r !== 0) return r;
      return compareVersion(versionOf(b.id), versionOf(a.id)) || a.id.localeCompare(b.id);
    });

  const takeMode = pick.take ?? 'all';

  if (famRe) {
    const sorted = byNewest(famMatches);
    if (sorted.length === 0) {
      notes.push(`family \`${pick.family}\` 在端点候选里没有匹配`);
    } else if (takeMode === 'latest') {
      // "旗舰"优先级：先在旗舰关键词里找最新的，找不到再用全体最新的
      const flags = pick.flagship ?? [];
      let pool = sorted;
      for (const f of flags) {
        const hit = sorted.filter((m) => bareId(m.id).toLowerCase().includes(f.toLowerCase()));
        if (hit.length) { pool = hit; break; }
      }
      const top = pool[0];
      chosen.push(top.id);
      notes.push(`family \`${pick.family}\` 取最新 = \`${top.id}\`（版本 ${JSON.stringify(versionOf(top.id))}）`);
      if (pick.flagship_only_if_vision && flags.length) {
        const hasVision = looksVision(top.id, hints, existingById);
        if (hasVision) {
          notes.push(`  旗舰带视觉 → 不再额外补视觉型号`);
        } else {
          const vis = byNewest(usable.filter((m) => looksVision(m.id, hints, existingById) && !chosen.includes(m.id)));
          if (vis.length) {
            chosen.push(vis[0].id);
            notes.push(`  旗舰**不带**视觉 → 额外补最新视觉型号 \`${vis[0].id}\``);
          } else {
            notes.push(`  旗舰不带视觉，但端点里没有可识别的视觉型号 → 只留旗舰`);
          }
        }
      }
    } else {
      chosen.push(...sorted.map((m) => m.id));
    }
  }

  // plus_free：额外保留免费模型（"除了 ds 只要免费"）
  //
  // 三种取值：
  //   'latest' → 只留最新的 1 个
  //   数字     → 留最新的 N 个
  //   'usable' → **留下所有探测过真能用的**（用户的"所有能连接能用的免费的"）
  //
  // `usable` 必须依赖真实探测结果，因为端点列表会撒谎（实测同一份列表里混着
  // "No endpoints found" / "已下线转付费" / "上游满载"）。
  if (pick.plus_free) {
    // 候选池 = 端点列出的免费 ∪ **配置里已有的免费**。
    //
    // 为什么必须并上后者：`sync-models` 早就踩过这个坑 ——
    // **「端点没列」≠「不能用」**（`gemini-2.5-flash` 被服务端静默别名到 3.1 而继续可用）。
    // 只按端点算的话，一个配置里正在用、只是被端点摘掉的免费模型会被**静默删掉**。
    // 用户明确要求"少删些"，所以已有的免费模型默认留着，除非探测确凿证明它坏了。
    //
    // （非免费的仍按 family 收敛 —— 那正是 "取最新的 ds" 的本意。）
    const freePool = [
      ...usable.filter((m) => isFree(m.id)),
      ...(existingById ? [...existingById.values()].filter((m) => isFree(m.id)) : []),
    ];
    const seenFree = new Set();
    const allFree = freePool.filter((m) => {
      if (chosen.includes(m.id) || seenFree.has(m.id)) return false;
      seenFree.add(m.id);
      return true;
    });
    const endpointListed = new Set(usable.map((m) => m.id));
    if (pick.plus_free === 'usable') {
      // **非对称判定**（用户在 2026-10-16 定的口径："opencode 保守一点，少删些"）：
      //
      //   · 已在配置里的免费模型 → 只有"确凿坏了"才剔除
      //     （死了 / 已下线 / 满载）。"需订阅""地区封锁"这类**保留** ——
      //     订阅可能今天买、地区限制可能绕过，但删掉就是白白丢掉。
      //   · **新**候选 → 必须探测为 `usable` 才加。否则只是往列表里塞噪音
      //     （比如 opencode 那 10 个全都"需订阅"，加进来一个也用不了）。
      //
      // 没有探测数据时一律放宽（宁可多留，也不静默丢掉可能能用的）。
      const DEFINITELY_BROKEN = new Set(['dead', 'no-funds']);
      const good = [], dropped = [], skippedNew = [];
      for (const m of allFree) {
        const kind = probeInfo ? cachedKind(probeInfo.cache, providerName, m.id) : undefined;
        const isExisting = existingById?.has(m.id) ?? false;
        if (kind === 'usable') { good.push(m); continue; }
        if (isExisting) {
          // 已配置的：**没探过也保留**（放宽），只有确凿坏了才剔。
          if (kind === undefined) { good.push(m); continue; }
          if (DEFINITELY_BROKEN.has(kind)) dropped.push({ id: m.id, kind });
          else good.push(m);   // 需订阅/地区/满载 → 保守保留
        } else {
          // **新**候选：必须证明自己能用才加。
          // 没探过也**不加** —— 否则会往列表里塞一堆连不通的噪音。
          // （踩过：`--probe` 之前没探到的新模型因"放宽"被加进来，
          //   实测全是 403"需订阅"，加了等于白加。）
          if (kind === undefined && !endpointListed.has(m.id)) { good.push(m); continue; } // 探测不到+端点没列 → 保守
          if (kind === undefined) { skippedNew.push({ id: m.id, kind: 'unknown' }); continue; }
          skippedNew.push({ id: m.id, kind });
        }
      }
      const ordered = byFreeRank(good).map((m) => m.id);
      chosen.push(...ordered);
      notes.push(`保留 ${good.length} 个免费模型（保守口径：已配置的只剔确凿坏的）：${ordered.join(', ') || '(无)'}`);
      // 把人工抄来的额度公告打出来 —— 端点不提供这些，但要影响"留哪个"的判断。
      for (const id of ordered) {
        const n = noticeOf(id);
        if (n) notes.push(`  ℹ️ \`${id}\` 额度 ${n.quota}：${n.note ?? ''}`);
      }
      for (const b of dropped) notes.push(`  ✗ 剔除 \`${b.id}\`（${kindLabel(b.kind)}，确凿不可用）`);
      for (const b of skippedNew) notes.push(`  ＋跳过 \`${b.id}\`（新候选但${kindLabel(b.kind)}，不加入）`);
      const keptSoft = allFree.filter((m) => {
        const k = probeInfo ? cachedKind(probeInfo.cache, providerName, m.id) : undefined;
        return k !== undefined && k !== 'usable' && !DEFINITELY_BROKEN.has(k) && (existingById?.has(m.id) ?? false);
      });
      if (keptSoft.length) notes.push(`  ⚠️ 因保守口径保留了 ${keptSoft.length} 个"当前连不上但没确凿坏"的：${keptSoft.map((m) => m.id).join(', ')}`);
      const absent = good.filter((m) => !endpointListed.has(m.id)).map((m) => m.id);
      if (absent.length) notes.push(`  ⚠️ 端点已不再列出但**保留**（可能被服务端别名）：${absent.join(', ')}`);
    } else {
      const free = byNewest(allFree);
      if (free.length) {
        const n = pick.plus_free === 'latest' ? 1 : Number(pick.plus_free) || 1;
        chosen.push(...free.slice(0, n).map((m) => m.id));
        notes.push(`另取 ${Math.min(n, free.length)} 个最新免费模型：${free.slice(0, n).map((m) => m.id).join(', ')}`);
      } else {
        notes.push(`要免费模型，但端点候选里没有免费 id`);
      }
    }
  }

  return { ids: chosen, notes };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('sync-model-policy — 按你的意图固定模型列表');
  console.log(`  policy  : ${POLICY_PATH}`);
  console.log(`  profile : ${PATCH}`);
  console.log(`  模式    : ${CHECK_REFS ? '只查引用完整性' : WRITE ? '写入' : '预览（dry-run，加 --write 才落盘）'}`);
  console.log();

  if (!existsSync(POLICY_PATH)) { bad(`找不到策略表 ${POLICY_PATH}`); process.exit(1); }
  if (!existsSync(PATCH)) { bad(`找不到 ${PATCH}`); process.exit(1); }

  const policy = yaml.load(readFileSync(POLICY_PATH, 'utf8')) ?? {};
  const defaults = { ...(policy.defaults ?? {}), vision_hints: policy.vision_hints ?? [] };
  const rules = policy.providers ?? {};
  // 用途标注：把"这模型干不了常规对话"这类信息写进 name（UI 只显示 name）。
  const annotations = policy.annotations ?? [];
  // 要剥掉的括号内容（用户不想在 name 里保留的归属标记）
  const stripList = policy.strip ?? [];
  // 识别"我们自己加过的后缀"，用于幂等替换
  const ownTagRe = new RegExp(annotations.map((a) => a.tag).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  let annotated = 0;
  if (Object.keys(rules).length === 0) { bad('策略表里没有 providers'); process.exit(1); }

  const original = readFileSync(PATCH, 'utf8');
  const lines = original.split('\n');
  detectIndent(lines);

  // ── 引用保护：先算出"谁被引用了" ──
  const doc = yaml.load(original);
  const refs = collectModelRefs(doc);
  const refKeys = new Set(refs.keys());

  if (CHECK_REFS) {
    // 只检查：每条引用是否指向一个真实存在的 provider::model
    const pi = (Array.isArray(doc) ? doc : []).find((e) => e?.id === 'llm-pi-ai');
    const defined = new Set();
    for (const [p, cfg] of Object.entries(pi?.config?.providers ?? {})) {
      for (const m of cfg.models ?? []) defined.add(`${p}::${m.id}`);
    }
    // llm-deepseek 这类独立条目也提供 provider（如 deepseek-official）
    for (const e of Array.isArray(doc) ? doc : []) {
      const provId = e?.config?.providerId ?? e?.name;
      for (const m of e?.config?.models ?? []) {
        if (typeof provId === 'string') defined.add(`${provId}::${m.id}`);
      }
    }
    // deepseek-official 是 llm-deepseek-api-key 包硬编码的 provider 名
    for (const e of Array.isArray(doc) ? doc : []) {
      if (e?.name === '@deepseek-ai/dsh-llm-deepseek-api-key') {
        for (const m of e?.config?.models ?? []) defined.add(`deepseek-official::${m.id}`);
      }
    }
    console.log(`检查 ${refs.size} 条被引用的路由：`);
    let dangling = 0;
    for (const [key, by] of refs) {
      const [prov] = key.split('::');
      // 该 provider 若由独立条目提供（不在 llm-pi-ai 里），只要模型定义存在就算命中
      const hit = defined.has(key);
      if (!hit) { dangling++; bad(`${key}  ← 被 ${by.join(', ')} 引用，但没有对应定义`); }
      else ok(`${key}  ← ${by.join(', ')}`);
    }
    console.log();
    if (dangling) { bad(`${dangling} 条悬空引用`); process.exit(2); }
    ok('引用全部有定义');
    return;
  }

  const providers = scanProviders(lines);
  if (providers.length === 0) { bad('没在 patch 里找到 providers 块'); process.exit(1); }
  info(`探测到缩进：providers=${IND.providers} 名称=${IND.name} 模型=${IND.model}`);

  // ── 免费模型的"真能用"探测 ────────────────────────────────────────────────
  // 需求是"所有能连接能用的免费模型"，而**端点列表会撒谎**（实测混着
  // "No endpoints found" / "已下线转付费" / "上游满载"）。所以只能真调。
  // `--probe` 刷新缓存；没给就用现有缓存（过期则退回"放宽"语义，见 solveProvider）。
  let probeCache = loadCache(PACK_DIR);
  if (PROBE) {
    const targets = [];
    for (const p of providers) {
      const rule = rules[p.name];
      if (!rule || (ONLY && p.name !== ONLY)) continue;
      if (!rule.pick?.plus_free) continue;
      const api = field(p.body, 'api');
      const baseURL = field(p.body, 'baseURL');
      const apiKeyEnv = field(p.body, 'apiKeyEnv');
      if (!baseURL) continue;
      const { models: existing } = parseModels(p.body);
      // 探测对象 = 端点列出的免费模型 ∪ 现有免费模型（后者可能已被端点摘掉但仍在用）
      let remote = [];
      try {
        remote = await fetchModels(modelsUrl(baseURL, api), apiKeyEnv ? envFromBashrc(apiKeyEnv) : undefined, api, TIMEOUT_MS);
      } catch { /* 探测阶段拿不到列表就只测现有 */ }
      const ids = new Set([
        ...remote.filter((m) => isFree(m.id)).map((m) => m.id),
        ...existing.filter((m) => isFree(m.id)).map((m) => m.id),
      ]);
      const apiKey = apiKeyEnv ? envFromBashrc(apiKeyEnv) : undefined;
      for (const id of ids) targets.push({ provider: p.name, baseURL, api, apiKey, model: id });
    }
    if (targets.length === 0) {
      info('没有需要探测的免费模型（策略里没写 plus_free: usable）');
    } else {
      console.log(`\n探测 ${targets.length} 个免费模型（真的发一次 max_tokens:1 请求）…`);
      const results = {};
      const t0 = Date.now();
      const rows = await probeMany(targets, {
        concurrency: 4,
        onResult: (it, r) => {
          (results[it.provider] ??= {})[it.model] = { kind: r.kind, status: r.status, message: r.message, ms: r.ms };
          console.log(`  ${kindLabel(r.kind).padEnd(22)} ${it.provider.padEnd(22)} ${it.model}`);
        },
      });
      void rows;
      const file = saveCache(PACK_DIR, results);
      const usable = Object.values(results).flatMap((m) => Object.values(m)).filter((r) => r.kind === KIND.USABLE).length;
      ok(`探测完成：${usable}/${targets.length} 可用，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      info(`缓存：${file}`);
      probeCache = loadCache(PACK_DIR);
    }
  } else if (probeCache?.fresh) {
    const n = Object.values(probeCache.results ?? {}).flatMap((m) => Object.values(m)).length;
    info(`使用探测缓存（${new Date(probeCache.at).toLocaleString()}，${n} 条记录；加 --probe 可刷新）`);
  } else if (probeCache) {
    warn(`探测缓存已过期（${new Date(probeCache.at).toLocaleString()}）→ 免费模型按"放宽"处理；建议 --probe`);
  }
  info(`探测到缩进：providers=${IND.providers} 名称=${IND.name} 模型=${IND.model}`);

  const edits = [];
  const protectedRefs = [];
  let changed = 0;
  let failures = 0;

  for (const p of providers) {
    if (ONLY && p.name !== ONLY) continue;
    const rule = rules[p.name];
    if (!rule) { info(`${p.name}: 策略表里没写规则，跳过（保持不动）`); continue; }

    const api = field(p.body, 'api');
    const baseURL = field(p.body, 'baseURL');
    const apiKeyEnv = field(p.body, 'apiKeyEnv');
    const { headerIdx, models: existing, tail } = parseModels(p.body);
    if (headerIdx === -1) { info(`${p.name}: 没声明 models，跳过`); continue; }

    // 取端点候选
    let candidates = [];
    let probed = false;
    if (baseURL) {
      const url = modelsUrl(baseURL, api);
      try {
        candidates = await fetchModels(url, apiKeyEnv ? envFromBashrc(apiKeyEnv) : undefined, api, TIMEOUT_MS);
        probed = true;
      } catch (err) {
        failures++;
        warn(`${p.name}: 查询 ${url} 失败 —— ${err.message}（按 ${defaults.on_probe_failure} 处理）`);
      }
    } else {
      info(`${p.name}: 没声明 baseURL，只能用现有清单`);
    }

    // 探测失败 → 按 on_probe_failure：keep 则完全不动这家
    if (!probed) {
      if ((defaults.on_probe_failure ?? 'keep') === 'keep') {
        info(`${p.name}: 探测失败，保留现有 ${existing.length} 个模型不动`);
        continue;
      }
      candidates = existing.map((m) => ({ id: m.id }));
    }

    // explicit 模式下，点名的型号可能不在端点候选里 → 补进候选池以便保留
    const candIds = new Set(candidates.map((m) => m.id));
    for (const id of rule.pick?.explicit ?? []) {
      if (!candIds.has(id)) { candidates.push({ id }); candIds.add(id); }
    }

    // 现有条目表：solveProvider 要用它读人工写的 `input:` 判视觉（比 id 猜准），
    // 后面算增删也要用。**必须在 solveProvider 之前建好**（踩过 TDZ）。
    const existingById = new Map(existing.map((m) => [m.id, m]));
    const { ids: targetIds, notes } = solveProvider(p.name, rule, candidates, defaults, existingById, { cache: probeCache });

    // ── 硬保护：被引用的模型一律保留 ──
    const keptByRef = [];
    for (const key of refKeys) {
      const [prov, model] = key.split('::');
      if (prov !== p.name) continue;
      if (targetIds.includes(model)) continue;
      targetIds.push(model);
      keptByRef.push({ model, by: refs.get(key) });
      protectedRefs.push({ key, by: refs.get(key) });
    }

    const targetSet = new Set(targetIds);
    const toAdd = targetIds.filter((id) => !existingById.has(id));
    const toRemove = existing.filter((m) => !targetSet.has(m.id)).map((m) => m.id);

    console.log(`── ${p.name}  (${api || 'api?'})${probed ? `  ← ${candidates.filter((c) => c !== undefined).length} 个端点候选` : '  ← 未探测'}`);
    console.log(`   意图：${rule.intent ?? '（未写）'}`);
    for (const n of notes) console.log(`     · ${n}`);
    if (keptByRef.length) {
      for (const k of keptByRef) console.log(`     🔒 保留 \`${k.model}\`（被 ${k.by.join(', ')} 引用）`);
    }
    console.log(`   现有 ${existing.length} → 目标 ${targetIds.length}` +
      (toAdd.length ? `  +${toAdd.length}` : '') + (toRemove.length ? `  -${toRemove.length}` : ''));
    for (const id of toAdd) console.log(`     ＋ ${id}${isFree(id) ? '  🆓' : ''}`);
    for (const id of toRemove) console.log(`     － ${id}`);

    // ⚠️ 判定"要不要改"必须**把用途标注也算进去**。
    // 只比对增删会漏掉"模型没变但 name 需要打标签"的情况 —— 那正是最常见的场景
    // （给已配置的模型补一个"仅推理"标注）。踩过：标注写好了却因为
    // `+0 -0` 直接 continue，一个标签都没打上。
    const orderedIds = [...targetIds];
    const annotateLog = [];
    const newLines = orderedIds.flatMap((id) => {
      const tag = tagFor(id, annotations, ownTagRe);
      const prev = existingById.get(id);
      if (prev) {
        // 已存在：只改 `name:` 那一行（人工的 contextWindow/efforts/compat 一字不动）。
        // **即使没有 tag 也要走一遍** —— 否则 `strip` 剥不掉 `(Antigravity)`。
        const r = annotateName(prev.lines, tag, ownTagRe, stripList);
        if (r.changed) { annotated++; annotateLog.push({ id, before: r.before, after: r.after }); }
        return r.lines;
      }
      const meta = candidates.find((c) => c && c.id === id) ?? { id };
      const efforts = defaults.auto_reasoning_efforts ? effortsFor(p.name, id) : null;
      const base = renderModel(meta, { efforts });
      if (tag) {
        const r = annotateName(base, tag, ownTagRe, stripList);
        if (r.changed) annotateLog.push({ id, before: r.before, after: r.after });
        return r.lines;
      }
      return base;
    });

    if (toAdd.length === 0 && toRemove.length === 0 && annotateLog.length === 0) {
      console.log('     = 无需变更');
      console.log();
      continue;
    }
    for (const a of annotateLog) console.log(`     🏷️  ${a.before} → ${a.after}`);
    // 安全阀：渲染出的行必须能被重新解析成同样多的模型
    const reparse = parseModels([`${sp(IND.models)}models:`, ...newLines]);
    if (reparse.models.length !== orderedIds.length) {
      bad(`${p.name}: 渲染自检失败（渲染 ${reparse.models.length} 个，期望 ${orderedIds.length}）→ 跳过这家`);
      failures++;
      continue;
    }
    edits.push({ start: p.start, end: p.end, lines: [...p.body.slice(0, headerIdx + 1), ...newLines, ...tail] });
    changed++;
    console.log();
  }

  console.log();
  if (protectedRefs.length) {
    info(`被引用而保留的模型 ${protectedRefs.length} 条（删了会打断 agent-default-model / allowedModels）：`);
    for (const r of protectedRefs) console.log(`     🔒 ${r.key} ← ${r.by.join(', ')}`);
    console.log();
  }
  if (changed === 0) { ok('没有任何变化'); return; }
  if (failures) info(`${failures} 家没算出目标（已跳过）`);

  if (!WRITE) {
    info(`预览结束：${changed} 家需要更新。加 --write 落盘。`);
    return;
  }

  const out = lines.slice();
  for (const e of edits.sort((a, b) => b.start - a.start)) out.splice(e.start, e.end - e.start, ...e.lines);
  const next = out.join('\n');
  // 落盘前必须还能解析，且模型数符合预期
  try {
    const check = yaml.load(next);
    if (!Array.isArray(check)) throw new Error('顶层不再是数组');
  } catch (err) {
    bad(`拒绝写入：改动后 YAML 解析失败 —— ${err.message}`);
    process.exit(1);
  }
  const backup = `${PATCH}.bak-policy-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  copyFileSync(PATCH, backup);
  writeFileSync(PATCH, next, 'utf8');
  ok(`已写入 ${changed} 家`);
  ok(`备份：${backup}`);
  info('profile patch 热重载 —— 刷新页面即可；通常不用重启 DSH');
}

// 只在**作为脚本直接运行**时执行；被 import（如自检）时不要跑。
// 踩过：没有这个守卫时，`import { annotateName } from '../sync-model-policy.mjs'`
// 会把整个 main() 连带跑一遍 —— 自检输出里混进一次完整 dry-run，还会多打一次网络请求。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { bad(err.stack || String(err)); process.exit(1); });
}
