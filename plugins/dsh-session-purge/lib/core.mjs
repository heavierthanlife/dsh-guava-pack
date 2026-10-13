/**
 * dsh-session-purge — 核心逻辑 + CLI。
 *
 * ## 它做什么
 *
 * 把**已归档会话**的记录从磁盘上清掉，只留工作产出品：
 *
 *   删除：sessions/<ws>/<sid>/（日志 + 锁）
 *         storages/session_projcache/sessions/<sid>.json
 *         可选：attachments 中**其余会话都不再引用**的对象
 *         可选：workspace.json 里该会话的花名册条目
 *   保留：工作区里的文件（本来就在会话存储之外）
 *         + 删前写一份产出清单 PURGED-<sid8>.md
 *
 * ## 为什么是 CLI 而不是聊天里的破坏性命令
 *
 * `ctx.workspaces` **没有"从花名册移除会话"的 API**（只有 archive/unarchive/
 * create/rename/delete-workspace），所以清理花名册只能改 `storages/workspace.json`；
 * 而 DSH 运行时它由内存态持有并会重写 —— 运行时改会被覆盖。
 * 因此：聊天命令只出 dry-run 计划，真正的删除在 DSH 停止时用 CLI 执行。
 *
 * ## 附件必须引用计数
 *
 * attachments 是内容寻址的（`sha256:<64hex>` → `objects/<前2位>/<哈希>`），
 * 同一张图跨会话只存一份。所以删附件前必须扫描**其余所有**会话日志收集
 * 仍在引用的 id，只删无人引用的 —— 否则会删掉别的会话还在用的图。
 *
 * ## 搜索索引不用管
 *
 * `dsh-session-query-sqlite` 的对账逻辑是
 * `persistentDeletes = persistedRows.filter(row => !observation.persisted.has(row.id))`，
 * 会话文件消失后下次重算会自己删行。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function dshHome() {
  return process.env.DSH_HOME ?? join(process.env.HOME ?? '', 'dsh');
}

/** 人类可读体积。 */
export function human(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(2)}G`;
}

/** 目录树字节数。 */
export function dirBytes(dir) {
  let total = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(p, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        try {
          total += statSync(child).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * 解一份会话日志。
 *
 * 格式是**多个 zstd 帧顺序拼接**（实测 887 帧），`zstdDecompressSync` 只吃第一帧、
 * 流式解码器会在第二帧报 `Unknown frame descriptor`。按魔数切片逐帧解是可行解。
 */
export function decodeSessionLog(file) {
  const buf = readFileSync(file);
  const offsets = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i);
    }
  }
  let text = '';
  for (let k = 0; k < offsets.length; k++) {
    const slice = buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length);
    try {
      text += zstdDecompressSync(slice).toString('utf8');
    } catch {
      /* 非帧边界（魔数偶然出现在帧数据里）时跳过 */
    }
  }
  return text;
}

/** workspace.json 里的 global 状态（只读）。 */
export function readWorkspaceState(home = dshHome()) {
  const file = join(home, 'storages', 'workspace.json');
  if (!existsSync(file)) return { archivedSessionIds: [], sessionWorkspace: new Map(), file };
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const global = doc?.global ?? {};
  const sessionWorkspace = new Map();
  for (const [id, ws] of Object.entries(doc?.tables?.workspaces ?? {})) {
    for (const sid of ws?.sessionIds ?? []) sessionWorkspace.set(sid, { workspaceId: id, title: ws?.title, path: ws?.path });
  }
  return {
    file,
    archivedSessionIds: global.archivedSessionIds ?? [],
    pinnedSessionIds: global.pinnedSessionIds ?? [],
    sessionWorkspace,
  };
}

/** 磁盘上所有已存储会话：id → {dir, bytes}。 */
export function listStoredSessions(home = dshHome()) {
  const root = join(home, 'sessions');
  const found = new Map();
  if (!existsSync(root)) return found;
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(root, slug.name);
    for (const entry of readdirSync(slugDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(slugDir, entry.name);
      found.set(entry.name, { id: entry.name, dir, slug: slug.name, bytes: dirBytes(dir) });
    }
  }
  return found;
}

/** 从日志文本里提取会被删掉的会话自己的产出与附件引用。 */
export function extractSessionFacts(text) {
  const files = new Set();
  const attachments = new Set();
  let cwd = '';

  const cwdMatch = text.match(/"cwd"\s*:\s*"([^"]+)"/);
  if (cwdMatch) cwd = cwdMatch[1];
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    const data = event?.data;
    if (event?.type === 'tool/call' && (data?.name === 'write' || data?.name === 'edit')) {
      try {
        const args = JSON.parse(data.arguments ?? '{}');
        for (const key of ['file_path', 'filePath', 'path']) {
          if (typeof args?.[key] === 'string') files.add(args[key]);
        }
      } catch {
        /* 参数不是 JSON 就跳过 */
      }
    }
    if (event?.type === 'deliverables/presented' && Array.isArray(data?.files)) {
      for (const f of data.files) if (typeof f?.path === 'string') files.add(f.path);
    }
  }
  for (const m of text.matchAll(/sha256:[a-f0-9]{64}/g)) attachments.add(m[0]);
  for (const m of text.matchAll(/HANDOFF-[A-Za-z0-9._-]+\.md/g)) files.add(m[0]);
  return { files: [...files].sort(), attachments, cwd };
}

/** 除 `skip` 之外的会话仍在引用的附件 id 集合。 */
export function referencedAttachments(home, stored, skip) {
  const referenced = new Set();
  for (const [id, entry] of stored) {
    if (skip.has(id)) continue;
    const log = join(entry.dir, 'session.v4.jsonl.zstd');
    if (!existsSync(log)) continue;
    try {
      for (const m of decodeSessionLog(log).matchAll(/sha256:[a-f0-9]{64}/g)) referenced.add(m[0]);
    } catch {
      /* 解不开就当它引用了所有东西：宁可少删 */
      return { referenced: null, skipped: id };
    }
  }
  return { referenced, skipped: null };
}

/** 附件对象路径。 */
export function attachmentPath(home, id) {
  const sha = id.slice('sha256:'.length);
  return join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha);
}

/**
 * 生成计划（只读，不写任何东西）。
 *
 * @param options.ids - 明确要清的会话 id；缺省用已归档的那些。
 * @param options.attachments - 是否把无人引用的附件也算进计划。
 */
export function buildPlan({ home = dshHome(), ids, attachments = false } = {}) {
  const state = readWorkspaceState(home);
  const stored = listStoredSessions(home);
  const requested = ids && ids.length > 0 ? ids : state.archivedSessionIds;
  const targets = requested.filter((id) => stored.has(id));
  const missing = requested.filter((id) => !stored.has(id));

  const entries = [];
  const skip = new Set(targets);
  const refs = attachments ? referencedAttachments(home, stored, skip) : { referenced: new Set(), skipped: null };

  for (const id of targets) {
    const entry = stored.get(id);
    const log = join(entry.dir, 'session.v4.jsonl.zstd');
    let facts = { files: [], attachments: new Set(), cwd: '' };
    try {
      facts = extractSessionFacts(decodeSessionLog(log));
    } catch {
      /* 解不开也要能删，只是清单为空 */
    }
    const projCache = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    const ownAttachments = [...facts.attachments];
    const deletableAttachments = attachments && refs.referenced !== null ? ownAttachments.filter((a) => !refs.referenced.has(a)) : [];
    const attachmentBytes = deletableAttachments.reduce((sum, a) => {
      const p = attachmentPath(home, a);
      return sum + (existsSync(p) ? statSync(p).size : 0);
    }, 0);
    entries.push({
      id,
      dir: entry.dir,
      bytes: entry.bytes,
      projCache,
      projCacheBytes: existsSync(projCache) ? statSync(projCache).size : 0,
      workspace: state.sessionWorkspace.get(id) ?? null,
      cwd: facts.cwd || state.sessionWorkspace.get(id)?.path || '',
      files: facts.files,
      ownAttachments,
      deletableAttachments,
      attachmentBytes,
      onDisk: true,
    });
  }

  return {
    home,
    workspaceFile: state.file,
    archived: state.archivedSessionIds,
    restore: state.archivedSessionIds.filter((id) => !stored.has(id)),
    missing,
    attachmentRefScan: { enabled: attachments, failedOn: refs.skipped },
    entries,
    totals: {
      bytes: entries.reduce((s, e) => s + e.bytes + e.projCacheBytes, 0),
      attachmentBytes: entries.reduce((s, e) => s + e.attachmentBytes, 0),
      deletableAttachments: entries.reduce((s, e) => s + e.deletableAttachments.length, 0),
    },
  };
}

/** 产出清单正文。 */
export function renderManifest(entry, plan) {
  const lines = [
    '# PURGED SESSION — 产出清单',
    '',
    `- 已清理会话: \`${entry.id}\``,
    `- 清理时间: ${new Date().toLocaleString()}`,
    `- 工作目录: ${entry.cwd || '(未记录)'}`,
    `- 释放: 会话记录 ${human(entry.bytes + entry.projCacheBytes)}${entry.attachmentBytes > 0 ? ` + 附件 ${human(entry.attachmentBytes)}` : ''}`,
    '',
    '> 该会话的全部对话记录已按你的要求删除；下面列出它产出/触碰过的文件（**文件本身未被删除**）。',
    '',
  ];
  if (entry.files.length === 0) lines.push('（未能从日志提取到文件清单）');
  else lines.push('## 产出/触碰过的文件', '', ...entry.files.map((f) => `- \`${f}\``));
  lines.push('');
  return lines.join('\n');
}

