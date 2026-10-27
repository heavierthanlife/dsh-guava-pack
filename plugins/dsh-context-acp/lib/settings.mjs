/**
 * dsh-context-acp — 设置落盘 + 面板 HTTP 路由 + 会话投影（C 负责）。
 *
 * ## 参考实现
 *
 * `dsh-context-guard`（playground/themes/dsh-context-guard/index.js）已验证过这条
 * 通路：`ctx.inject(['webServer','connection'])` → `webServer.register({kind:'prefix',
 * path, handler})`，入口用 `connection.requestRejection({headers})` 套 Host/Origin
 * 围栏与浏览器鉴权，body 是 `{type:'client-request', method, payload, rpcId}` 信封，
 * 回包 `{type:'server-response', rpcId, result:{ok, value|error}}`。照抄，不另发明。
 *
 * ## 为什么要有投影，而不是客户端直接问路由
 *
 * composer dock 的 slot 渲染 props 只有 `{useProjection, t}` —— 没有 sessionId。
 * 所以「每会话的块数 / 最高 tier / 被压 tokens」必须由宿主注册成 session
 * projection（key=`contextAcp`），客户端用 `useProjection('contextAcp')` 读取。
 * 可调参数与「上次 nudge」是进程级信息，才走 HTTP 路由。
 *
 * ## 投影必须纯、可重放
 *
 * `apply` 是 reduce 的一步：同样的日志重放必须得到同样的 state。所以：
 *   - 不读 `Date.now()`（用 `event.time`，缺失就 0）；
 *   - 不加随机数、不写外部状态；
 *   - 只为 `compaction/summary` 返回新对象，其它事件原样返回同一引用（注册表靠
 *     `Object.is` 抑制无谓的 view 重算）。
 *
 * ## 落盘失败必须可见
 *
 * 写盘失败不能只吞掉：回包带 `saved:false, saveError`，面板显示。本次设置仍然
 * 生效（写回的是共享 runtime 引用），只是重启后会丢掉。
 *
 * @module dsh-context-acp/settings
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { latestNudgeOf } from './state.mjs';

import { z } from 'zod';

/** 面板路由前缀（client.js 必须用同一个）。 */
export const ROUTE_PATH = '/context-acp';

/** 可从面板修改的字段白名单（其余一律忽略，避免客户端写坏配置）。 */
export const TUNABLE_KEYS = Object.freeze(['nudge.pressureRatio', 'nudge.growthTokens', 'retain.decompressPageSize', 'retain.searchLimit']);

/** 与 config/acp.json 一致的兜底值（settings 不能 import 根 index，避免循环）。 */
const DEFAULTS = Object.freeze({
  pressureRatio: 0.65,
  growthTokens: 12000,
  decompressPageSize: 8,
  searchLimit: 20,
});

/** 投影 wire 字段（客户端只看到这七个）。 */
const ACP_STATE_SCHEMA = z.object({
  blocks: z.number().int().nonnegative(),
  tierMax: z.number().int().nonnegative(),
  shadowedTokens: z.number().nonnegative(),
  lastAt: z.number().nonnegative(),
  lastProvider: z.string(),
  lastModel: z.string(),
  lastCompactionId: z.string(),
  // 内部字段：tier 推导需要回看既有块的 summarySeq。wire view 不暴露它。
  blockSeqs: z.array(z.object({
    tier: z.number().int().positive(),
    summarySeq: z.number().int().nonnegative(),
  })),
});

const ACP_VIEW_SCHEMA = z.object({
  blocks: z.number().int().nonnegative(),
  tierMax: z.number().int().nonnegative(),
  shadowedTokens: z.number().nonnegative(),
  lastAt: z.number().nonnegative(),
  lastProvider: z.string(),
  lastModel: z.string(),
  lastCompactionId: z.string(),
});

/**
 * 设置文件路径：`$DSH_HOME/context-acp.json`（与 context-guard 同一约定）。
 * @returns {string}
 */
export function settingsFile() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', 'dsh');
  return join(home, 'context-acp.json');
}

