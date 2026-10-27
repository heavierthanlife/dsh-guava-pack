/**
 * dsh-context-acp — 块账本（B 负责；以纯函数为主）。
 *
 * ## 数据来源（唯一事实来源是会话日志，不是内存状态）
 *
 * 一次压缩在日志里留下四个事件（顺序契约见 `@deepseek-ai/dsh-compaction/types`）：
 *
 *   compaction/start → compaction/summary → user/message(replace) → compaction/end
 *
 * 其中 `compaction/summary.shadowedSeqs` 是被压掉的 surface 节点集合，
 * `shadowedRange` 是 surface **位置**区间（不是数值 seq 区间 —— 先前的替换会把
 * 高 seq 的 summary 节点放到更老的位置，start 可能大于 end）。
 *
 * 所以：
 *   - `decompress` 只能靠 `shadowedSeqs` / `shadowedRange` + `snapshotEvents()` 找原文；
 *   - 块编号（b1..bN）、tier（二次压缩 checkpoint → tier+1）、seq→块映射，
 *     全部从日志重建，进程重启后仍一致。
 *
 * ## 为什么 tier 必须按日志顺序推导
 *
 * `compress` 的调用顺序不是可靠信息（模型可能在两个 agent 上交错调用、进程可能重启）。
 * 唯一稳定的事实是：新块 `bN` 的 `shadowedSeqs` 里出现了某个**既有块**的
 * checkpoint 替换节点，而该节点的 `source.compactionId` 指回既有块。
 * 按 `compaction/start` 的日志顺序扫描，用已处理块表查 compactionId，
 * 就能得到 `tier = max(被包含块 tier) + 1`，且天然不会自引用。
 *
 * @module dsh-context-acp/ledger
 */

/**
 * 每块被压节点的类型统计（tool/result vs 消息类）。
 *
 * 为什么不用普通字段：LedgerBlock 的形状是 Lead 与 P3 消费的公开契约，
 * 多一个可见字段会让 JSON 输出/快照比较出现噪声。用模块私有 Symbol 挂在块上，
 * `totalsOf(blocks)` 能在不重新读 session 的情况下汇总，同时不污染对外形状。
 */
const SHADOW_STATS = Symbol('dsh-context-acp.shadow-stats');

/** 参与 `totals.text` 的消息类事件（tool/result 单独计入 `totals.tool`）。 */
const MESSAGE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
]);

/**
 * 一块被压缩掉的历史（一条 checkpoint）。
 *
 * @typedef {object} LedgerBlock
 * @property {string} block 稳定编号：`b1`, `b2`, …（按压缩发生顺序）
 * @property {string} compactionId
 * @property {number} startSeq `compaction/summary.shadowedRange.start`（surface 位置）
 * @property {number} endSeq `compaction/summary.shadowedRange.end`
 * @property {number[]} shadowedSeqs 被替换的全部 surface seq（surface 顺序）
 * @property {number} shadowedTokens 宿主记账的启发式 token 数
 * @property {number} tier 1 = 原文压缩；2 = 压了 checkpoint（蒸馏层）；…
 * @property {string} provider 写摘要的 provider
 * @property {string} model 写摘要的 model
 * @property {number} summarySeq 承载摘要的 `compaction/summary` 事件 seq
 * @property {string} text 摘要文本（从 `summary` 的 text blocks 拼接）
 */

/** 把任意值安全转成字符串（compactionId 在运行期是 branded string）。 */
function asString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * 从 ContentBlock[] 里拼出可见文本。
 *
 * 只收 `type === 'text'`：reasoning 是模型的内部推理、image/file 是附件引用，
 * 它们都不是「原文对话」的可检索文本。多段之间用换行连接，保持 markdown 摘要可读。
 *
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 取一条 surface 事件的可检索文本。
 *
 * 首选 `session.deriveEventMessage(event)`：它应用了宿主的消息投影
 * （tool/result 改写、developer 注入等），与模型实际看到的内容一致。
 * 返回 null（非 surface 事件 / 空消息）时退化到 `event.data` 里尽力取：
 * tool/result 的错误信息也可能是检索线索。
 *
 * 永不抛错：账本/检索工具是只读诊断面，不能因为一条畸形历史让整个工具失败。
 *
 * @param {{ deriveEventMessage?: (event: object) => object | null }} session
 * @param {object | undefined} event
 * @returns {string}
 */
