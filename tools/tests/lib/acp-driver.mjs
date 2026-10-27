/**
 * dsh-guava-pack/tools/tests/lib/acp-driver.mjs — 隔离进程内的 e2e 驱动（测试专用）。
 *
 * ## 为什么要在 DSH 进程内跑
 *
 * 引擎住在 **preset realm**：只有真正创建一个挂了 preset 的 Agent，才能拿到
 * `ctx.agentPresets.serviceFor(agent, 'compaction')` 背后那个实例，并走
 * `ctx.tools.get(name, agent)` 执行模型可见的工具。这些都无法从进程外伪造。
 *
 * 所以 P4 的验收方式是：临时 DSH_HOME + 一个「驱动插件」patch 行，驱动插件在
 * app 就绪后自己做：
 *   1. 创建一个挂了 standard preset 的 Agent；
 *   2. 往它的 session 里 append 一段可控历史（只有 user/message，工具配对天然平衡）；
 *   3. 用真实工具定义执行 compress / decompress / search_context / acp_status；
 *   4. 断言 session 日志里的 `compaction/start|summary|end` 与账本；
 *   5. 把结果写 JSON 后直接退出进程。
 *
 * ## 为什么不需要模型 / API key
 *
 * Agent 的 provider/model 故意设成不存在的路由：一旦有任何代码路径真的去调
 * `ctx.llm.stream()`（例如 `summarize()` 没有取到模型自写摘要），compress 会**失败**。
 * 因此「compress 成功」本身就是「零额外 LLM 调用」的硬证据。
 *
 * 该文件由 `tools/tests/acp-e2e.mjs` 通过 `--patch` 叠加挂载，不随包分发使用。
 *
 * @module tools/tests/lib/acp-driver
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'acp-e2e-driver';
export const inject = ['agents', 'agentPresets', 'tools', 'sessions'];

/** 每个种子消息带一个唯一 token，供 search_context / decompress 断言。
 *
 * 消息必须足够长：引擎在提交前会校验「framed 摘要 token < 被压原文 token」，
 * 三条几十字的中文消息只有几十 token，光 checkpoint 框架就超过它 —— 压不动。
 * 这里每条约 200+ 字，压三条 ≈ 600 token，摘要 + 框架稳稳更小。
 */
const SEED_MESSAGES = [
  '项目代号 ORCHID-11。构建命令是 `pnpm build`，产物落在 dist/ 目录；发布前必须先跑 `pnpm test:orchid`。'
    + '构建脚本在 scripts/build.ts，环境变量 ORCHID_ENV=staging|prod 控制目标；构建缓存目录 .orchid-cache 不要提交。'
    + 'CI 使用 Node 22，本地若用 Node 20 会出现 ESM 解析差异，请以 CI 为准。',
  '数据库迁移用 scripts/migrate-2026.ts，失败码是 E_MIGRATE_LOCKED，表示上一个迁移事务没释放 advisory lock。'
    + '处理办法：先执行 SELECT pg_advisory_unlock_all()，再重跑迁移；不要在 E_MIGRATE_LOCKED 状态下重启服务。'
    + '迁移目录按时间戳排序，2026_10_01_* 这一批是新增的索引，回滚脚本在 down/ 子目录。',
  '接口超时阈值定为 4500ms，来自运维工单 OPS-7781。这个值同时写进了网关配置 gateway/timeouts.yaml 与前端 fetch 封装。'
    + '超过阈值返回 code=TIMEOUT_ORCHID，前端展示“网络繁忙请重试”。不要把阈值调回 3000ms，那是旧工单 OPS-6120 的结论，已经被覆盖。',
  '用户要求：所有错误信息必须带稳定 code，禁止吞异常。前端提示文案可以变，code 不能变；日志里必须出现 code 与 traceId。'
    + '线上排查第一步是 grep code；如果没有 code，按 P1 事故处理。',
  '回归用例在 tests/regression/orchid.spec.ts，命令 pnpm test:orchid。用例覆盖登录、迁移、超时与回滚四个场景。'
    + '新增用例必须带 fixture，不允许联网；跑全量大约 90 秒，CI 上并行两个 worker。',
  '最后一条任务：把验收报告写进 HANDOFF-acp.md，包含门禁用例、回滚步骤与已知限制。',
];


/**
 * 驱动入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ report?: string, cwd?: string, scenario?: string }} config
 */
