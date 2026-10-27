/**
 * dsh-context-acp — 根平面装配（**Lead 独占文件：子代理不得修改**）。
 *
 * ## 为什么根平面只做「装配」
 *
 * 具体逻辑按写作用域拆成互不重叠的模块（便于并行实现与单独测试）：
 *
 *   lib/engine.mjs          A：引擎子类 + 待用摘要通道（preset realm 内挂载）
 *   lib/barriers.mjs        A：受保护区判定（纯函数）
 *   lib/tools-compress.mjs  A：compress 工具
 *   lib/ledger.mjs          B：从日志重建块账本 / tier / seq 映射（纯函数为主）
 *   lib/tools-restore.mjs   B：decompress + search_context
 *   lib/tools-status.mjs    B：acp_status
 *   lib/nudge.mjs           C：pre-step nudge 策略（纯函数 + 薄事件壳）
 *   lib/prompt.mjs          C：系统提示段（压缩规则/哲学）
 *   lib/command.mjs         C：/acp 命令
 *   lib/settings.mjs        C：设置落盘 + HTTP 路由
 *   client.js               C：面板 pill
 *
 * 本文件只做四件事：读配置、解析每个 agent 的引擎实例、把模块挂上去、
 * 在测试环境写一份挂载探针。**不包含任何压缩业务逻辑。**
 *
 * ## 引擎不在根上下文（这是本设计的关键事实）
 *
 * web 组合里 `dsh-web-app` 把根平面的 `compaction-basic` 显式 disabled ——
 * compaction 是 preset 拥有的能力。所以根平面 `ctx.compaction` 不存在；
 * 正确读法是 `ctx.agentPresets.serviceFor(agent, 'compaction')`（浏览器 RPC 也走它）。
 * 根平面没有 `agentPresets` 的组合（headless / preset-free）才回落到 `ctx.compaction`。
 *
 * @module dsh-context-acp
 */

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

import { registerCompressTool } from './tools-compress.mjs';
import { registerRestoreTools } from './tools-restore.mjs';
import { registerStatusTool } from './tools-status.mjs';
import { installNudge } from './nudge.mjs';
import { installPromptSection } from './prompt.mjs';
import { installCommand } from './command.mjs';
import { installPanel } from './settings.mjs';
import { DEFAULT_HANDOFF, createHandoff } from './handoff.mjs';
import { DEFAULT_FALLBACK } from './fallback.mjs';

/** Cordis 插件名（诊断与 effect 标签用）。 */
const name = 'context-acp';

/** `tools` 是硬依赖：没有注册表本插件什么都不做。其余服务全部可选注入。 */
const inject = ['tools'];

/**
 * runtime 配置的兜底默认值。
 *
 * 为什么不从 YAML 行配置读：阈值/保护开关需要面板可改、需要落盘持久（settings.mjs），
 * 而 YAML 行的 config 只在插件重挂时生效。唯一人工配置源是 `config/acp.json`，
 * 由 `tools/gen-acp-preset.mjs` 生成为 `config/runtime.json`（安装后可直接读）。
 */
const DEFAULT_RUNTIME = Object.freeze({
  backend: 'acp',
  nudge: Object.freeze({
    pressureRatio: 0.65,
    growthTokens: 12000,
    cooldownSteps: 6,
    maxPerTurn: 2,
    minFreeTokens: 20000,
  }),
  retain: Object.freeze({
    decompressPageSize: 8,
    searchLimit: 20,
    searchExcerptChars: 240,
    protectActiveUserMessage: true,
    protectAgentInstructions: true,
    protectSkillCatalog: true,
  }),
  engine: Object.freeze({ fallbackToLlmSummary: true }),
  // 兜底自动压缩（原 dsh-context-guard 的 65% 无条件压缩被替换成"先提醒，再兜底"）：
  // 连续 afterUnansweredNudges 次 nudge 未被响应 且 占用 >= ratio 时，
  // 由 nudge 的 pre-step 调用 engine.compactByFallback()（父类 pressure 策略）。
  fallback: Object.freeze({
    enabled: true,
    ratio: 0.75,
    afterUnansweredNudges: 2,
    /** 兜底失败（没有可压区间）后的节流：N 个 step 内不再试。 */
    retryCooldownSteps: 3,
  }),
  // 交接文档（从 dsh-context-guard 迁移）：压缩达到 N 次后写一份可读 handoff。
  handoff: Object.freeze({
    enabled: true,
    afterCompactions: 2,
    prefix: 'HANDOFF-context-acp',
    maxRecentUserMessages: 8,
  }),
});

