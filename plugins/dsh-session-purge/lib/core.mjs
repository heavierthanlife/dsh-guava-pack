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
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 原子写：同目录临时文件 → fsync → rename。
 *
 * 为什么不能用 `writeFileSync(target, …)`：那是就地 truncate 再写，进程被杀/断电
 * 会留下空文件或半截 JSON。而 `workspace.json` 是"会话属于哪个工作区"的唯一记录，
 * 坏了没别处可查。rename 在同一文件系统上是原子的，读者只会看到旧版或新版。
 */
function writeFileAtomicSync(target, data) {
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  try {
    // 目录项也 fsync，否则 rename 本身可能没落盘。
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* 某些文件系统不支持目录 fsync —— 不致命 */
  }
}

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
 * 算出一个 zstd 帧的结束偏移（RFC 8878 的帧结构），不做解压。
 *
 * 为什么必须**按结构走帧**而不是"扫魔数切片"：实测发现
 * `zstdDecompressSync` 对**被截断的帧是静默容忍的** —— 把日志尾部砍掉 4 字节，
 * 解出来的文本长度与完整文件**一模一样**（2316260 字节），砍 64 字节也只是一个
 * 不报错的短结果。也就是说"失败帧计数"永远抓不到截断，而截断正是这里最危险的
 * 损坏形式（会静默漏掉尾部帧里的附件引用 → 删掉别的会话还在用的图）。
 * 按结构走帧就能精确判断"文件是否正好由完整帧拼成"。
 *
 * @returns {number} 结束偏移；结构不合法时返回 -1。
 */
function zstdFrameEnd(buf, start) {
  if (start + 4 > buf.length) return -1;
  let p = start + 4; // magic 已由调用方校验
  if (p >= buf.length) return -1;
  const fhd = buf[p++];
  if ((fhd & 0x08) !== 0) return -1; // reserved 位必须为 0
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd & 0x20) !== 0;
  const hasChecksum = (fhd & 0x04) !== 0;
  const dictFlag = fhd & 0x03;
  if (!singleSegment) p += 1; // Window_Descriptor
  p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4; // Dictionary_ID
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8; // Frame_Content_Size
  if (p > buf.length) return -1;
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = (h & 1) === 1;
    const type = (h >> 1) & 0x03;
    const size = h >> 3;
    if (type === 3) return -1; // Reserved 块类型
    p += type === 1 ? 1 : size; // RLE 块的 Block_Size 是解压后大小，内容只有 1 字节
    if (p > buf.length) return -1;
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return p <= buf.length ? p : -1;
}

/**
 * 解一份会话日志（详细版）。
 *
 * 格式是**多个 zstd 帧顺序拼接**（实测一份 343 帧 / 710KB）。
 *
 * 返回 `{ text, frames, decodedFrames, failedFrames, complete }`：
 *   `complete === false` 表示文件**不是**由完整帧首尾相接拼成的（截断 / 损坏 / 格式变了）。
 *   调用方必须把它当成"这份日志不可信"，而不是"它没引用任何东西"。
 */
export function decodeSessionLogDetailed(file) {
  const buf = readFileSync(file);
  const slices = [];
  let p = 0;
  let complete = true;
  while (p < buf.length) {
    if (
      buf[p] !== ZSTD_MAGIC[0] ||
      buf[p + 1] !== ZSTD_MAGIC[1] ||
      buf[p + 2] !== ZSTD_MAGIC[2] ||
      buf[p + 3] !== ZSTD_MAGIC[3]
    ) {
      complete = false; // 不在帧边界上
      break;
    }
    const end = zstdFrameEnd(buf, p);
    if (end < 0) {
      complete = false; // 帧结构不合法（多半是被截断）
      break;
    }
    slices.push([p, end]);
    p = end;
  }
  if (p !== buf.length) complete = false;

  let text = '';
  let decodedFrames = 0;
  let failedFrames = 0;
  for (const [start, end] of slices) {
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
      decodedFrames += 1;
    } catch {
      failedFrames += 1;
    }
  }
  return { text, frames: slices.length, decodedFrames, failedFrames, complete };
}

