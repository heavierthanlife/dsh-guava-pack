/**
 * dsh-context-acp — 交接文档（handoff）生成。
 *
 * 从 `dsh-context-guard` 迁移过来：合并成一个插件后，**压缩**归 ACP，
 * **"压了几次之后写一份可读的交接文档"** 也归 ACP，避免两个插件各写一份。
 *
 * ## 为什么是"从会话日志重建"而不是读投影
 *
 * 交接文档要在**新会话**里被人读，所以每个数字都必须可复现：
 * 轮数/步数/压缩次数/释放的 token/模型路由，全部从 `session.snapshotEvents()`
 * 现场数一遍。投影是进程内状态，重启后不等于日志；用投影会让同一份日志
 * 在不同时刻生成不同文档。
 *
 * ## 纯函数 + 薄 IO
 *
 * `buildHandoff`/`collectStats`/`handoffSessionKey` 是纯函数（自检直接喂假事件）；
 * 只有 `createHandoff` 里的读写盘需要 IO。理由：写文件的失败以前被静默吞过 ——
 * 把"算"和"写"分开后，算的部分可测，写的部分只留一个明确的错误出口。
 *
 * @module dsh-context-acp/handoff
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** 默认配置（acp.json 的 `handoff` 段会覆盖）。 */
export const DEFAULT_HANDOFF = Object.freeze({
  enabled: true,
  /** 压缩达到这个次数后**开始**写（每个会话始终只有一份文件）。 */
  afterCompactions: 2,
  /** 文件名前缀。用本插件自己的名字，避免和旧的 context-guard 文件混淆。 */
  prefix: 'HANDOFF-context-acp',
  /** 文档里保留多少条最近的用户消息。 */
  maxRecentUserMessages: 8,
  /**
   * 压缩次数比上次写时更高 → 刷新同一份文件（覆盖，不新增文件）。
   *
   * 为什么默认开：交接文档的价值在「新会话读它」，而长会话从 c2 压到 c4/c6 时，
   * 停在 c2 的文档会变成过期快照（摘要少了两次、统计全是旧的）。每次压缩多写
   * 一次盘是最小代价；频率天然被「一次压缩」限制，不存在每步写盘。
   * 关掉则回到旧的「写完就冻结」语义（文件不再变化）。
   */
  refreshOnHigherCompaction: true,
});

/** 从文档正文读「已压缩 N 次」（旧文件也可能只有内容可依据）。 */
const COMPACTIONS_LINE = /^-\s*已压缩:\s*(\d+)\s*次/m;

/** 从旧命名 `…-c<N>-<stamp>.md` 兜底读次数（正文不可读时）。 */
const LEGACY_NAME_COUNT = /-c(\d+)-/;

/**
 * 触发交接检查的会话事件。
 *
 * - `turn/end`：一轮结束 —— 原来的唯一触发点；
 * - `compaction/end`：一次压缩刚完成 —— **手动 compact 不在任何 turn 里**
 *   （日志里 `turn: null` 且带 `sourceCommandId`），只等 `turn/end` 会拖到下一次
 *   对话结束。用户手动压完两轮后关闭会话，就永远等不到交接文档。
 *
 * 两个都收：压缩完成即时成文，轮结束兜一遍（压缩事件在旧日志/失败路径下可能缺席）。
 */
export const HANDOFF_TRIGGER_EVENTS = Object.freeze(['turn/end', 'compaction/end']);

/** 这个会话事件是否值得检查一次交接（纯函数，便于测试）。 */
export function isHandoffTriggerEvent(event) {
  return HANDOFF_TRIGGER_EVENTS.includes(event?.type);
}

/** 把任意 content 形状收敛成纯文本（字符串 / 数组 / {text} / {content}）。 */
export function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return textOf(value.content);
  }
  return '';
}

/** 一条 user/message 的正文（data 本身就是 UserMessage）。 */
export function messageText(event) {
  return textOf(event?.data?.content ?? event?.data?.message?.content ?? event?.data);
}