/** 有限数？ */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 从 payload 读一个白名单字段：接受嵌套（{nudge:{...}}）与扁平两种形状。 */
function readTunable(payload, section, key) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const nested = payload[section];
  const candidates = [
    nested !== null && typeof nested === 'object' ? nested[key] : undefined,
    payload[key],
  ];
  for (const value of candidates) {
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

/**
 * 夹取阈值：0.2–0.95，四舍五入到 0.05 档。
 * 非正数/非有限值视为非法（返回 undefined，调用方保留原值）。
 */
function clampRatio(value) {
  if (!isFiniteNumber(value) || value <= 0) return undefined;
  const clamped = Math.min(0.95, Math.max(0.2, value));
  return Math.min(0.95, Math.max(0.2, Math.round(clamped * 20) / 20));
}

/** 夹取整数：范围 [min,max]，非正数/非有限值视为非法。 */
function clampInteger(value, min, max) {
  if (!isFiniteNumber(value) || value <= 0) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 读当前 runtime 的四个可调项（缺失用默认值）。 */
function tunablesOf(runtime) {
  return {
    pressureRatio: isFiniteNumber(runtime?.nudge?.pressureRatio) ? runtime.nudge.pressureRatio : DEFAULTS.pressureRatio,
    growthTokens: isFiniteNumber(runtime?.nudge?.growthTokens) ? runtime.nudge.growthTokens : DEFAULTS.growthTokens,
    decompressPageSize: isFiniteNumber(runtime?.retain?.decompressPageSize) ? runtime.retain.decompressPageSize : DEFAULTS.decompressPageSize,
    searchLimit: isFiniteNumber(runtime?.retain?.searchLimit) ? runtime.retain.searchLimit : DEFAULTS.searchLimit,
  };
}

/**
 * 把面板提交的白名单字段应用到一个**新的** runtime 对象。
 *
 * 纯函数：不修改入参、不碰 deps、不写盘。调用方（setSettings）负责把返回值
 * 写回共享 `deps.runtime`，工具与 nudge 下一拍就生效。
 *
 * 夹取规则见 {@link clampRatio}/{@link clampInteger}；非法值忽略（保留原值），
 * 合法但越界的值夹到边界 —— 面板的步进器只产生合法值，越界通常是手改文件或
 * 旧客户端，夹取比报错更符合"设置面板"的语义。
 *
 * @param {object} runtime 当前配置
 * @param {object} payload 客户端提交的字段（嵌套或扁平均可）
 * @returns {{ runtime: object, changed: object }}
 */
export function applyTunables(runtime, payload) {
  const base = runtime !== null && typeof runtime === 'object' ? runtime : {};
  const nudge = base.nudge !== null && typeof base.nudge === 'object' ? base.nudge : {};
  const retain = base.retain !== null && typeof base.retain === 'object' ? base.retain : {};

  const nextRatio = clampRatio(readTunable(payload, 'nudge', 'pressureRatio'));
  const nextGrowth = clampInteger(readTunable(payload, 'nudge', 'growthTokens'), 1000, 100000);
  const nextPageSize = clampInteger(readTunable(payload, 'retain', 'decompressPageSize'), 1, 50);
  const nextSearchLimit = clampInteger(readTunable(payload, 'retain', 'searchLimit'), 1, 50);

  const changed = {};
  const nudgePatch = {};
  const retainPatch = {};

  if (nextRatio !== undefined && nextRatio !== nudge.pressureRatio) {
    nudgePatch.pressureRatio = nextRatio;
    changed.pressureRatio = nextRatio;
  }
  if (nextGrowth !== undefined && nextGrowth !== nudge.growthTokens) {
    nudgePatch.growthTokens = nextGrowth;
    changed.growthTokens = nextGrowth;
  }
  if (nextPageSize !== undefined && nextPageSize !== retain.decompressPageSize) {
    retainPatch.decompressPageSize = nextPageSize;
    changed.decompressPageSize = nextPageSize;
  }
  if (nextSearchLimit !== undefined && nextSearchLimit !== retain.searchLimit) {
    retainPatch.searchLimit = nextSearchLimit;
    changed.searchLimit = nextSearchLimit;
  }

  return {
    runtime: {
      ...base,
      ...(Object.keys(nudgePatch).length > 0 ? { nudge: { ...nudge, ...nudgePatch } } : {}),
      ...(Object.keys(retainPatch).length > 0 ? { retain: { ...retain, ...retainPatch } } : {}),
    },
    changed,
  };
}

/**
 * 读回上次落盘的设置（文件优先于生成配置）。
 *
 * 深合并两层：落盘只写 `{nudge:{pressureRatio,growthTokens}, retain:{...}}`，
 * 不能因此丢掉 runtime 里的 `cooldownSteps` / `protect*` 等只读字段。
 * 读回后再走一遍 {@link applyTunables}，坏值自动夹回合法区间。
 *
 * @param {object} runtime 当前 runtime 配置
 * @returns {Promise<object>} 合并后的配置（失败时原样返回 runtime）
 */
export async function loadSavedSettings(runtime) {
  try {
    const saved = JSON.parse(await readFile(settingsFile(), 'utf8'));
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return runtime;

    const merged = { ...runtime };
    for (const section of ['nudge', 'retain', 'engine']) {
      const patch = saved[section];
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue;
      const base = runtime?.[section];
      merged[section] = { ...(base !== null && typeof base === 'object' ? base : {}), ...patch };
    }
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'nudge' || key === 'retain' || key === 'engine') continue;
      merged[key] = value;
    }
    // 落盘值也可能被手改坏：用与面板相同的夹取路径兜底。
    return applyTunables(merged, merged).runtime;
  } catch {
    // 没文件/坏文件：用生成配置（不要因为面板没保存过就报错）。
    return runtime;
  }
}