/**
 * 深合并两层普通对象（数组按覆盖处理）。
 * 只用于 runtime 配置：缺键用默认、多键保留（前向兼容）。
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
function mergeRuntime(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = base[key];
    out[key] = prev !== null && typeof prev === 'object' && !Array.isArray(prev) && value !== null && typeof value === 'object' && !Array.isArray(value)
      ? mergeRuntime(prev, value)
      : value;
  }
  return out;
}

/**
 * 读生成器写出的 runtime.json。
 *
 * 读到坏文件不静默：退回默认值并 warn —— 配置损坏时「行为变回默认」必须可见。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {object}
 */
function readRuntimeFile(ctx) {
  try {
    // 相对本模块定位：安装后包内路径与开发目录结构一致（config/ 在包根下）。
    const url = new URL('../config/runtime.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      ctx.logger?.warn?.(`[acp] config/runtime.json 读取失败（用默认配置继续）：${String(error?.message ?? error)}`);
    }
    return {};
  }
}

/**
 * 解析一个 agent 的压缩引擎实例。
 *
 * 顺序：preset realm（`agentPresets.serviceFor`）→ 根平面 `ctx.compaction`。
 * 后者只在 preset-free 组合（headless）里存在，是测试与兜底路径，不是 web 的正常路径。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} agent
 * @returns {object | undefined}
 */
function resolveEngine(ctx, agent) {
  try {
    const byPreset = ctx.get('agentPresets')?.serviceFor?.(agent, 'compaction');
    if (byPreset !== undefined && byPreset !== null) return byPreset;
  } catch {
    /* 注册表缺失/为旧版本：继续回落 */
  }
  try {
    return ctx.get('compaction');
  } catch {
    return undefined;
  }
}

/**
 * 组装模块依赖对象（唯一传给各模块的形状，子代理照此实现，不许改）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} runtime 合并后的配置
 * @param {object} rowConfig YAML 行配置（覆盖 runtime 的顶层键）
 * @returns {object} deps
 */
function makeDeps(ctx, runtime, rowConfig) {
  return {
    /** 根上下文（需要可选服务时自行 `ctx.inject`）。 */
    ctx,
    /** 生效的配置快照（settings.mjs 可能在运行时替换其中的可变副本）。 */
    runtime,
    /** YAML 行配置（profile 可覆盖；只用于诊断）。 */
    rowConfig,
    /** DSH logger（可能不存在）。 */
    logger: ctx.logger,
    /**
     * 取 agent 的压缩引擎实例。
     * @param {object} agent
     * @returns {object|undefined}
     */
    resolveEngine: (agent) => resolveEngine(ctx, agent),
    /**
     * 取宿主 token meter（记账唯一合法来源；不得用插件自己的估算）。
     * @returns {object|undefined}
     */
    tokenMeter: () => {
      try {
        return ctx.get('tokenMeter');
      } catch {
        return undefined;
      }
    },
    /** 交接文档写入器（由 apply() 创建并注入；面板读它的 last() 结果）。 */
    handoff: undefined,
  };
}

/**
 * 交接文档：每个 agent 的 turn/end 上检查一次。
 *
 * 为什么挂在 agent 作用域而不是根 `session/event`：根上下文看不到 agent 的
 * scope-filtered 会话事件（这是 context-guard 当初踩过的坑）；`agent/created`
 * 在根上下文可见，用它拿到 agent 后，在其 `agent.ctx` 上听 `session/event`。
 *
 * @param {object} deps
 * @returns {() => void} disposer
 */