/** 从 Tool call 参数里取目标文件路径。 */
export function callFilePath(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments === '') return '';
  try {
    const args = JSON.parse(rawArguments);
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
      if (typeof args?.[key] === 'string') return args[key];
    }
  } catch {
    /* 参数不是合法 JSON：忽略 */
  }
  return '';
}

/** 本地时间戳后缀（文件名安全）。 */
export function stamp(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 会话在文件名里的短标识。
 *
 * 不能直接 `session.id.slice(0, 8)`：真实 id 形如 `session-a6796537-…`，
 * 前 8 位恒为 `"session-"` —— 所有会话会得到同一个前缀，同目录判重会跨会话误判。
 */
export function handoffSessionKey(session) {
  const raw = String(session?.id ?? '');
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
  const compact = bare.replace(/[^a-zA-Z0-9]/g, '');
  return (compact !== '' ? compact : raw.replace(/[^a-zA-Z0-9]/g, '')).slice(0, 8) || 'unknown';
}

/**
 * 从会话事件流统计交接文档需要的全部数字。
 *
 * @param {readonly object[]} events `session.snapshotEvents()`
 * @returns {{turns: number, steps: number, compactions: number, lastFreedTokens: number,
 *            contextWindow: number, route: string, summaries: string[],
 *            recentUsers: string[], files: string[]}}
 */
export function collectStats(events) {
  let turns = 0;
  let steps = 0;
  let compactions = 0;
  let lastFreedTokens = 0;
  let contextWindow = 0;
  let route = '';
  const summaries = [];
  const recentUsers = [];
  const files = new Set();

  for (const event of events ?? []) {
    switch (event?.type) {
      case 'turn/end':
        turns++;
        break;
      case 'step/end':
        steps++;
        break;
      case 'compaction/summary': {
        compactions++;
        const freed = Number(event.data?.shadowedTokenCount);
        if (Number.isFinite(freed) && freed >= 0) lastFreedTokens = freed;
        const text = textOf(event.data?.summary) || textOf(event.data?.text);
        if (text) summaries.push(text);
        break;
      }
      case 'user/message': {
        const text = messageText(event).trim();
        if (text) recentUsers.push(text);
        break;
      }
      case 'tool/call': {
        if (event.data?.name === 'write' || event.data?.name === 'edit') {
          const path = callFilePath(event.data?.arguments);
          if (path) files.add(path);
        }
        break;
      }
      case 'request/context':
        route = [event.data?.provider, event.data?.model].filter(Boolean).join('/');
        contextWindow = Number(event.data?.contextWindow) || contextWindow;
        break;
      default:
        break;
    }
  }

  return {
    turns,
    steps,
    compactions,
    lastFreedTokens,
    contextWindow,
    route,
    summaries,
    recentUsers,
    files: [...files],
  };
}

/**
 * 组装交接文档正文（纯函数）。
 *
 * 素材优先级：压缩摘要（被折叠历史的官方浓缩）> 最近用户消息 > 动过的文件 > 统计。
 *
 * @param {object} session
 * @param {ReturnType<typeof collectStats>} stats
 * @param {typeof DEFAULT_HANDOFF & {thresholdRatio?: number}} cfg
 * @returns {string}
 */
export function buildHandoff(session, stats, cfg = DEFAULT_HANDOFF) {
  const tail = stats.recentUsers.slice(-Math.max(1, cfg.maxRecentUserMessages ?? 8));
  const lines = [
    '# HANDOFF — 由 dsh-context-acp 自动生成',
    '',
    `- 会话: \`${session?.id ?? '(未知)'}\``,
    `- 生成时间: ${new Date().toLocaleString()}`,
    `- 工作目录: ${session?.header?.cwd ?? '(未记录)'}`,
    `- 模型路由: ${stats.route || '(未记录)'}`,
    `- 规模: ${stats.turns} 轮 / ${stats.steps} 步`,
    `- 已压缩: ${stats.compactions} 次（自动兜底阈值 ${Math.round((cfg.thresholdRatio ?? 0.75) * 100)}%）`,
    `- 上次压缩释放: ${stats.lastFreedTokens} tokens`,
    `- 上下文窗口: ${stats.contextWindow || '(未记录)'}`,
    '',
    '## 目标与当前进展',
    '',
    '> 这一节是模板位：把当前任务的真实目标、已完成项与未完成项补在这里。',
    '> 下面的「压缩摘要」是历史被折叠时的官方浓缩，通常已包含大部分脉络。',
    '',
  ];

  if (stats.files.length > 0) {
    lines.push('## 本会话动过的文件', '', ...stats.files.map((f) => `- \`${f}\``), '');
  }

  if (stats.summaries.length > 0) {
    lines.push('## 压缩摘要（按时间顺序）', '');
    stats.summaries.forEach((text, index) => {
      lines.push(`### 第 ${index + 1} 次压缩`, '', text, '');
    });
  }

  if (tail.length > 0) {
    lines.push(`## 最近 ${tail.length} 条用户消息`, '');
    for (const text of tail) {
      const clipped = text.length > 2000 ? `${text.slice(0, 2000)}\n…（已截断）` : text;
      lines.push('```text', clipped, '```', '');
    }
  }

  lines.push(
    '## 下一步',
    '',
    '1. 在新会话里先读这份 handoff，再读上面列出的文件。',
    '2. 不要重复已完成的工作；从「未完成项」继续。',
    '',
    `> 触发原因：本会话第 ${stats.compactions} 次压缩达到 handoff.afterCompactions=${cfg.afterCompactions}。`,
    '',
  );

  return lines.join('\n');
}

/** 交接文档的落盘目录：优先会话 cwd，其次 DSH_HOME —— 拿不到就返回 undefined（不静默丢）。 */
export function resolveHandoffDir(session) {
  const cwd = session?.header?.cwd;
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  if (process.env.HOME) return join(process.env.HOME, 'dsh');
  return undefined;
}

/**
 * 创建 handoff 写入器（唯一有 IO 的部分）。
 *
 * @param {object} deps
 * @param {object} deps.cfg `handoff` 配置
 * @param {(ratio: number) => number} [deps.thresholdRatio] 只用于文档里的阈值文案
 * @param {{warn?: Function, info?: Function}} [deps.logger]
 * @returns {{maybeHandoff: (session: object, options?: {force?: boolean}) => Promise<object>, last: () => object|null, reset: () => void}}
 */
export function createHandoff({ cfg = DEFAULT_HANDOFF, thresholdRatio = () => 0.75, logger } = {}) {
  /** sessionId → { file, compactions }（本进程判重与刷新基线）。 */
  const written = new Map();
  /** sessionId → 串行化链尾（并发触发时保证「一个会话一份」）。 */
  const chains = new Map();
  /**
   * 本进程确认过「目录里还没有这个会话的 handoff」的 sessionId。
   *
   * 为什么需要：每次 turn/end 都可能触发检查，未达阈值时不应反复 readdir；
   * 但一旦目录里**已有**文件（上一次进程写的 / 本进程写的），就必须绕过阈值去
   * 判刷新 —— 否则用户事后把 afterCompactions 调高，旧文件会停在旧次数不再更新。
   */
  const knownMissing = new Set();
  let last = null;

  function prefixFor(session) {
    return `${cfg.prefix}-${handoffSessionKey(session)}-`;
  }

  /**
   * 找出这个会话已有的交接文档（含旧命名 `…-c<N>-…`）与它记的压缩次数。
   *
   * 次数优先读正文「已压缩: N 次」（对所有命名都成立）；正文读不了再从旧文件名
   * `-c<N>-` 兜底。判重与「要不要刷新」都必须以这个数为准，不能只看文件在不在 ——
   * 否则 c2 的旧文件会永远挡住 c4 的刷新。
   */
  async function findExisting(cwd, session) {
    let entries;
    try {
      entries = await readdir(cwd);
    } catch {
      return undefined;
    }
    const latest = entries.filter((entry) => entry.startsWith(prefixFor(session))).sort().pop();
    if (latest === undefined) return undefined;
    const file = join(cwd, latest);
    let compactions = 0;
    try {
      const text = await readFile(file, 'utf8');
      const match = COMPACTIONS_LINE.exec(text);
      if (match !== null) compactions = Number(match[1]);
    } catch {
      /* 正文读不了：用文件名兜底 */
    }
    if (!Number.isFinite(compactions) || compactions <= 0) {
      const legacy = LEGACY_NAME_COUNT.exec(latest);
      if (legacy !== null) compactions = Number(legacy[1]);
      else compactions = 0;
    }
    return { file, compactions };
  }

  /**
   * 新文件名：**会话稳定**，不含压缩次数。
   *
   * 为什么不再带 `c<N>`：刷新会覆盖同一份文件，名字里的次数立刻变成假信息
   * （c2 的文件里写着「已压缩: 4 次」）。次数是正文的事实，不是文件名的。
   * 旧文件（`…-c2-…`）仍会被认领并按更高次数原地刷新，不需要改名。
   */
  function newFilePath(cwd, session) {
    return join(cwd, `${prefixFor(session)}${stamp(Date.now())}.md`);
  }

  async function write(session, { force = false } = {}) {
    if (cfg.enabled === false) return { written: false, reason: 'disabled' };
    const events = [...session.snapshotEvents()];
    const stats = collectStats(events);
    const belowThreshold = stats.compactions < cfg.afterCompactions;

    // 文件定位：本进程缓存优先；否则从磁盘认领（重启/重挂后仍能续写同一份）。
    // 「磁盘上还没有文件」的结果进 knownMissing 缓存，避免每次 turn/end 都 readdir。
    const cwd = resolveHandoffDir(session);
    if (cwd === undefined) {
      logger?.warn?.('[acp] handoff: 会话没有 cwd 也没有 DSH_HOME，跳过');
      return { written: false, reason: 'no-cwd' };
    }
    let existing = written.get(session.id);
    if (existing === undefined && !knownMissing.has(session.id)) {
      existing = await findExisting(cwd, session);
      if (existing === undefined) knownMissing.add(session.id);
    }

    // 还没有任何文件：保持旧的「未达阈值不写」语义。
    if (existing === undefined && !force && belowThreshold) {
      return {
        written: false,
        reason: 'below-threshold',
        compactions: stats.compactions,
        required: cfg.afterCompactions,
      };
    }

    // 刷新判定：已经有文件时**不受阈值影响**（文件既然存在就要保持最新）；
    // 压缩次数比上次写时更高（或显式 --force）就重写同一份文件。
    // 刷新覆盖同一路径，不新增文件 —— 一个会话永远只有一份 handoff。
    const higher = existing !== undefined && stats.compactions > existing.compactions;
    const refresh = existing !== undefined && ((cfg.refreshOnHigherCompaction !== false && higher) || force);
    if (existing !== undefined && !refresh) {
      const reason = written.has(session.id) ? 'cached' : 'existing';
      written.set(session.id, existing);
      logger?.info?.(`[acp] handoff 已存在：${existing.file}`);
      return { written: true, file: existing.file, compactions: existing.compactions, reason };
    }

    const file = existing !== undefined ? existing.file : newFilePath(cwd, session);
    const body = buildHandoff(session, stats, { ...cfg, thresholdRatio: thresholdRatio() });
    try {
      await writeFile(file, body, 'utf8');
    } catch (error) {
      const reason = String(error?.message ?? error);
      logger?.warn?.(`[acp] handoff 写入失败：${file} — ${reason}`);
      return { written: false, reason: 'write-failed', file, error: reason };
    }
    const record = { file, compactions: stats.compactions };
    written.set(session.id, record);
    knownMissing.delete(session.id);
    const reason = existing !== undefined ? 'refreshed' : 'written';
    logger?.info?.(`[acp] handoff ${reason === 'refreshed' ? '已刷新' : '已写出'}：${file}（c${stats.compactions}）`);
    return { written: true, file, compactions: stats.compactions, reason, refreshedFrom: existing?.compactions };
  }

  return {
    /**
     * 达阈值就写一份；之后压缩次数更高就**刷新同一份**（覆盖，不新增文件）。
     *
     * 并发触发（`compaction/end` 紧跟 `turn/end`）用 per-session promise 链串行化：
     * 否则两个调用会同时读「没有文件」并各写一份，破坏「一个会话一份」。
     *
     * **永不 reject**（失败写进返回值）。
     */
    async maybeHandoff(session, options = {}) {
      const sessionId = session?.id ?? '';
      const previous = chains.get(sessionId) ?? Promise.resolve();
      const run = previous.then(() => write(session, options), () => write(session, options));
      // 链上只保留「已结算」，避免把上一次的返回值/rejection 传下去。
      const settled = run.then(() => undefined, () => undefined);
      chains.set(sessionId, settled);
      try {
        last = { ...(await run), sessionId, at: Date.now() };
        return last;
      } catch (error) {
        const reason = String(error?.message ?? error);
        logger?.warn?.(`[acp] handoff 失败：${reason}`);
        last = { written: false, reason: 'error', error: reason, sessionId, at: Date.now() };
        return last;
      } finally {
        if (chains.get(sessionId) === settled) chains.delete(sessionId);
      }
    },
    /** 面板用：最近一次真实结果（含"没写"的原因）。 */
    last: () => last,
    /** agent 销毁时清判重缓存。 */
    reset: () => {
      written.clear();
      chains.clear();
      knownMissing.clear();
      last = null;
    },
  };
}

/**
 * 交接文档的接线：每个 agent 的 `turn/end` / `compaction/end` 上检查一次。
 *
 * 为什么挂在 agent 作用域而不是根 `session/event`：根上下文看不到 agent 的
 * scope-filtered 会话事件（这是 context-guard 当初踩过的坑）；`agent/created`
 * 在根上下文可见，用它拿到 agent 后，在其 `agent.ctx` 上听 `session/event`。
 *
 * 为什么不能只在 `turn/end`：手动 compact 是一次独立命令（`turn: null`），
 * 压缩完成时没有轮结束；等下一轮结束才写，用户压完就关会话的话永远不会成文。
 *
 * @param {object} deps 见 lib/index.js `makeDeps`（需要 `ctx` 与 `handoff`）
 * @returns {() => void} disposer
 */
export function installHandoffHook(deps) {
  const { ctx } = deps;
  const perAgent = new Map();

  function attach(agent) {
    if (agent === null || typeof agent !== 'object' || perAgent.has(agent)) return;
    const dispose = agent.ctx.effect(function* () {
      yield agent.ctx.on('session/event', (session, event) => {
        if (!isHandoffTriggerEvent(event)) return;
        // 不在事件监听器里 await：漏出去的 rejection 在 Node 里会终止进程。
        // maybeHandoff 自己**永不 reject**（失败写进返回值），这里再兜一层。
        void deps.handoff?.maybeHandoff?.(session)?.catch?.(() => {});
      });
    }, 'context-acp/handoff');
    perAgent.set(agent, dispose);
  }

  return ctx.effect(function* () {
    yield () => {
      for (const dispose of perAgent.values()) {
        try {
          dispose();
        } catch {
          /* 已随 agent fiber 销毁 */
        }
      }
      perAgent.clear();
    };
    yield ctx.on('agent/created', ({ agent }) => attach(agent));
    yield ctx.on('agent/disposed', ({ agent }) => {
      const dispose = perAgent.get(agent);
      if (dispose === undefined) return;
      perAgent.delete(agent);
      try {
        dispose();
      } catch {
        /* 已随 agent fiber 销毁 */
      }
    });
    // 插件挂载时已经活着的 agent（安装/重挂时正在跑的会话）。
    try {
      for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent);
    } catch {
      /* agents 服务不可用：新 agent 仍会被 agent/created 捕获 */
    }
  }, 'context-acp/handoff lifecycle');
}
