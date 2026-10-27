/**
 * dsh-context-acp — `compress` 工具。
 *
 * ## 契约（不许改形状）
 *
 * 入参：
 *   { startSeq: number, endSeq: number, summary: string, verifiedReadings?: string[] }
 * 出参：
 *   成功 → { ok: true, compactionId, seqs: {start,end}, shadowedTokens, tier }
 *   失败 → { ok: false, code: 'unbalanced'|'protected'|'active'|'missing'|'no-gain'|'busy', message }
 *
 * ## 它必须完成的步骤（顺序是硬的）
 *
 *   1. `inFlight` 去重（同一 agent 不允许并发 compress）。
 *   2. 解析引擎：`deps.resolveEngine(exec.agent)`；拿不到 → `busy`（preset 尚未挂载）。
 *   3. 区间校验：start/end 都在当前 surface、startIdx <= endIdx；
 *      用 `toolPairingBalancedBefore/After` 判工具配对平衡（不平衡 → `unbalanced`）。
 *   4. 屏障校验：`barriers.checkProtectedRange()` → `protected`（点名 seq）。
 *   5. 收益校验：摘要估算 token（宿主 tokenMeter 启发价）>= 被压区间原文估算 → `no-gain`。
 *   6. `engine.stageSummary(agent, { summary, provider, model })` 投递；
 *      再 `await engine.compactRegion(start, end, agent, exec.signal)`。
 *      失败必须 `engine.clearStagedSummary(agent)`（避免串到下一次压缩）。
 *   7. 从返回的 `CompactionResult` 组装出参；`tier` 由 ledger（B）算，P1 可先给 1。
 *
 * ## 为什么校验和事务分成两段
 *
 * `planCompress()` 是纯函数（除了向宿主 meter 问价），只读 surface/日志，
 * 可以在不产生任何持久化副作用的前提下给出稳定错误码。真正的 surface 替换
 * 全部交给父类 `compactRegion()` 的既有事务；本工具不自己 append 任何事件、
 * 不自己估算 shadowedTokens（ACP #54/#103：记账唯一来源是宿主 tokenMeter）。
 *
 * ## 禁止
 *   - 不得自己估算 shadowedTokens（必须用宿主 tokenMeter 的启发价，ACP #54/#103）。
 *   - 不得在失败路径留下 staged summary。
 *
 * @module dsh-context-acp/tools-compress
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { checkProtectedRange } from './barriers.mjs';
import { tierOfShadowedSeqs } from './ledger.mjs';

/** 稳定错误码（工具出参 `code` 直接用这些）。 */
export const COMPRESS_CODES = Object.freeze([
  'unbalanced',
  'protected',
  'active',
  'missing',
  'no-gain',
  'busy',
]);

/** 未标注路由时的摘要来源兜底（`compaction/summary` 要求非空 provider/model）。 */
const UNKNOWN_ROUTE = 'acp';

/**
 * 同一 agent 的压缩去重。
 *
 * 用模块级 WeakSet 而不是引擎实例字段：工具与引擎挂在同一个进程/同一个模块图里，
 * 但工具经由 `ctx.get('agentPresets')` 解析引擎，拿到的实例属于 preset realm；
 * 在工具侧去重才能覆盖"引擎还没解析出来时"的并发窗口。WeakSet 让 agent 销毁后
 * 自动回收，长跑进程不会无界增长。
 */
const inFlight = new WeakSet();

/** 判断是否可用作 provider/model 的非空字符串。 */
function routeString(value) {
  return typeof value === 'string' && value.length > 0 ? value : UNKNOWN_ROUTE;
}

/**
 * 从最新一次已路由请求的 header 里取 provider/model。
 *
 * 为什么不是 `agent.options`：ACP 的账本要记录"这份摘要实际是谁写的"，
 * header 是最近一次真实请求的durable路由，比启动参数更可信。读取失败不致命，
 * 退回 `acp` 占位（日志仍可追溯）。
 *
 * @param {object} agent
 * @returns {{ provider: string, model: string }}
 */
function routeOf(agent) {
  try {
    const config = agent?.session?.requestHeader?.()?.config;
    return { provider: routeString(config?.provider), model: routeString(config?.model) };
  } catch {
    return { provider: UNKNOWN_ROUTE, model: UNKNOWN_ROUTE };
  }
}