/** 解一份会话日志，只要文本（兼容只关心内容的调用方）。 */
export function decodeSessionLog(file) {
  return decodeSessionLogDetailed(file).text;
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

/**
 * 除 `skip` 之外的会话仍在引用的附件 id 集合。
 *
 * 关键安全属性：**只要有任一日志解不完整，就放弃删任何附件**（`referenced: null`）。
 * 少删只是浪费空间，多删会删掉别的会话还在用的图。
 */
export function referencedAttachments(home, stored, skip) {
  const referenced = new Set();
  for (const [id, entry] of stored) {
    if (skip.has(id)) continue;
    const log = join(entry.dir, 'session.v4.jsonl.zstd');
    if (!existsSync(log)) continue;
    let decoded;
    try {
      decoded = decodeSessionLogDetailed(log);
    } catch {
      // 读不了 / 整个解不开
      return { referenced: null, skipped: id };
    }
    // 文件必须正好由完整帧拼成，且每帧都解得开；否则按"不可信"处理。
    // 截断是这里最危险的损坏形式（会静默漏掉尾部帧里的引用），而它只能靠
    // `complete`（结构走帧）发现 —— 详见 decodeSessionLogDetailed 的注释。
    if (!decoded.complete || decoded.failedFrames > 0 || (decoded.frames > 0 && decoded.decodedFrames === 0)) {
      return { referenced: null, skipped: id };
    }
    for (const m of decoded.text.matchAll(/sha256:[a-f0-9]{64}/g)) referenced.add(m[0]);
  }
  return { referenced, skipped: null };
}

/**
 * 会话目录的写锁现在有没有被别人持有。
 *
 * 机制：DSH 的持久化层用内核 `flock(2)` 锁住会话目录里的 `session.lock`
 * （`@deepseek-ai/dsh-session-persistence-jsonl` 的 lease 模块）。框架自己的原话是：
 * "Removing a live session's lock file therefore forfeits exclusion on POSIX
 *  (nothing in the harness does so)" —— 也就是**本插件是全框架唯一会删掉活跃会话锁
 * 文件的地方**。删掉它，两个写者就可能同时往同一份日志追加，把日志写坏。
 *
 * 我们不改设计，只是**动手之前先问内核一句**：能拿到独占锁就说明没有活写者。
 *
 * @returns {'free'|'held'|'unknown'}
 *   free    —— 没人持有（或压根没有锁文件 = 该会话还没落盘）
 *   held    —— 有活写者持有，必须跳过
 *   unknown —— 本机没有 flock(util-linux)，判断不了
 */
export function sessionLockState(dir) {
  const lockPath = join(dir, 'session.lock');
  // 先看文件在不在：`flock` 默认带 O_CREAT，**会凭空造出一个锁文件** ——
  // 而 plan 阶段必须严格只读。文件不存在 = 没有落盘足迹 = 没人持有。
  if (!existsSync(lockPath)) return 'free';
  try {
    // -n = 非阻塞：拿不到就立刻失败，不排队。
    execFileSync('flock', ['-n', lockPath, '-c', 'true'], { stdio: 'ignore' });
    return 'free'; // 拿到了独占锁 → 没有活写者
  } catch (error) {
    if (error?.code === 'ENOENT') return 'unknown'; // 本机没有 flock
    // util-linux 的退出码 1 = 未能获取锁（EAGAIN/EWOULDBLOCK）= 有人持有。
    // 其它非零（用法错、打不开文件）也按"拿不准"处理 —— 方向一致：不删。
    return error?.status === 1 ? 'held' : 'unknown';
  }
}

/**
 * 计划的指纹：**要删的会话 id 集合** + 附件开关 + 模式。
 *
 * 用于把"确认令牌"绑到用户实际看过的那一套上 —— 这样即使有人在同源页面里
 * 直接发 `execute`，也不能去删用户没确认过的另一批会话。
 * 只用 id（不用体积/时间），因为体积会随写者追加而变化，用它会让指纹无谓地失效。
 */
export function planDigest(plan, { attachments = false, mode = 'trash' } = {}) {
  const ids = plan.entries.map((e) => e.id).sort();
  const payload = JSON.stringify({
    ids,
    attachments: attachments === true,
    mode: mode === 'hard' ? 'hard' : 'trash',
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** 附件对象路径。 */
export function attachmentPath(home, id) {
  const sha = id.slice('sha256:'.length);
  return join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha);
}

/**
 * 把工作目录解析成**真实路径**（符号链接展开）。
 *
 * 为什么清单要写到真实路径：`entry.cwd` 来自会话日志记录的工作目录，路径中间任何
 * 一环都可能是符号链接（WSL 下 `/home/x/proj → /mnt/d/proj` 很常见）。
 * `writeFileSync` 会跟随符号链接，于是"写到工作目录"实际落到链接指向的地方 ——
 * 解析成真实路径后，写的位置就是日志里那个目录**本体**。
 *
 * @returns {string|null} 存在且确为目录时的真实路径；否则 null。
 */
function realDir(path) {
  if (typeof path !== 'string' || path === '') return null;
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * 产出清单该写到哪。
 *
 * 工作目录拿不到（已被删除 / 不是目录 / 解析失败）时落到 `.purge-trash/`，
 * 与旧行为一致 —— 清单不能因为工作目录没了就不写。
 *
 * @returns {{path: string, resolved: boolean}} `resolved=false` 表示落到了 trash。
 */
export function manifestPathFor(entry, home = dshHome()) {
  const dir = realDir(entry.cwd);
  if (dir !== null) {
    return { path: join(dir, `PURGED-${entry.id.replace(/^session-/, '').slice(0, 8)}.md`), resolved: true };
  }
  return { path: join(home, '.purge-trash', `${entry.id}.md`), resolved: false };
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
 * @param options.rosterOnly - 只清花名册，**一个会话都不碰**。
 * @param options.ignoreLocks - 跳过写锁预检（默认不跳；见下方说明）。
 */
export function executePlan(
  plan,
  { mode = 'trash', attachments = false, cleanRoster = false, rosterOnly = false, ignoreLocks = false } = {},
) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const results = [];
  // 回滚点目录名带秒级时间戳，而 `renameSync` 到**已存在**的目录会 ENOTEMPTY。
  // 同一秒内重跑（脚本连续跑两次、或上一轮留下的同名目录）就会让整个清理中途失败，
  // 而且是在已经搬走一部分会话之后。加后缀保证目标一定不存在。
  let trashRoot = join(plan.home, '.purge-trash', stamp);
  if (!rosterOnly && mode === 'trash') {
    for (let n = 2; existsSync(trashRoot); n += 1) {
      trashRoot = join(plan.home, '.purge-trash', `${stamp}-${n}`);
    }
  }

  // ── 0) 写锁预检：动手之前先问内核"这些会话有没有活写者" ────────────────
  // 必须在最前面：因为"到底哪些会被真删"要同时喂给下面的花名册预处理
  // （而花名册的备份也必须在任何删除之前完成）。
  //
  // 被活写者持有的会话一律**跳过**，而不是硬删 —— 删掉它的 `session.lock`
  // 会让两个写者同时往同一份日志追加（框架里只有这里会干这种事）。
  const skippedLocked = [];
  const removable = [];
  if (rosterOnly || ignoreLocks) {
    // 只清花名册本来就不碰会话数据；ignoreLocks 是用户显式要求跳过预检。
    removable.push(...plan.entries);
  } else {
    for (const entry of plan.entries) {
      const state = sessionLockState(entry.dir);
      if (state === 'free') removable.push(entry);
      else skippedLocked.push({ id: entry.id, state });
    }
  }

  // ── 花名册预处理：所有**可能失败**的步骤都提前到删除之前 ──────────────
  // 读原文 → 解析 → 算出新内容 → 写备份，任一步抛错就 abort，此时磁盘上的会话
  // 一个都还没动。最后只剩一次原子写。
  //
  // 注意**不要**把顺序倒过来（先写花名册再删数据）：那样一旦中途失败，磁盘上还在的
  // 会话会失去工作区归属，而且再跑 `--roster-only` 也找不回来了（id 已不在花名册里）。
  // 保持"先删数据、后清花名册"——失败模式只是花名册偏旧，重跑一次即可收敛。
  let rosterPlan = null;
  if (cleanRoster) {
    // 只清花名册时，要摘的是"请求了但磁盘上已不存在"的 id；
    // 真删模式下还要加上**本次真的会删掉的**（不含因写锁被跳过的）。
    const goneIds = rosterOnly
      ? new Set(plan.missing)
      : new Set([...removable.map((e) => e.id), ...plan.missing]);
    if (goneIds.size > 0) {
      // 改之前先留原文：roster 是唯一记录"会话属于哪个工作区"的地方，坏了没别处可查。
      const raw = readFileSync(plan.workspaceFile, 'utf8');
      writeFileSync(`${plan.workspaceFile}.bak-cleanroster-${Date.now()}`, raw, 'utf8');
      const doc = JSON.parse(raw);
      // 只在原本就有 global 时才动它，避免凭空造出一个键。
      if (doc.global !== undefined && doc.global !== null) {
        doc.global.archivedSessionIds = (doc.global.archivedSessionIds ?? []).filter((id) => !goneIds.has(id));
        doc.global.pinnedSessionIds = (doc.global.pinnedSessionIds ?? []).filter((id) => !goneIds.has(id));
      }
      for (const ws of Object.values(doc.tables?.workspaces ?? {})) {
        ws.sessionIds = (ws.sessionIds ?? []).filter((id) => !goneIds.has(id));
      }
      rosterPlan = { text: `${JSON.stringify(doc, null, 2)}\n`, removed: goneIds.size };
    }
  }

  // ── 只清花名册：不碰任何会话数据 ────────────────────────────────────
  // 这正是面板/脚本那三条命令该走的模式：它们宣称"只改 workspace.json，
  // 不删任何会话数据"，以前却因为没传 --id 而把**全部**归档会话一起删了。
  if (!rosterOnly) {
    for (const entry of removable) {
      const moved = [];
      // 与 renderPlan 共用同一个解析函数，预览与实做不会跑偏。
      const manifestTarget = manifestPathFor(entry, plan.home).path;
      let manifestWritten = false;
      let manifestError = null;
      try {
        // 先把清单的父目录建出来。落到 `.purge-trash/` 时那目录**还不存在**
        // （trashRoot 原来是在这次写入之后才 mkdir 的），于是"工作目录不可用 →
        // 清单落回 trash"这条兜底路径一直以 ENOENT 静默失败 —— 也就是说
        // "删前写一份产出清单"的承诺，对任何没记录工作目录的会话都是空头支票。
        mkdirSync(dirname(manifestTarget), { recursive: true });
        writeFileSync(manifestTarget, renderManifest(entry, plan), 'utf8');
        manifestWritten = true;
        moved.push(manifestTarget);
      } catch (error) {
        // 清单写不进去不阻止清理，但要让调用方看得见 —— 以前只落在 results 里，
        // 而 host 路由不回传它，面板永远看不到，"删前写清单"的承诺会无声落空。
        manifestError = String(error?.message ?? error);
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

      // 单个会话删不动（权限、目录非空、设备忙…）**不能让整轮清理中断** ——
      // 以前一个 ENOTEMPTY 就抛到最外层，前面已经搬走的会话连报告都没有。
      let removeError = null;
      try {
        discard(entry.dir, join(trashRoot, basename(entry.dir)));
        discard(entry.projCache, join(trashRoot, 'projcache', basename(entry.projCache)));

        if (attachments) {
          for (const id of entry.deletableAttachments) {
            const p = attachmentPath(plan.home, id);
            discard(p, join(trashRoot, 'attachments', basename(p)));
          }
        }
      } catch (error) {
        removeError = String(error?.message ?? error);
      }
      results.push({
        id: entry.id,
        manifest: manifestWritten ? manifestTarget : null,
        manifestError,
        removeError,
        removed: moved.length,
      });
    }
  }

  if (rosterPlan !== null) {
    // 删除已经发生；这一步是原子的，不会留下半截 JSON。
    writeFileAtomicSync(plan.workspaceFile, rosterPlan.text);
  }

  return {
    mode: rosterOnly ? 'roster-only' : mode,
    trashRoot: !rosterOnly && mode === 'trash' ? trashRoot : null,
    results,
    cleanRoster,
    rosterOnly,
    rosterRemoved: rosterPlan === null ? 0 : rosterPlan.removed,
    // 因写锁被跳过的会话（state: 'held' 有活写者 / 'unknown' 本机没有 flock）。
    skippedLocked,
    manifestFailures: results
      .filter((r) => r.manifestError !== null)
      .map((r) => ({ id: r.id, error: r.manifestError })),
    // 单个会话没删掉的原因（不影响其它会话）。
    removeFailures: results
      .filter((r) => r.removeError !== null)
      .map((r) => ({ id: r.id, error: r.removeError })),
  };
}

/**
 * DSH 是否在跑 —— 三态：`'running' | 'stopped' | 'unknown'`。
 *
 * 为什么不是布尔：改 `workspace.json` 必须停服（运行时内存态会把它覆盖回去），
 * 所以**探测不出来的时候必须当成"在跑"**。旧实现在 curl 缺失 / 超时 / 端口不是 3080
 * 时一律 `return false`（fail-open）—— "没探测到"被当成"没在跑"，于是清理会直接
 * 去改运行中的花名册，而调用方还自以为安全。
 */
export function dshRunningState(port = 3080) {
  // ① curl 最准：能连上就说明有东西在监听并应答（401 也算 —— 不带 -f，curl 仍返回 0）。
  try {
    execFileSync('curl', ['-s', '-o', '/dev/null', '-m', '2', `http://127.0.0.1:${port}/`], { stdio: 'ignore' });
    return 'running';
  } catch (error) {
    // ENOENT = 本机根本没有 curl → 换别的探针，而不是判定"没在跑"。
    // 其余情况（含 curl 自己的超时退出码 28）= curl 跑了但连不上 → 确实没在跑。
    if (error?.code !== 'ENOENT') return 'stopped';
  }
  // ② 退回看端口监听表。
  for (const argv of [['-ltnH'], ['-ltn']]) {
    try {
      const out = execFileSync('ss', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\b`).test(out) ? 'running' : 'stopped';
    } catch {
      /* 没有 ss，试下一个 */
    }
  }
  try {
    const out = execFileSync('netstat', ['-ltn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\b`).test(out) ? 'running' : 'stopped';
  } catch {
    /* 也没有 netstat */
  }
  // ③ 一个可用探针都没有 → 不猜，交给调用方按"在跑"处理。
  return 'unknown';
}

/** 布尔包装：只有**确定**没在跑才是 false（'unknown' 归入"可能在跑"）。 */
export function dshLooksRunning(port = 3080) {
  return dshRunningState(port) !== 'stopped';
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
    const manifest = manifestPathFor(e, plan.home);
    lines.push(`   清单将写到 ${manifest.path}${manifest.resolved ? '' : '（工作目录不可用，落到 trash）'}`);
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
  const rosterOnly = flag('--roster-only');
  const plan = buildPlan({ ids, attachments });

  console.log(renderPlan(plan, { attachments }));

  if (rosterOnly) {
    console.log('');
    console.log(`--roster-only：只摘掉花名册里磁盘上已不存在的 ${plan.missing.length} 个 id，**不动任何会话数据**。`);
  }

  if (!flag('--confirm')) {
    console.log('');
    console.log('这是 dry-run（没有改任何东西）。执行：');
    console.log(`  node ${process.argv[1]} --confirm${attachments ? ' --attachments' : ''}${flag('--hard') ? ' --hard' : ''}`);
    console.log('  缺省是移到 ~/dsh/.purge-trash/<时间戳>/（可回滚）；加 --hard 才真删。');
    console.log(`  node ${process.argv[1]} --confirm --roster-only   # 只清花名册，不删任何会话`);
    return 0;
  }

  const running = dshRunningState();
  if (running !== 'stopped' && !flag('--force')) {
    console.error('');
    if (running === 'unknown') {
      console.error('❌ 探测不出 DSH 是否在跑（本机没有 curl / ss / netstat）。');
      console.error('   清理花名册要改 storages/workspace.json，运行时会被内存态覆盖，所以按"在跑"处理。');
      console.error('   确认它已经停了，再加 --force。');
    } else {
      console.error('❌ DSH 似乎正在运行。安全起见：停止 dsh.service 后再执行（或加 --force 自行承担）。');
      console.error('   理由：清理花名册要改 storages/workspace.json，运行时会被内存态覆盖。');
    }
    return 2;
  }

  const result = executePlan(plan, {
    mode: flag('--hard') ? 'hard' : 'trash',
    attachments,
    cleanRoster: rosterOnly || flag('--clean-roster') || running === 'stopped',
    rosterOnly,
    ignoreLocks: flag('--ignore-locks'),
  });
  console.log('');
  if (result.rosterOnly) {
    console.log(`✅ 完成：只清花名册，摘掉 ${result.rosterRemoved} 个 id；会话数据一个都没动。`);
  } else {
    console.log(
      `✅ 完成：${result.results.length} 个会话，模式 ${result.mode}${result.cleanRoster ? ` + 已清理花名册（${result.rosterRemoved} 个 id）` : ''}`,
    );
    if (result.trashRoot) console.log(`   回滚点：${result.trashRoot}（确认无误后自行删除）`);
  }
  if (result.skippedLocked.length > 0) {
    // 这是**保护**而不是失败：被跳过的会话还在原地，随时可以停服后再来一次。
    console.warn(`⚠️  有 ${result.skippedLocked.length} 个会话正在被写入（写锁被持有），已跳过、未删除：`);
    for (const s of result.skippedLocked) {
      console.warn(
        s.state === 'held'
          ? `   ${s.id}：session.lock 被活写者持有 —— 删掉它会让两个写者同时写同一份日志`
          : `   ${s.id}：本机没有 flock(util-linux)，无法确认有没有写者`,
      );
    }
    console.warn('   等它们写完（或停掉 DSH）再重跑即可；确实要跳过这项检查，加 --ignore-locks。');
  }
  if (result.removeFailures.length > 0) {
    console.warn(`⚠️  有 ${result.removeFailures.length} 个会话没能删掉（其余已按上面的模式处理）：`);
    for (const f of result.removeFailures) console.warn(`   ${f.id}：${f.error}`);
  }
  if (result.manifestFailures.length > 0) {
    console.warn(`⚠️  有 ${result.manifestFailures.length} 个会话的产出清单没写出来（会话本身已按上面的模式处理）：`);
    for (const f of result.manifestFailures) console.warn(`   ${f.id}：${f.error}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

export { main };