function installHandoff(deps) {
  const { ctx } = deps;
  const perAgent = new Map();

  function attach(agent) {
    if (perAgent.has(agent)) return;
    const dispose = agent.ctx.effect(function* () {
      yield agent.ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return;
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

/**
 * 测试/验收用挂载探针（**仅环境变量开启，生产零行为**）。
 *
 * P0 门禁要在隔离进程里证明两件事，而模型工具不可用时没有别的观察口：
 *   1. `ctx.compaction.constructor.name` 是 `AcpEngine`（不是 basic、且只有一个）；
 *   2. 四个工具确实注册进了全局注册表。
 * 探针写一个 JSON 文件后，可选地直接退出进程（`DSH_ACP_MOUNT_PROBE_EXIT=1`），
 * 这样连模型 key 都不需要。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} runtime
 */
function installProbe(ctx, runtime) {
  const out = process.env.DSH_ACP_MOUNT_PROBE;
  if (typeof out !== 'string' || out.length === 0) return;
  const timer = setTimeout(() => {
    try {
      const engine = (() => {
        try {
          return ctx.get('compaction');
        } catch {
          return undefined;
        }
      })();
      const tools = (() => {
        try {
          return (ctx.get('tools')?.schemas?.() ?? []).map((schema) => schema?.name).filter((value) => typeof value === 'string');
        } catch {
          return [];
        }
      })();
      // preset realm 的运行时证据：保留的 preset revision 里，compaction 行挂的是
      // 本插件引擎（而不是内置 compaction-basic），且 isolate 生效（没有服务泄漏）。
      // 这比只看 `--dump-config` 的文本组合更有力：模块真的被 import 并激活了。
      const presets = (() => {
        try {
          const registry = ctx.get('agentPresets');
          if (registry === undefined) return [];
          return (registry.inspectCompositions?.() ?? []).map((inspection) => {
            const modules = inspection.modules ?? [];
            return {
              id: inspection.id,
              engineRows: modules.filter((module) => String(module?.moduleName ?? '').includes('dsh-context-acp/engine')).length,
              basicRows: modules.filter((module) => String(module?.moduleName ?? '') === '@deepseek-ai/dsh-compaction-basic').length,
              leakedServices: [...(inspection.leakedServices ?? [])],
            };
          });
        } catch (error) {
          return [{ id: '<inspect-failed>', error: String(error?.message ?? error) }];
        }
      })();
      const report = {
        pid: process.pid,
        engineConstructor: engine === undefined || engine === null ? null : engine.constructor?.name ?? null,
        backend: runtime.backend,
        acpToolCount: tools.filter((tool) => ['compress', 'decompress', 'search_context', 'acp_status'].includes(tool)).length,
        acpTools: tools.filter((tool) => ['compress', 'decompress', 'search_context', 'acp_status'].includes(tool)),
        allToolCount: tools.length,
        presets,
        at: new Date().toISOString(),
      };
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (error) {
      try {
        writeFileSync(`${out}.error`, String(error?.stack ?? error), 'utf8');
      } catch {
        /* 探针失败不影响进程 */
      }
    }
    if (process.env.DSH_ACP_MOUNT_PROBE_EXIT === '1') process.exit(0);
  }, 500);
  // unref：不因探针定时器拖住正常退出。
  timer.unref?.();
}

/**
 * 根插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rowConfig]
 */
export function apply(ctx, rowConfig = {}) {
  const runtime = mergeRuntime(
    mergeRuntime(DEFAULT_RUNTIME, readRuntimeFile(ctx)),
    rowConfig && typeof rowConfig === 'object' ? rowConfig : {},
  );

  if (runtime.backend !== 'acp') {
    // 回滚路径：根插件完全惰性 —— 不注册工具、不挂事件、不留提示段。
    // 此时 preset 行也已被生成器换回内置 `compaction-basic`（见 gen-acp-preset.mjs）。
    ctx.logger?.info?.(`[acp] backend=${String(runtime.backend)}：根插件保持惰性，压缩回到内置 compaction-basic`);
    installProbe(ctx, runtime);
    return;
  }

  const deps = makeDeps(ctx, runtime, rowConfig);
  // 交接文档写入器：配置取 runtime.handoff；阈值文案跟随 fallback.ratio。
  deps.handoff = createHandoff({
    cfg: { ...DEFAULT_HANDOFF, ...(runtime.handoff ?? {}) },
    thresholdRatio: () => runtime?.fallback?.ratio ?? DEFAULT_FALLBACK.ratio,
    logger: ctx.logger,
  });

  // 所有安装器都必须返回 disposer（function 或 generator），由 effect 统一管理：
  // 插件被禁用/重挂时不留残影（重复注册工具会直接抛 duplicate）。
  ctx.effect(function* () {
    yield registerCompressTool(deps);
    yield registerRestoreTools(deps);
    yield registerStatusTool(deps);
    yield installNudge(deps);
    yield installPromptSection(deps);
    yield installCommand(deps);
    yield installHandoff(deps);
    yield installPanel(deps);
  }, 'context-acp lifecycle');

  installProbe(ctx, deps.runtime);
}

export { name, inject };
