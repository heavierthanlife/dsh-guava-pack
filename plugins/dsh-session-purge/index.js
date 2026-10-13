/**
 * dsh-session-purge — host 半边。
 *
 * 两件事：
 *   1. `/purge` 命令（dry-run 计划，不删）。
 *   2. `/session-purge` HTTP 路由，给侧栏那个可展开面板用（plan / execute）。
 *
 * 路由走 provider-router 验证过的通路：自注册 webServer 前缀路由 +
 * `ctx.connection.requestRejection()` 套 connection 自己的 Host/Origin 围栏与浏览器鉴权。
 *
 * 花名册（workspace.json）**不在这里清**：运行时它由内存态持有并会重写。
 * 停服后用 CLI `--clean-roster` 收尾。
 *
 * @module dsh-session-purge
 */

import { buildPlan, executePlan, renderPlan } from './lib/core.mjs';

/** Cordis 插件名。 */
const name = 'session-purge';

/** 命令注册表。 */
const inject = ['commands'];

/** 面板 → host 的通道路径。 */
const ROUTE_PATH = '/session-purge';

/** 读一个小请求体。 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** 按 connection 的 server-response 信封回复。 */
function sendRpc(res, rpcId, result) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
}

/** 计划瘦身成面板够用的形状。 */
function planForPanel(plan) {
  return {
    archived: plan.archived.length,
    missing: plan.missing,
    entries: plan.entries.map((e) => ({
      id: e.id,
      bytes: e.bytes + e.projCacheBytes,
      files: e.files.length,
      ownAttachments: e.ownAttachments.length,
      deletableAttachments: e.deletableAttachments.length,
      attachmentBytes: e.attachmentBytes,
      cwd: e.cwd,
    })),
    totals: plan.totals,
    attachmentScanFailedOn: plan.attachmentRefScan.failedOn,
  };
}

/**
 * 注册 `/purge` 命令与面板路由。
 * @param ctx - 带有 commands 的上下文。
 */
async function apply(ctx) {
  let definitionId = 'dsh-session-purge';
  try {
    const brand = await import('@deepseek-ai/dsh-commands/brand');
    definitionId = brand.CommandDefinitionId('dsh-session-purge');
  } catch {
    /* 用字符串兜底 */
  }

  const cli = new URL('./lib/core.mjs', import.meta.url).pathname;

  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId,
      name: 'purge',
      description: '列出已归档会话的清理计划（dry-run，不删除）',
      handler: (invocation) => {
        try {
          const argv = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
          const attachments = argv.includes('--attachments');
          const plan = buildPlan({ attachments });
          return {
            kind: 'success',
            text: [
              renderPlan(plan, { attachments }),
              '',
              '本命令只出计划，**不删任何东西**。删除走侧栏「清理归档会话」面板，或 CLI：',
              `  node ${cli} --confirm${attachments ? ' --attachments' : ''}`,
              '停服后加 --clean-roster 可把花名册条目一并摘掉。',
            ].join('\n'),
          };
        } catch (error) {
          return { kind: 'error', text: `purge 计划生成失败：${String(error?.message ?? error)}` };
        }
      },
    });
  }, 'session-purge command');

  // ── 侧栏面板用的路由 ────────────────────────────────────────────────
  ctx.inject(['webServer', 'connection'], (cctx) => {
    cctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        let rpcId = 'invalid-request';
        try {
          const rejection = cctx.connection.requestRejection({ headers: req.headers });
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'text/plain' });
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain' });
            res.end('method not allowed');
            return;
          }
          const pathname = new URL(req.url || '/', 'http://localhost').pathname;
          const endpoint = pathname.startsWith(`${ROUTE_PATH}/`) ? pathname.slice(ROUTE_PATH.length + 1) : '';
          const body = await readJsonBody(req);
          if (body && typeof body.rpcId === 'string') rpcId = body.rpcId;
          if (!endpoint || !body || body.type !== 'client-request' || body.method !== endpoint) {
            sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request envelope' } });
            return;
          }

          if (endpoint === 'plan') {
            const attachments = body.payload?.attachments === true;
            sendRpc(res, rpcId, { ok: true, value: planForPanel(buildPlan({ attachments })) });
            return;
          }

          if (endpoint === 'execute') {
            const attachments = body.payload?.attachments === true;
            const mode = body.payload?.mode === 'hard' ? 'hard' : 'trash';
            const plan = buildPlan({ attachments });
            if (plan.entries.length === 0) {
              sendRpc(res, rpcId, { ok: true, value: { mode, count: 0, trashRoot: null, releasedBytes: 0, note: '没有可清理的归档会话' } });
              return;
            }
            // cleanRoster 保持 false：运行时改 workspace.json 会被内存态覆盖。
            const result = executePlan(plan, { mode, attachments, cleanRoster: false });
            sendRpc(res, rpcId, {
              ok: true,
              value: {
                mode: result.mode,
                count: plan.entries.length,
                trashRoot: result.trashRoot,
                releasedBytes: plan.totals.bytes + (attachments ? plan.totals.attachmentBytes : 0),
              },
            });
            return;
          }

          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/unknown-endpoint', message: endpoint } });
        } catch (error) {
          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/internal', message: String(error?.message ?? error) } });
        }
      },
    });
  });
}

export { apply, inject, name };