/**
 * 执行计划。
 *
 * @param plan - {@link buildPlan} 的结果。
 * @param options.mode - `trash`（移到 DSH_HOME/.purge-trash，可回滚）或 `hard`。
 * @param options.attachments - 是否真删附件。
 * @param options.cleanRoster - 是否同时从 workspace.json 花名册摘除（**只在 DSH 停止时**做）。
 */
export function executePlan(plan, { mode = 'trash', attachments = false, cleanRoster = false } = {}) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const trashRoot = join(plan.home, '.purge-trash', stamp);
  const results = [];

  for (const entry of plan.entries) {
    const moved = [];
    const manifestTarget = entry.cwd
      ? join(entry.cwd, `PURGED-${entry.id.replace(/^session-/, '').slice(0, 8)}.md`)
      : join(plan.home, '.purge-trash', `${entry.id}.md`);
    let manifestWritten = false;
    try {
      writeFileSync(manifestTarget, renderManifest(entry, plan), 'utf8');
      manifestWritten = true;
      moved.push(manifestTarget);
    } catch {
      /* 清单写不进去不阻止清理，但会上报 */
    }
    if (mode === 'trash') mkdirSync(trashRoot, { recursive: true });

    const discard = (path, to) => {
      if (!existsSync(path)) return;
      if (mode === 'trash') {
        mkdirSync(dirname(to), { recursive: true });
        renameSync(path, to);
      } else {
        rmSync(path, { recursive: true, force: true });
      }
      moved.push(path);
    };

    discard(entry.dir, join(trashRoot, basename(entry.dir)));
    discard(entry.projCache, join(trashRoot, 'projcache', basename(entry.projCache)));

    if (attachments) {
      for (const id of entry.deletableAttachments) {
        const p = attachmentPath(plan.home, id);
        discard(p, join(trashRoot, 'attachments', basename(p)));
      }
    }
    results.push({ id: entry.id, manifest: manifestWritten ? manifestTarget : null, removed: moved.length });
  }

  // 花名册清理要覆盖两类 id：本次真删掉的，以及"请求了但磁盘上已不存在"的
  // （典型场景：先用 trash 移走，之后停服务再跑一次只清花名册）。
  const goneIds = new Set([...plan.entries.map((e) => e.id), ...plan.missing]);
  if (cleanRoster && goneIds.size > 0) {
    // 改之前先留原文：roster 是唯一记录"会话属于哪个工作区"的地方，坏了没别处可查。
    const raw = readFileSync(plan.workspaceFile, 'utf8');
    writeFileSync(`${plan.workspaceFile}.bak-cleanroster-${Date.now()}`, raw, 'utf8');
    const doc = JSON.parse(raw);
    doc.global.archivedSessionIds = (doc.global.archivedSessionIds ?? []).filter((id) => !goneIds.has(id));
    doc.global.pinnedSessionIds = (doc.global.pinnedSessionIds ?? []).filter((id) => !goneIds.has(id));
    for (const ws of Object.values(doc.tables?.workspaces ?? {})) {
      ws.sessionIds = (ws.sessionIds ?? []).filter((id) => !goneIds.has(id));
    }
    writeFileSync(plan.workspaceFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }

  return { mode, trashRoot: mode === 'trash' ? trashRoot : null, results, cleanRoster };
}