export function eventText(session, event) {
  if (event === null || typeof event !== 'object') return '';
  let message = null;
  try {
    message = session?.deriveEventMessage?.(event) ?? null;
  } catch {
    message = null;
  }
  const fromMessage = contentText(message?.content);
  if (fromMessage.length > 0) return fromMessage;

  // 退化路径：直接读日志数据的原始形状。
  const data = event.data;
  if (data === null || typeof data !== 'object') return '';
  const candidates = [
    contentText(data.content),
    contentText(data.message?.content),
  ];
  for (const text of candidates) {
    if (text.length > 0) return text;
  }
  if (typeof data.error?.message === 'string') return data.error.message;
  if (typeof data.message?.error?.message === 'string') return data.message.error.message;
  return '';
}

/**
 * 取一条 surface 事件的角色。
 *
 * 与 `decompress` 的出参 `role` 共用：优先用 `deriveEventMessage().role`
 * （消息自己声明的角色是权威），取不到再按事件类型推断。
 *
 * @param {{ deriveEventMessage?: (event: object) => object | null }} session
 * @param {object | undefined} event
 * @returns {'user'|'assistant'|'tool'|'system'|'developer'}
 */
export function eventRole(session, event) {
  let role;
  try {
    role = session?.deriveEventMessage?.(event)?.role;
  } catch {
    role = undefined;
  }
  if (typeof role === 'string' && role.length > 0) return role;
  switch (event?.type) {
    case 'user/message':
      return 'user';
    case 'assistant/message':
      return 'assistant';
    case 'tool/result':
      return 'tool';
    default:
      return 'system';
  }
}

/**
 * 从会话日志重建全部块。
 *
 * 失败压缩（只有 `compaction/start`、没有 `compaction/summary`）不算块：
 * 它没有 shadowedSeqs，也不产生 checkpoint，账本里出现只会误导模型。
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {LedgerBlock[]} 按发生顺序
 */
export function buildLedger(session) {
  let events;
  try {
    events = session?.snapshotEvents?.() ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(events) || events.length === 0) return [];

  // 先按 seq 建索引：tier 判定要回看被压节点的原始事件（checkpoint 的来源）。
  const bySeq = new Map();
  for (const event of events) {
    if (event !== null && typeof event === 'object' && typeof event.seq === 'number') {
      bySeq.set(event.seq, event);
    }
  }

  // 按 compactionId 配对 start/summary。end 不参与配对：契约里 summary 之后
  // 事件已经落地，end 的 error 只标记事务收尾失败，不改变已写入的摘要事实。
  const byId = new Map();
  for (const event of events) {
    const id = asString(event?.data?.compactionId);
    if (id.length === 0) continue;
    if (event.type === 'compaction/start') {
      const entry = byId.get(id) ?? {};
      entry.start = event;
      byId.set(id, entry);
    } else if (event.type === 'compaction/summary') {
      const entry = byId.get(id) ?? {};
      entry.summary = event;
      byId.set(id, entry);
    }
  }

  const entries = [...byId.values()].filter((entry) => entry.start !== undefined && entry.summary !== undefined);
  // 按 start 的日志位置排序就是「压缩发生顺序」；summary seq 只作为同位置时的稳定兜底。
  entries.sort((left, right) => left.start.seq - right.start.seq || left.summary.seq - right.summary.seq);

  /** 已处理块：compactionId → block（tier 只允许引用更早的块）。 */
  const processed = new Map();
  const blocks = [];

  for (const entry of entries) {
    const summary = entry.summary;
    const data = summary.data ?? {};
    const compactionId = asString(data.compactionId);
    const shadowedSeqs = Array.isArray(data.shadowedSeqs)
      ? data.shadowedSeqs.filter((seq) => typeof seq === 'number' && Number.isFinite(seq))
      : [];

    // tier：被压节点里每出现一个「指回既有块的 checkpoint」，就至少是该块 tier+1。
    // 多个来源取 max（压了 b1 和 b3 的 checkpoint → max(tier)+1）。
    let tier = 1;
    for (const seq of shadowedSeqs) {
      const event = bySeq.get(seq);
      const source = event?.data?.source;
      if (event?.type !== 'user/message' || source?.kind !== 'compact-checkpoint') continue;
      const parent = processed.get(asString(source.compactionId));
      if (parent !== undefined) tier = Math.max(tier, parent.tier + 1);
    }

    // 同一次扫描顺带记录被压节点的类型，供 totalsOf 汇总（不改变公开字段）。
    let tool = 0;
    let text = 0;
    for (const seq of shadowedSeqs) {
      const type = bySeq.get(seq)?.type;
      if (type === 'tool/result') tool += 1;
      else if (MESSAGE_EVENT_TYPES.has(type)) text += 1;
    }

    const summaryText = contentText(data.summary);
    const block = {
      block: `b${blocks.length + 1}`,
      compactionId,
      // shadowedRange 是 surface 位置区间，start 可能大于 end，原样保留给调用方判断。
      startSeq: typeof data.shadowedRange?.start === 'number' ? data.shadowedRange.start : -1,
      endSeq: typeof data.shadowedRange?.end === 'number' ? data.shadowedRange.end : -1,
      shadowedSeqs: shadowedSeqs.slice(),
      shadowedTokens: typeof data.shadowedTokenCount === 'number' && Number.isFinite(data.shadowedTokenCount)
        ? data.shadowedTokenCount
        : 0,
      tier,
      provider: asString(data.provider),
      model: asString(data.model),
      summarySeq: summary.seq,
      text: summaryText,
    };
    Object.defineProperty(block, SHADOW_STATS, {
      value: { tool, text },
      enumerable: false,
      configurable: false,
      writable: false,
    });

    blocks.push(block);
    processed.set(compactionId, block);
  }

  return blocks;
}