/**
 * 纯规划：校验区间并估算收益，不产生任何副作用。
 *
 * @param {object} params
 * @param {import('@deepseek-ai/dsh-session').Session} params.session 目标会话
 * @param {number} params.startSeq 区间首节点 seq（含）
 * @param {number} params.endSeq 区间末节点 seq（含）
 * @param {string} params.summary 模型自写的 checkpoint 摘要
 * @param {object=} params.meter 宿主 tokenMeter（可能不存在）
 * @param {object=} params.policy 保护策略（runtime.retain）
 * @returns {{ ok: true, startIdx: number, endIdx: number, shadowedSeqs: number[], shadowedTokens: number, summaryTokens: number, tier: 1 }
 *   | { ok: false, code: string, message: string }}
 */
export function planCompress({ session, startSeq, endSeq, summary, meter, policy } = {}) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) {
    return { ok: false, code: 'missing', message: '会话 surface 不可用，无法定位压缩区间' };
  }

  // ① 定位下标。用 indexOf 而不是大小比较：compactRegion 的参数是 surface
  // **位置**而不是数值 seq 区间（先前替换会把高 seq 摘要放到更老的位置）。
  const startIdx = nodes.indexOf(startSeq);
  const endIdx = nodes.indexOf(endSeq);
  if (startIdx === -1) {
    return { ok: false, code: 'missing', message: `startSeq ${String(startSeq)} 不在当前 surface 上；先用 acp_status 查看可用区间` };
  }
  if (endIdx === -1) {
    return { ok: false, code: 'missing', message: `endSeq ${String(endSeq)} 不在当前 surface 上；先用 acp_status 查看可用区间` };
  }
  if (startIdx > endIdx) {
    return {
      ok: false,
      code: 'missing',
      message: `startSeq（surface 位置 ${startIdx}）在 endSeq（位置 ${endIdx}）之后，区间反了：startSeq 应是更早的那条`,
    };
  }
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return { ok: false, code: 'missing', message: 'summary 不能为空：请自己写一份信息无损的 checkpoint 摘要' };
  }

  // ② 工具配对：跨过未闭合的 tool-call/result 会把一个 step 劈开，父类也会拒绝。
  // 这里先判是为了给模型一个可读的 stable code，而不是抛父类的英文异常。
  let balanced = false;
  try {
    balanced = toolPairingBalancedBefore(session, startSeq) && toolPairingBalancedAfter(session, endSeq);
  } catch (error) {
    return {
      ok: false,
      code: 'unbalanced',
      message: `无法判定工具调用配对（${String(error?.message ?? error)}）；请避开工具调用边界，换一个区间`,
    };
  }
  if (!balanced) {
    return {
      ok: false,
      code: 'unbalanced',
      message: `区间边界会劈开 tool-call/tool-result 配对（start ${String(startSeq)} / end ${String(endSeq)}）；换一个 step 边界`,
    };
  }

  // ③ 注入行屏障：策略文件/skill 目录/活动用户消息的当前副本不得压缩。
  const guard = checkProtectedRange({ session, startIdx, endIdx, policy });
  if (!guard.ok) {
    const list = guard.protected
      .map((hit) => `seq ${String(hit.seq)}（${hit.code}，${hit.label}）`)
      .join('；');
    return {
      ok: false,
      code: 'protected',
      message: `区间包含受保护节点：${list}。请换一个不包含它的区间（策略文件、skill 目录、当前用户消息不能压缩）`,
    };
  }

  // ④ 收益：摘要必须比原文小，否则压缩只是在给上下文加负担。
  // 父类还会用带 framing 的 checkpoint 消息再判一次（更严格），这里只做前置拦截。
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
  let shadowedTokens = 0;
  let summaryTokens = 0;
  if (typeof meter?.estimateMessage === 'function') {
    try {
      summaryTokens = meter.estimateMessage(createUserMessage({
        content: [{ type: 'text', text: summary }],
      }));
    } catch {
      // 估值不可用就跳过收益检查；父类事务会用同一个 meter 做权威判定。
      summaryTokens = 0;
    }
    // 宿主实现返回 NaN/Infinity 时同样视为"估不出来"，不要拿它做比较。
    if (!Number.isFinite(summaryTokens)) summaryTokens = 0;
  }
  if (typeof meter?.measure === 'function' && typeof meter?.estimateMessage === 'function') {
    let measured;
    try {
      measured = meter.measure(session);
    } catch {
      measured = undefined;
    }
    const priced = measured?.nodes;
    // 形状不符（长度/seq 对不上、token 不是数字）就整段跳过：宁可让父类判，
    // 也不能拿错位的数据做"没有收益"的结论。
    const usable =
      Array.isArray(priced) &&
      priced.length === nodes.length &&
      priced.every((node, index) => node?.seq === nodes[index] && Number.isFinite(node?.tokens));
    if (usable) {
      shadowedTokens = priced
        .slice(startIdx, endIdx + 1)
        .reduce((total, node) => total + node.tokens, 0);
      if (summaryTokens >= shadowedTokens) {
        return {
          ok: false,
          code: 'no-gain',
          message: `摘要估算 ${summaryTokens} tokens >= 被压原文 ${shadowedTokens} tokens；压缩没有收益，请缩短摘要或扩大区间`,
        };
      }
    }
  }

  // ⑤ 通过。
  return { ok: true, startIdx, endIdx, shadowedSeqs, shadowedTokens, summaryTokens, tier: 1 };
}