export function apply(ctx, config = {}) {
  const reportFile = config.report;
  const workDir = config.cwd;
  const scenario = config.scenario ?? 'full';
  if (typeof reportFile !== 'string' || typeof workDir !== 'string') {
    throw new Error('acp-e2e-driver: report/cwd 配置缺失');
  }

  const report = { scenario, startedAt: new Date().toISOString(), steps: [], ok: false };

  const step = (name, value) => {
    report.steps.push({ name, ...(value === undefined ? {} : { value }) });
  };

  /** 断言：失败即记 step 并抛错，由外层收口成 { ok:false }。 */
  const assert = (condition, name, detail) => {
    if (!condition) throw new Error(`ASSERT ${name}: ${detail ?? 'failed'}`);
    step(name, detail ?? true);
  };

  /** 取工具定义（按 agent 作用域解析：全局注册的层 + 该 agent 的 scoped 层）。 */
  const toolOf = (toolName) => {
    const definition = ctx.tools.get(toolName, ctx.get('agents').get(report.sessionId) ?? undefined);
    return definition;
  };

  const runTool = async (toolName, agent, args) => {
    const definition = ctx.tools.get(toolName, agent);
    if (definition === undefined) throw new Error(`tool ${toolName} not found in agent scope`);
    const exec = { agent, signal: new AbortController().signal };
    return definition.execute(args, exec);
  };

  /** 等 app 装配完成后再动：避免和 loader 的对齐赛跑。 */
  setTimeout(() => {
    void (async () => {
      try {
        await runScenario();
        report.ok = true;
      } catch (error) {
        report.error = String(error?.stack ?? error);
      } finally {
        report.finishedAt = new Date().toISOString();
        try {
          writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        } catch {
          /* 报告写不出去也只能靠 stderr */
        }
        // 测试进程由本驱动收尾：web app 会一直挂着，不退出脚本会超时。
        process.exit(report.ok ? 0 : 1);
      }
    })();
  }, 700).unref?.();

  async function runScenario() {
    const agents = ctx.get('agents');
    const presets = ctx.get('agentPresets');
    assert(agents !== undefined, 'agents service 存在');
    assert(presets !== undefined, 'agentPresets service 存在');

    // 回滚场景：生成器用 --backend basic 重生成（preset 行换回内置 compaction-basic），
    // 根插件因 runtime.json backend=basic 而保持惰性。这里只做结构/能力断言 ——
    // 内置引擎的行为由上游保证，本插件不该、也无法在回滚模式下接管。
    if (scenario === 'rollback') {
      const inspections = presets.inspectCompositions();
      const summary = inspections.map((inspection) => ({
        id: inspection.id,
        basicRows: (inspection.modules ?? []).filter((module) => String(module?.moduleName ?? '') === '@deepseek-ai/dsh-compaction-basic').length,
        acpRows: (inspection.modules ?? []).filter((module) => String(module?.moduleName ?? '').includes('dsh-context-acp/engine')).length,
        leaked: [...(inspection.leakedServices ?? [])],
      }));
      step('rollbackPresets', summary);
      assert(summary.length >= 4, '回滚后仍有 4 个 preset revision', summary.length);
      assert(summary.every((item) => item.basicRows >= 1), '每个 preset 都挂回 @deepseek-ai/dsh-compaction-basic', JSON.stringify(summary));
      assert(summary.every((item) => item.acpRows === 0), '没有任何 preset 还挂着 dsh-context-acp/engine', JSON.stringify(summary));
      assert(summary.every((item) => !item.leaked.includes('compaction')), 'compaction 未泄漏出 isolate', JSON.stringify(summary));
      const toolNames = (ctx.get('tools')?.schemas?.() ?? []).map((schema) => schema?.name);
      const acpTools = ['compress', 'decompress', 'search_context', 'acp_status'].filter((name) => toolNames.includes(name));
      step('rollbackTools', acpTools);
      assert(acpTools.length === 0, '回滚后根插件惰性：不再注册 ACP 工具', JSON.stringify(acpTools));
      return;
    }

    mkdirSync(workDir, { recursive: true });
    const sessionId = `session-acp-e2e-${randomUUID()}`;
    report.sessionId = sessionId;

    // ── 1. 创建挂了 standard preset 的 Agent（与 web 会话控制器同一路径） ──
    const handle = await agents.create({
      sessionId,
      // 故意用不存在的路由：任何真实 LLM 调用都会失败 —— 这是"零额外调用"的证明装置。
      agentOptions: { provider: 'acp-e2e-none', model: 'acp-e2e-none' },
      meta: { cwd: workDir, agentPreset: 'standard' },
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, 'standard');
      },
    });
    const agent = handle.agent;
    report.agentPreset = presets.composedPreset(agent.ctx) ?? null;

    // ── 2. 引擎确实来自 preset realm ──
    const engine = presets.serviceFor(agent, 'compaction');
    assert(engine !== undefined, 'preset realm 里取到 compaction 实例');
    step('engineConstructor', engine?.constructor?.name ?? null);
    assert(engine?.constructor?.name === 'AcpEngine', '引擎是 AcpEngine', engine?.constructor?.name);

    const session = agent.session;

    // ── 3. 种一段可控历史：一个 open turn + 6 条 user 消息 ──
    const turnStart = session.append('turn/start', { turn: 1 });
    step('turnStartSeq', turnStart.seq);
    const seededSeqs = [];
    for (const text of SEED_MESSAGES) {
      // 注意：`session.append()` 返回的是完整事件（不是 seq 数字），取 `.seq`。
      seededSeqs.push(session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' }).seq);
    }
    report.seededSeqs = seededSeqs;
    step('seededSurface', { nodes: [...session.surface.nodes], seeded: seededSeqs.length });

    // ── 4. acp_status 能读（工具注册 + 引擎解析的端到端证据） ──
    const status0 = await runTool('acp_status', agent, {});
    assert(status0?.ok === true, 'acp_status 返回 ok', JSON.stringify(status0).slice(0, 300));

    // ── 5. 屏障：包含「最新用户消息」的区间必须被拒绝 ──
    const lastUserSeq = seededSeqs[seededSeqs.length - 1];
    const blocked = await runTool('compress', agent, {
      startSeq: seededSeqs[seededSeqs.length - 2],
      endSeq: lastUserSeq,
      summary: '试图压掉当前用户消息',
    });
    step('protectedAttempt', blocked);
    assert(blocked?.ok === false && blocked?.code === 'protected', '最新用户消息被拒绝（protected）', JSON.stringify(blocked));

    // ── 6. 正常压缩中间 3 条（不含最新用户消息） ──
    const summaryText = [
      '## 已确认事实',
      '- 项目代号 ORCHID-11；构建 `pnpm build`；数据库迁移脚本 scripts/migrate-2026.ts，失败码 E_MIGRATE_LOCKED。',
      '- 接口超时阈值 4500ms（工单 OPS-7781）；所有错误必须带稳定 code。',
    ].join('\n');
    // 压力必须真的下降：用宿主 tokenMeter 的 surface 估算（与账本同一把尺子），
    // 压缩前 / 压缩后各量一次。这比"事件出现"更接近验收语义。
    const meter = ctx.get('tokenMeter');
    const surfacePressure = () => {
      try {
        return meter?.measure?.(session)?.totalTokens ?? null;
      } catch {
        return null;
      }
    };
    const pressureBefore = surfacePressure();
    const compressArgs = { startSeq: seededSeqs[1], endSeq: seededSeqs[3], summary: summaryText, verifiedReadings: ['ORCHID-11'] };
    const compressed = await runTool('compress', agent, compressArgs);
    step('compressResult', compressed);
    assert(compressed?.ok === true, 'compress 成功（且无 LLM 可用 → 零额外调用）', JSON.stringify(compressed));
    report.compactionId = compressed.compactionId ?? null;
    report.shadowedTokens = compressed.shadowedTokens ?? null;
    const pressureAfter = surfacePressure();
    step('pressureDrop', { before: pressureBefore, after: pressureAfter });
    if (typeof pressureBefore === 'number' && typeof pressureAfter === 'number') {
      assert(pressureAfter < pressureBefore, 'compress 后上下文压力下降', `${pressureBefore} -> ${pressureAfter}`);
    } else {
      assert(compressed?.ok === true, '拿不到 tokenMeter 时至少压缩成功（压力下降由 shadowedTokens 体现）');
    }

    // ── 7. 日志契约：start/summary/end 三件套、摘要文本 == 模型写的、无 llmStreamCall ──
    const events = session.snapshotEvents();
    const starts = events.filter((event) => event.type === 'compaction/start');
    const summaries = events.filter((event) => event.type === 'compaction/summary');
    const ends = events.filter((event) => event.type === 'compaction/end');
    assert(starts.length === 1, 'compaction/start 出现一次', starts.length);
    assert(summaries.length === 1, 'compaction/summary 出现一次', summaries.length);
    assert(ends.length === 1 && ends[0].data.error === undefined, 'compaction/end 出现一次且无 error', ends.length);
    const summaryEvent = summaries[0];
    const summaryTextInLog = (summaryEvent.data.summary ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    assert(summaryTextInLog.includes('ORCHID-11'), '日志里的摘要就是模型写的那份', summaryTextInLog.slice(0, 120));
    assert(summaryEvent.data.llmStreamCall === undefined, '摘要事件无 llmStreamCall（未走 ctx.llm.stream）', String(summaryEvent.data.llmStreamCall));
    step('compactionEvent', {
      compactionId: summaryEvent.data.compactionId,
      shadowedRange: summaryEvent.data.shadowedRange,
      shadowedSeqs: summaryEvent.data.shadowedSeqs,
      shadowedTokenCount: summaryEvent.data.shadowedTokenCount,
      provider: summaryEvent.data.provider,
      model: summaryEvent.data.model,
    });
    report.summaryEvent = {
      shadowedSeqs: summaryEvent.data.shadowedSeqs,
      shadowedTokenCount: summaryEvent.data.shadowedTokenCount,
    };

    // ── 8. 第二次压缩（压 checkpoint 节点 → tier 2；B 阶段后由 ledger 断言） ──
    if (scenario === 'full') {
      // checkpoint 替换了 seededSeqs[1..3]，现在 surface 上该位置是新的 user/message
      const surface = [...session.surface.nodes];
      const checkpointSeq = surface.find((seq) => session.eventAt(seq)?.data?.source?.kind === 'compact-checkpoint');
      step('checkpointSeq', checkpointSeq ?? null);
      assert(checkpointSeq !== undefined, 'surface 上出现 checkpoint 节点');
      // 再压掉 checkpoint + 它后面那条（要保证边界平衡；只有 user 消息时天然平衡）
      const checkpointIdx = surface.indexOf(checkpointSeq);
      if (checkpointIdx >= 0 && checkpointIdx + 1 < surface.length - 1) {
        const second = await runTool('compress', agent, {
          startSeq: checkpointSeq,
          endSeq: surface[checkpointIdx + 1],
          summary: '## 二次蒸馏\n- ORCHID-11 / E_MIGRATE_LOCKED / OPS-7781 / 4500ms 全部保留。',
        });
        step('tier2Compress', second);
        assert(second?.ok === true, '二次压缩（压 checkpoint）成功', JSON.stringify(second));
        report.tier2 = { tier: second.tier, compactionId: second.compactionId };
      }
    }

    // ── 8.5 注入行屏障：AGENTS.md 当前副本 / skill 目录被拒 ──
    // 真实宿主里这两类消息由 dsh-agent-instructions / dsh-tool-skill 以
    // user/message + source.kind 注入；这里手工 append 等价的一条，验证屏障按
    // 「当前副本」而不是「文本里提过」判定。
    if (scenario === 'full') {
      const instructionsSeq = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '<system-reminder>工作区指令：改动前先跑测试。</system-reminder>' }],
        source: { kind: 'agent-instructions', form: 'instructions', baseline: true, changes: [] },
      }), { surfaceOp: 'append' }).seq;
      const instrAttempt = await runTool('compress', agent, {
        startSeq: instructionsSeq,
        endSeq: instructionsSeq,
        summary: '试图压掉 AGENTS.md 当前副本',
      });
      step('instructionsBarrier', instrAttempt);
      assert(
        instrAttempt?.ok === false && instrAttempt?.code === 'protected' && String(instrAttempt?.message ?? '').includes('protected-agent-instructions'),
        'AGENTS.md 当前副本被拒绝（protected-agent-instructions）',
        JSON.stringify(instrAttempt),
      );

      const skillSeq = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '<system-reminder>\n<available_skills>\n- agent-experience\n</available_skills>\n</system-reminder>' }],
        source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
      }), { surfaceOp: 'append' }).seq;
      const skillAttempt = await runTool('compress', agent, {
        startSeq: skillSeq,
        endSeq: skillSeq,
        summary: '试图压掉 skill 目录',
      });
      step('skillBarrier', skillAttempt);
      assert(
        skillAttempt?.ok === false && skillAttempt?.code === 'protected' && String(skillAttempt?.message ?? '').includes('protected-skill-catalog'),
        'skill 目录最新副本被拒绝（protected-skill-catalog）',
        JSON.stringify(skillAttempt),
      );
    }

    // ── 8.6 nudge：压力到阈值时提醒模型，但**不自动压** ──
    // 不能 dispatch 完整的 `agent/pre-step` waterfall：真实宿主里还有
    // `dsh-agent-instructions` / `dsh-tool-skill` 等监听器，它们假设 payload 来自
    // 真实 agent-loop（合法 messages/signal/请求上下文），合成 payload 会先被它们
    // 按真实假设炸掉。所以这里 import 生产用的同一个 handler 工厂（createNudgeHandler），
    // 直接调用「installNudge 注册的那个函数」——注入逻辑与生产完全一致，只跳过注册。
    if (scenario === 'full') {
      const { createNudgeHandler } = await import(new URL('../../../plugins/dsh-context-acp/lib/nudge.mjs', import.meta.url).href);
      const handler = createNudgeHandler({
        ctx,
        runtime: {
          nudge: { pressureRatio: 0.65, growthTokens: 12000, cooldownSteps: 6, maxPerTurn: 2, minFreeTokens: 20000 },
        },
        logger: ctx.logger,
        resolveEngine: (target) => presets.serviceFor(target, 'compaction'),
        tokenMeter: () => ctx.get('tokenMeter'),
      });
      const countSummaries = () => session.snapshotEvents().filter((event) => event.type === 'compaction/summary').length;
      const before = countSummaries();
      const decision = await handler(
        { agent, messages: [], turn: 1, step: 20, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [] }),
      );
      const injected = (decision?.messages ?? []).filter((message) => message?.role === 'user');
      const nudgeTexts = injected
        .map((message) => (message.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n'))
        .filter((text) => typeof text === 'string' && text.includes('[acp-nudge]'));
      step('nudge', {
        injected: nudgeTexts.length,
        sourceKind: injected.at(-1)?.source?.kind ?? null,
        text: nudgeTexts[0]?.slice(0, 200) ?? null,
      });
      assert(decision?.kind === 'enter', 'pre-step 决策仍是 enter（nudge 不改变控制流）', decision?.kind);
      assert(nudgeTexts.length === 1, 'pre-step 注入了一条 [acp-nudge] 提醒', nudgeTexts.length);
      assert(injected.at(-1)?.source?.kind === 'context-acp', '提醒消息带合法 source（agent-loop 会写日志）', injected.at(-1)?.source?.kind);
      const after = countSummaries();
      step('autoCompaction', { before, after });
      assert(after === before, 'nudge 之后没有自动压缩（compactIfNeeded(pressure) 只提醒）', `${before} -> ${after}`);
      // 引擎层的直接证据：常规压力返回 null（不自动压）。
      const autoResult = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
      step('compactIfNeededPressure', autoResult === null ? 'null' : 'non-null');
      assert(autoResult === null, 'compactIfNeeded(pressure) 返回 null', String(autoResult === null));
    }

    // ── 9. 恢复/检索/账本：P2 起生效；P1 阶段只记录不判死 ──
    if (scenario === 'full') {
      const status = await runTool('acp_status', agent, {});
      report.status = status;
      const decompressed = await runTool('decompress', agent, { block: 'b1', limit: 10 });
      report.decompress = decompressed;
      const searched = await runTool('search_context', agent, { query: 'ORCHID-11', scope: 'all' });
      report.search = searched;
      // P1（账本未实现）时这些可能是 not-implemented；P2/P4 由 Lead 的 e2e 门禁改成硬断言。
      step('restoreTools', {
        statusOk: status?.ok,
        blocks: status?.blocks?.length ?? null,
        decompressOk: decompressed?.ok,
        searchHits: searched?.hits?.length ?? null,
      });
    }

    // 关闭 turn（保持日志事件形状干净；driver 随后直接退出进程）
    try {
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    } catch (error) {
      step('turnEndError', String(error?.message ?? error));
    }

    void toolOf;
  }
}
