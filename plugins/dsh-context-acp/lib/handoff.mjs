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

import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 默认配置（acp.json 的 `handoff` 段会覆盖）。 */
export const DEFAULT_HANDOFF = Object.freeze({
  enabled: true,
  /** 压缩达到这个次数后写一份（每个会话最多一份）。 */
  afterCompactions: 2,
  /** 文件名前缀。用本插件自己的名字，避免和旧的 context-guard 文件混淆。 */
  prefix: 'HANDOFF-context-acp',
  /** 文档里保留多少条最近的用户消息。 */
  maxRecentUserMessages: 8,
});

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
 * @returns {{maybeHandoff: (session: object) => Promise<object>, last: () => object|null, reset: () => void}}
 */
export function createHandoff({ cfg = DEFAULT_HANDOFF, thresholdRatio = () => 0.75, logger } = {}) {
  /** sessionId → 已写出的绝对路径（本进程判重）。 */
  const written = new Map();
  let last = null;

  function prefixFor(session) {
    return `${cfg.prefix}-${handoffSessionKey(session)}-`;
  }

  async function findExisting(cwd, session) {
    try {
      const prefix = prefixFor(session);
      const entries = await readdir(cwd);
      return entries.filter((entry) => entry.startsWith(prefix)).sort().pop();
    } catch {
      return undefined;
    }
  }

  async function write(session) {
    if (cfg.enabled === false) return { written: false, reason: 'disabled' };
    const events = [...session.snapshotEvents()];
    const stats = collectStats(events);
    if (stats.compactions < cfg.afterCompactions) {
      return { written: false, reason: 'below-threshold', compactions: stats.compactions };
    }
    const cached = written.get(session.id);
    if (cached !== undefined) return { written: true, file: cached, reason: 'cached' };

    const cwd = resolveHandoffDir(session);
    if (cwd === undefined) {
      logger?.warn?.('[acp] handoff: 会话没有 cwd 也没有 DSH_HOME，跳过');
      return { written: false, reason: 'no-cwd' };
    }
    const existing = await findExisting(cwd, session);
    if (existing !== undefined) {
      const file = join(cwd, existing);
      written.set(session.id, file);
      logger?.info?.(`[acp] handoff 已存在：${file}`);
      return { written: true, file, reason: 'existing' };
    }

    const file = join(cwd, `${prefixFor(session)}c${stats.compactions}-${stamp(Date.now())}.md`);
    const body = buildHandoff(session, stats, { ...cfg, thresholdRatio: thresholdRatio() });
    try {
      await writeFile(file, body, 'utf8');
    } catch (error) {
      const reason = String(error?.message ?? error);
      logger?.warn?.(`[acp] handoff 写入失败：${file} — ${reason}`);
      return { written: false, reason: 'write-failed', file, error: reason };
    }
    written.set(session.id, file);
    logger?.info?.(`[acp] handoff 已写出：${file}`);
    return { written: true, file, reason: 'written' };
  }

  return {
    /** 达阈值就写一次；每个会话最多一份。**永不 reject**（失败写进返回值）。 */
    async maybeHandoff(session) {
      try {
        last = { ...(await write(session)), sessionId: session?.id ?? '', at: Date.now() };
        return last;
      } catch (error) {
        const reason = String(error?.message ?? error);
        logger?.warn?.(`[acp] handoff 失败：${reason}`);
        last = { written: false, reason: 'error', error: reason, sessionId: session?.id ?? '', at: Date.now() };
        return last;
      }
    },
    /** 面板用：最近一次真实结果（含"没写"的原因）。 */
    last: () => last,
    /** agent 销毁时清判重缓存。 */
    reset: () => {
      written.clear();
      last = null;
    },
  };
}