/**
 * seq → 所属块 的映射（decompress 的 `block`/`compactionId` 查找、tier 判定共用）。
 *
 * 只映射 `shadowedSeqs`：`summarySeq` 是日志事件、不是 surface 节点，
 * 混进来会让「这个 seq 属于哪个块」的语义变得不可靠。
 *
 * @param {LedgerBlock[]} blocks
 * @returns {Map<number, LedgerBlock>}
 */
export function indexBySeq(blocks) {
  const index = new Map();
  for (const block of blocks) {
    for (const seq of block.shadowedSeqs) index.set(seq, block);
  }
  return index;
}

/**
 * 给定一个 seq，判断它属于哪个块；不属于任何块返回 undefined。
 * @param {LedgerBlock[]} blocks
 * @param {number} seq
 * @returns {LedgerBlock | undefined}
 */
export function blockOfSeq(blocks, seq) {
  for (const block of blocks) {
    if (block.shadowedSeqs.includes(seq)) return block;
  }
  return undefined;
}

/**
 * 计算「即将被压的 seq 集合」应得的 tier（供 compress 工具在提交前接线）。
 *
 * 调用时机允许在新 compaction 事件已经 append 之后：新块自身的 seq 不在
 * 自己的 `shadowedSeqs` 里，checkpoint 的 `source.compactionId` 只会指回旧块，
 * 因此不会自引用、也不会循环。
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {readonly number[]} shadowedSeqs
 * @returns {number} 1 或 max(被包含块 tier) + 1
 */
export function tierOfShadowedSeqs(session, shadowedSeqs) {
  const blocks = buildLedger(session);
  if (blocks.length === 0) return 1;
  const byId = new Map(blocks.map((block) => [block.compactionId, block]));

  // 用事件索引而不是 session.eventAt：与 buildLedger 使用同一份日志快照，
  // 避免「账本来自旧快照、事件来自新快照」的错位。
  const events = (() => {
    try {
      return session?.snapshotEvents?.() ?? [];
    } catch {
      return [];
    }
  })();
  const bySeq = new Map();
  for (const event of events) {
    if (event !== null && typeof event === 'object' && typeof event.seq === 'number') bySeq.set(event.seq, event);
  }

  let tier = 1;
  for (const seq of Array.isArray(shadowedSeqs) ? shadowedSeqs : []) {
    const event = bySeq.get(seq);
    const source = event?.data?.source;
    if (event?.type !== 'user/message' || source?.kind !== 'compact-checkpoint') continue;
    const parent = byId.get(asString(source.compactionId));
    if (parent !== undefined) tier = Math.max(tier, parent.tier + 1);
  }
  return tier;
}

/**
 * 汇总全部块的被压节点数量（acp_status 的 `totals`）。
 *
 * `summaries` 就是块数（每块恰好一份摘要）；`tool` / `text` 来自 buildLedger
 * 时挂上的模块私有统计。用 `?.` 兼容手工构造的 block 对象（统计为 0），
 * 但工具路径永远传 buildLedger 的输出，所以真实数字完整。
 *
 * @param {LedgerBlock[]} blocks
 * @returns {{ tool: number, text: number, summaries: number }}
 */
export function totalsOf(blocks) {
  let tool = 0;
  let text = 0;
  const list = Array.isArray(blocks) ? blocks : [];
  for (const block of list) {
    const stats = block?.[SHADOW_STATS];
    if (stats === undefined) continue;
    tool += stats.tool;
    text += stats.text;
  }
  return { tool, text, summaries: list.length };
}