/**
 * 注册 `compress` 工具。
 * @param {object} deps 见 lib/index.js `makeDeps`
 * @returns {() => void} disposer
 */
export function registerCompressTool(deps) {
  const { ctx } = deps;
  return ctx.tools.register(defineTool({
    name: 'compress',
    description:
      '把较早的一段对话压缩成一条 checkpoint 摘要。先读 acp_status 的 blocks 选一个可压区间，' +
      '自己写摘要（不要调用其它模型），再提交。只压已经过时、可以只靠摘要继续工作的区间；' +
      '不要压缩策略文件（AGENTS.md）、skill 目录（<available_skills>）或当前用户消息所在的区间——' +
      '这些会被拒绝。区间边界必须落在完整的工具调用 step 边界上。',
    parameters: {
      startSeq: { type: 'number', required: true, description: '区间第一个 surface seq（含）。' },
      endSeq: { type: 'number', required: true, description: '区间最后一个 surface seq（含）；必须与工具调用配对平衡。' },
      summary: { type: 'string', required: true, description: '你自己写的 checkpoint 摘要（markdown，信息无损优先、短次之）。' },
      verifiedReadings: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：压缩前你已确认读过/核对过的事实列表，供账本记录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent;
      if (agent === null || typeof agent !== 'object') {
        return { ok: false, code: 'busy', message: 'no agent' };
      }

      const engine = deps.resolveEngine(agent);
      if (engine === undefined || engine === null || typeof engine.stageSummary !== 'function' || typeof engine.compactRegion !== 'function') {
        return { ok: false, code: 'busy', message: 'preset compaction 未就绪' };
      }

      if (inFlight.has(agent)) {
        return { ok: false, code: 'busy', message: '该会话已有一个 compress 正在进行；等它完成后再试' };
      }
      inFlight.add(agent);

      try {
        let plan;
        try {
          plan = planCompress({
            session: agent.session,
            startSeq: args?.startSeq,
            endSeq: args?.endSeq,
            summary: args?.summary,
            meter: deps.tokenMeter?.(),
            policy: deps.runtime?.retain,
          });
        } catch (error) {
          // 规划阶段本不该抛（纯函数），但 meter 的宿主实现可能抛：转成 busy，
          // 避免异常穿透工具框架、中断整个 turn。
          return { ok: false, code: 'busy', message: String(error?.message ?? error) };
        }
        if (!plan.ok) return { ok: false, code: plan.code, message: plan.message };

        const { provider, model } = routeOf(agent);
        engine.stageSummary(agent, { summary: args.summary, provider, model });

        let result;
        try {
          result = await engine.compactRegion(args.startSeq, args.endSeq, agent, exec?.signal);
        } catch (error) {
          // 压缩事务失败：摘要可能还没被 summarize 取走（start 之前就失败），
          // 必须清掉，否则会串到下一次压缩（那次的原文区间完全不同）。
          engine.clearStagedSummary?.(agent);
          const message = String(error?.message ?? error);
          // 父类的「摘要不比原文小」是模型最常犯的错（摘要写太长），
          // 必须回 no-gain 而不是含糊的 busy —— 模型据此知道该缩短摘要而不是重试。
          const code = /summary is not smaller/i.test(message) ? 'no-gain' : 'busy';
          return { ok: false, code, message };
        }

        // 成功路径不清理 staged：summarize() 已 take（取走即删），再清是空操作。
        // tier 由账本判定（Ledger，P2）：被压区间里含旧 checkpoint 节点 → 蒸馏一层。
        // 推导失败不阻断压缩（返回 1 是保守值，不是伪造的成功）。
        let tier = 1;
        try {
          tier = tierOfShadowedSeqs(agent.session, result?.shadowedSeqs ?? []);
        } catch {
          tier = 1;
        }
        return {
          ok: true,
          compactionId: String(result?.compactionId),
          seqs: { start: result?.shadowedRange?.start, end: result?.shadowedRange?.end },
          shadowedTokens: result?.shadowedTokenCount,
          tier,
        };
      } finally {
        inFlight.delete(agent);
      }
    },
  }));
}