/** DSH 是否在跑（决定能不能安全清理花名册）。 */
export function dshLooksRunning(port = 3080) {
  try {
    execFileSync('curl', ['-s', '-o', '/dev/null', '-m', '2', `http://127.0.0.1:${port}/`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 计划的可读输出。 */
export function renderPlan(plan, { attachments = false } = {}) {
  const lines = [];
  lines.push(`DSH_HOME: ${plan.home}`);
  lines.push(`归档会话: ${plan.archived.length} 个${plan.restore.length > 0 ? `（其中 ${plan.restore.length} 个在磁盘上已不存在）` : ''}`);
  if (plan.missing.length > 0) lines.push(`⚠️ 请求的会话在磁盘上找不到: ${plan.missing.join(', ')}`);
  if (plan.entries.length === 0) {
    lines.push('没有可清理的会话。');
    return lines.join('\n');
  }
  for (const e of plan.entries) {
    lines.push('');
    lines.push(`▸ ${e.id}`);
    lines.push(`   目录      ${e.dir}  (${human(e.bytes)})`);
    lines.push(`   投影缓存  ${existsSync(e.projCache) ? human(e.projCacheBytes) : '无'}`);
    lines.push(`   工作目录  ${e.cwd || '(未记录)'}`);
    lines.push(`   清单将写到 ${e.cwd ? join(e.cwd, `PURGED-${e.id.replace(/^session-/, '').slice(0, 8)}.md`) : '(DSH_HOME/.purge-trash)'}`);
    lines.push(`   产出文件  ${e.files.length} 个`);
    if (attachments) {
      lines.push(
        `   附件      ${e.ownAttachments.length} 个引用，其中无人引用可删 ${e.deletableAttachments.length} 个 (${human(e.attachmentBytes)})`,
      );
    }
  }
  lines.push('');
  lines.push(`合计：会话记录 ${human(plan.totals.bytes)}${attachments ? ` + 可删附件 ${human(plan.totals.attachmentBytes)} (${plan.totals.deletableAttachments} 个)` : ''}`);
  if (attachments && plan.attachmentRefScan.failedOn) lines.push(`⚠️ 扫描引用时 ${plan.attachmentRefScan.failedOn} 解不开 → 已改为不删任何附件`);
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────
function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ids = value('--id') ? [value('--id')] : undefined;
  const attachments = flag('--attachments');
  const plan = buildPlan({ ids, attachments });

  console.log(renderPlan(plan, { attachments }));

  if (!flag('--confirm')) {
    console.log('');
    console.log('这是 dry-run（没有改任何东西）。执行：');
    console.log(`  node ${process.argv[1]} --confirm${attachments ? ' --attachments' : ''}${flag('--hard') ? ' --hard' : ''}`);
    console.log('  缺省是移到 ~/dsh/.purge-trash/<时间戳>/（可回滚）；加 --hard 才真删。');
    return 0;
  }

  const running = dshLooksRunning();
  if (running && !flag('--force')) {
    console.error('');
    console.error('❌ DSH 似乎正在运行。安全起见：停止 dsh.service 后再执行（或加 --force 自行承担）。');
    console.error('   理由：清理花名册要改 storages/workspace.json，运行时会被内存态覆盖。');
    return 2;
  }

  const result = executePlan(plan, {
    mode: flag('--hard') ? 'hard' : 'trash',
    attachments,
    cleanRoster: flag('--clean-roster') || !running,
  });
  console.log('');
  console.log(`✅ 完成：${plan.entries.length} 个会话，模式 ${result.mode}${result.cleanRoster ? ' + 已清理花名册' : ''}`);
  if (result.trashRoot) console.log(`   回滚点：${result.trashRoot}（确认无误后自行删除）`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

export { main };
