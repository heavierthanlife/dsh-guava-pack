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

import { randomBytes } from 'node:crypto';
import { buildPlan, buildPlanAsync, executePlan, planDigest, readStaleIds, renderPlan } from './lib/core.mjs';

/** Cordis 插件名。 */
const name = 'session-purge';

/** 命令注册表。 */
const inject = ['commands'];

/** 面板 → host 的通道路径。 */
const ROUTE_PATH = '/session-purge';

/** 确认令牌的有效期：够用户看完计划再点确认，又不至于长期挂着。 */
const CONFIRM_TTL_MS = 5 * 60 * 1000;

/**
 * 待确认的 `execute` 令牌：token → { digest, expiresAt }。
 *
 * 一次性 + 有期限 + 绑指纹（见 index 里的校验）。顺手清掉过期的，
 * 免得长时间开着的页面把这张表撑大。
 */
const confirmTokens = new Map();

function issueConfirmToken(digest) {
  const now = Date.now();
  for (const [key, value] of confirmTokens) {
    if (value.expiresAt < now) confirmTokens.delete(key);
  }
  const token = randomBytes(24).toString('base64url');
  confirmTokens.set(token, { digest, expiresAt: now + CONFIRM_TTL_MS });
  return token;
}

/**
 * 完整计划的短时效缓存。
 *
 * 为什么需要：生成计划要解压归档会话的日志（本机实测：一份 4.5MB 日志 ≈ 200ms，
 * 解压 99ms + 解析 109ms）。面板每次打开、每次取确认令牌都要一份，缓存 30 秒能把
 * 重复开销降到 0。
 *
 * 为什么 30 秒是安全的：计划只用于"给用户看"和"算确认指纹"，真正的删除在
 * `executePlan` 里还会重新校验写锁与文件是否存在。而且缓存让"用户看到的计划"和
 * "指纹绑定的计划"是**同一份**，反而更一致。
 */
const PLAN_TTL_MS = 30 * 1000;
const planCache = new Map();

async function planCached(attachments) {
  const key = attachments === true ? 'attachments' : 'plain';
  const hit = planCache.get(key);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < PLAN_TTL_MS) return hit.plan;
  // 异步版：在解压每一帧、解析每一行时让出事件循环，不冻住 DSH。
  const plan = await buildPlanAsync({ attachments: attachments === true });
  planCache.set(key, { at: now, plan });
  return plan;
}

/** 执行完立刻作废缓存：下一次计划必须是新的。 */
function invalidatePlanCache() {
  planCache.clear();
}

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
    // 必须挂在 effect 上：`webServer.register()` 返回 disposer，不登记的话插件重挂
    // （Plugin Manager 禁用再启用、配置变更导致 re-apply）会留下旧路由 —— 再注册直接抛
    // `duplicate prefix route`，而真正生效的是旧 handler 的闭包。
    cctx.effect(() => cctx.webServer.register({
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

          // 便宜的残留列表：面板**每次页面加载**都要刷新它，而它只需要两个 id 集合
          // 相减（实测 0ms）。以前它走的是完整 plan（本机实测 208ms，全花在解压那份
          // 4.5MB 归档日志上）—— 那才是真正每次页面加载都会发生的阻塞。
          if (endpoint === 'stale') {
            sendRpc(res, rpcId, { ok: true, value: { ...readStaleIds(), cli } });
            return;
          }

          if (endpoint === 'plan') {
            const attachments = body.payload?.attachments === true;
            const mode = body.payload?.mode === 'hard' ? 'hard' : 'trash';
            const plan = await planCached(attachments);
            // 把 CLI 的真实路径回给面板：面板以前硬编码 `~/dsh/playground/themes/...`，
            // 装成 pack 的机器上那个路径根本不存在，用户照抄命令会 MODULE_NOT_FOUND。
            sendRpc(res, rpcId, {
              ok: true,
              value: {
                ...planForPanel(plan),
                cli,
                // 确认令牌：绑到"这批会话 + 这个模式 + 这个附件开关"上。
                // `execute` 必须原样带回，且只能用一次、5 分钟内有效。
                confirmToken: issueConfirmToken(planDigest(plan, { attachments, mode })),
              },
            });
            return;
          }

          if (endpoint === 'execute') {
            const attachments = body.payload?.attachments === true;
            const mode = body.payload?.mode === 'hard' ? 'hard' : 'trash';
            const plan = await planCached(attachments);
            // ── 确认令牌校验（在动手之前）──────────────────────────────
            // 为什么需要：这个接口只要有登录 cookie 就能调。同源页面里的任何脚本
            // （包括其它客户端插件）以前可以**一步**直接发 mode:'hard' 把会话不可逆删掉。
            // 现在必须先在 `plan` 里拿到令牌，且令牌绑定"用户实际看过的那一批"。
            // 诚实说明边界：它挡的是"盲目/重放/删用户没看过的那批"，挡不住"能自己
            // 调 plan 的同源脚本"—— 客户端插件本来就有整个页面的权限，这是信任边界，
            // 不是这个令牌能解决的。
            const token = typeof body.payload?.confirmToken === 'string' ? body.payload.confirmToken : '';
            const pending = token === '' ? undefined : confirmTokens.get(token);
            if (pending === undefined || pending.expiresAt < Date.now()) {
              if (pending !== undefined) confirmTokens.delete(token);
              sendRpc(res, rpcId, {
                ok: false,
                error: {
                  code: 'session-purge/confirm-required',
                  message: '缺少或已过期的确认令牌：请刷新页面后，重新点「执行」并确认。',
                },
              });
              return;
            }
            const digest = planDigest(plan, { attachments, mode });
            if (digest !== pending.digest) {
              // 令牌是给另一批会话/另一个模式发的 —— 用户看到的和将要执行的不是一回事。
              confirmTokens.delete(token);
              sendRpc(res, rpcId, {
                ok: false,
                error: {
                  code: 'session-purge/plan-changed',
                  message: '计划已变化（会话集合、模式或附件开关与确认时不同）：请重新确认。',
                },
              });
              return;
            }
            // 一次性：用掉即作废，重放会被上面的分支拒绝。
            confirmTokens.delete(token);

            if (plan.entries.length === 0) {
              sendRpc(res, rpcId, { ok: true, value: { mode, count: 0, trashRoot: null, releasedBytes: 0, note: '没有可清理的归档会话' } });
              return;
            }
            // cleanRoster 保持 false：运行时改 workspace.json 会被内存态覆盖。
            const result = executePlan(plan, { mode, attachments, cleanRoster: false });
            // 删过之后缓存必须作废，下一次计划得重新算。
            invalidatePlanCache();
            sendRpc(res, rpcId, {
              ok: true,
              value: {
                mode: result.mode,
                // 用**实际删掉的**数量：被写锁跳过的、删失败的都不算。
                count: result.results.filter((r) => r.removeError === null).length,
                trashRoot: result.trashRoot,
                releasedBytes: plan.totals.bytes + (attachments ? plan.totals.attachmentBytes : 0),
                // 产出清单写失败以前只在 results 里，面板看不到 —— 面板要把这个显示出来。
                manifestFailures: result.manifestFailures,
                // 单个会话删不动的原因（不影响其它会话）。
                removeFailures: result.removeFailures,
                // 因写锁被跳过的会话（保护，不是失败）。
                skippedLocked: result.skippedLocked,
              },
            });
            return;
          }

          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/unknown-endpoint', message: endpoint } });
        } catch (error) {
          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/internal', message: String(error?.message ?? error) } });
        }
      },
    }), 'session-purge route');
  });
}

export { apply, inject, name };