/** 读一个小请求体（有上限，坏客户端不能拖住内存）。 */
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

/** 注册 `contextAcp` 投影（纯 fold 会话日志）。 */
function registerProjection(cctx) {
  cctx.sessionProjections.register({
    key: 'contextAcp',
    stateVersion: 1,
    stateSchema: ACP_STATE_SCHEMA,
    init: () => ({
      blocks: 0,
      tierMax: 0,
      shadowedTokens: 0,
      lastAt: 0,
      lastProvider: '',
      lastModel: '',
      lastCompactionId: '',
      blockSeqs: [],
    }),
    apply: (state, event) => {
      // 只关心成功的压缩摘要。失败压缩（只有 start）不产生块，也不该被计数。
      if (event?.type !== 'compaction/summary') return state;

      const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
      const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];

      // tier：新块压掉了某个既有块的 checkpoint 节点时，tier = 被压块 tier + 1。
      // 日志契约里 checkpoint 节点紧跟在它的 compaction/summary 之后（seq+1），
      // 所以只用 summarySeq 就能在没有事件索引的情况下判断"是否包含旧块"。
      let parentTier = 0;
      for (const entry of state.blockSeqs) {
        if (shadowedSeqs.includes(entry.summarySeq + 1)) parentTier = Math.max(parentTier, entry.tier);
      }
      const tier = parentTier + 1;

      const shadowedTokens = isFiniteNumber(data.shadowedTokenCount) ? data.shadowedTokenCount : 0;
      const compactedAt = isFiniteNumber(event.time) ? event.time : 0;
      const summarySeq = isFiniteNumber(event.seq) ? event.seq : 0;

      return {
        ...state,
        blocks: state.blocks + 1,
        tierMax: Math.max(state.tierMax, tier),
        shadowedTokens: state.shadowedTokens + shadowedTokens,
        lastAt: compactedAt,
        lastProvider: typeof data.provider === 'string' ? data.provider : state.lastProvider,
        lastModel: typeof data.model === 'string' ? data.model : state.lastModel,
        lastCompactionId: typeof data.compactionId === 'string' ? data.compactionId : state.lastCompactionId,
        blockSeqs: [...state.blockSeqs, { tier, summarySeq }],
      };
    },
    wire: {
      viewSchema: ACP_VIEW_SCHEMA,
      // 只暴露客户端需要的字段；blockSeqs 是内部推导状态。
      view: (state) => ({
        blocks: state.blocks,
        tierMax: state.tierMax,
        shadowedTokens: state.shadowedTokens,
        lastAt: state.lastAt,
        lastProvider: state.lastProvider,
        lastModel: state.lastModel,
        lastCompactionId: state.lastCompactionId,
      }),
    },
  });
}

/**
 * 安装面板数据通路：投影 + 设置读写路由。
 *
 * 面板读的权威值：
 *   · `tunables`：阈值 / 增长 tokens / 分页 / 检索上限（可调，白名单夹取）
 *   · `armed`：根插件已挂载即 armed（真正的引擎能力由 nudge 的 pre-step 检查）
 *   · `lastNudge`：HTTP 路由没有 sessionId，无法按 agent 取；给**本进程最近一次**
 *     nudge（state.mjs 的 latestNudgeOf），没有就 null（面板显示「本进程暂无记录」），
 *     绝不伪造一个时间。
 *
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {() => void} disposer
 */
export function installPanel(deps) {
  const { ctx } = deps;

  /**
   * 启动时读回上次落盘的设置（文件优先于生成配置）。
   *
   * 根 index.js 只读 config/runtime.json（Lead 独占文件，不改），所以「面板保存
   * 后重启仍生效」必须由这里完成。异步加载不阻塞插件激活；用 epoch 防止一个
   * 极早到达的 setSettings 被迟到的读盘结果覆盖（后者读到的是旧文件）。
   */
  let settingsEpoch = 0;
  void (async () => {
    const loaded = await loadSavedSettings(deps.runtime);
    if (settingsEpoch === 0 && loaded !== deps.runtime) deps.runtime = loaded;
  })().catch(() => {
    // loadSavedSettings 自己吞掉读盘/坏文件错误；这里只兜住理论上的意外，
    // 不让一个异步设置加载变成 unhandled rejection 拖垮进程。
  });

  // 1) 每会话投影：客户端 pill 的唯一每会话数据源。
  const projectionFiber = ctx.inject(['sessionProjections'], (cctx) => {
    registerProjection(cctx);
  });

  // 2) 面板设置路由：照 context-guard 的信封与围栏。
  const routeFiber = ctx.inject(['webServer', 'connection'], (cctx) => {
    // 挂在 effect 上：webServer.register 返回 disposer；不登记的话插件重挂会留下
    // 旧路由，再注册直接抛 `duplicate prefix route`，且真正生效的是旧闭包。
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
          if (body !== null && typeof body === 'object' && typeof body.rpcId === 'string') rpcId = body.rpcId;
          if (endpoint === '' || body === null || typeof body !== 'object' || body.type !== 'client-request' || body.method !== endpoint) {
            sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request envelope' } });
            return;
          }

          if (endpoint === 'getSettings') {
            sendRpc(res, rpcId, {
              ok: true,
              value: {
                version: 1,
                backend: deps.runtime?.backend ?? 'acp',
                // 根插件已挂载（backend=acp）才注册本路由；引擎实例的能力由
                // nudge 在 pre-step 里用 markArmed 另行验证。
                armed: true,
                tunables: tunablesOf(deps.runtime),
                lastNudge: typeof latestNudgeOf === 'function' ? latestNudgeOf() : null,
              },
            });
            return;
          }

          if (endpoint === 'setSettings') {
            settingsEpoch += 1;
            const applied = applyTunables(deps.runtime, body.payload ?? {});
            // 写回共享 deps 对象的 runtime 槽位：工具/nudge 下一拍读到的就是新值。
            deps.runtime = applied.runtime;
            const tunables = tunablesOf(deps.runtime);
            try {
              await writeFile(
                settingsFile(),
                `${JSON.stringify({
                  nudge: { pressureRatio: tunables.pressureRatio, growthTokens: tunables.growthTokens },
                  retain: { decompressPageSize: tunables.decompressPageSize, searchLimit: tunables.searchLimit },
                }, null, 2)}\n`,
                'utf8',
              );
            } catch (error) {
              // 本次生效、重启丢失：原因必须回到面板。
              sendRpc(res, rpcId, {
                ok: true,
                value: { saved: false, saveError: String(error?.message ?? error), tunables, changed: applied.changed },
              });
              return;
            }
            sendRpc(res, rpcId, { ok: true, value: { saved: true, tunables, changed: applied.changed } });
            return;
          }

          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/unknown-endpoint', message: endpoint } });
        } catch (error) {
          sendRpc(res, rpcId, { ok: false, error: { code: 'gateway/internal', message: String(error?.message ?? error) } });
        }
      },
    }), 'context-acp: route');
  });

  return () => {
    for (const fiber of [projectionFiber, routeFiber]) {
      try {
        fiber?.dispose?.();
      } catch {
        /* 已随上下文销毁 */
      }
    }
  };
}
