/**
 * dsh-context-acp — 面板 pill 客户端（C 负责）。
 *
 * ## 结构
 *
 * 与 `dsh-context-guard/client.js` 同一套：ACP 药丸挂在 `conversation.composer.dock`
 * （和宿主自带的「X 轮 X 步」、ContextMeter 同一行），点开是面板。
 * nudge 提示单独挂在 `conversation.input.dock`——它在 composerStack 里位于
 * 输入框之前，是一条 26px 的输入框上沿外嵌条，没有 nudge 时不占高度。
 * 不 require 任何 Harness Client 包，只 require('react')；样式只用 `--dsw-*`
 * 主题 token，类名前缀 `acp_`，随组件卸载移除。
 *
 * ## 数据来源（为什么要两条路）
 *
 * session 作用域 slot 的渲染 props = 标准 props（`sessionId`，由
 * `dsh-client-ui-session` 的 builtin source 注入）+ 宿主 owner props + `t`：
 *   - 每会话的块数 / 最高 tier / 被压 tokens → 宿主注册的 `contextAcp` 投影；
 *   - 上下文占用 → token-meter 自己的 `contextPressure` 投影（不重复造数）；
 *   - 可调参数 + **本会话**上次 nudge → `POST /context-acp/getSettings`，
 *     请求体带 `sessionId`（不带就退化成进程级读数，只留给旧客户端）。
 *
 * 2026-11-06 修过的 bug：nudge 横幅以前不带 sessionId，读的是进程级「最近一次
 * nudge」，于是任何会话只要 15 分钟内发生过一次 nudge 就全都显示警报（用户看到
 * 「离 55% 还很远的对话」也在弹）。现在横幅只认**自己会话**的记录。
 *
 * 面板上改阈值/增长 tokens 走 `POST /context-acp/setSettings`，250ms 去抖，
 * 保存成功/失败都在面板里可见 —— 只改界面不改行为的面板是装饰。
 *
 * @module dsh-context-acp/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-acp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-context-acp';
    const ROUTE = '/context-acp';

    /** 面板步进范围（与 settings.mjs 的夹取一致）。 */
    const RATIO_MIN = 20;
    const RATIO_MAX = 95;
    const RATIO_STEP = 5;
    const HANDOFF_MIN = 1;
    const HANDOFF_MAX = 5;
    const GROWTH_MIN = 1000;
    const GROWTH_MAX = 100000;
    const GROWTH_STEP = 1000;

    const DICT = {
      zh: {
        'pill.label': 'ACP {blocks} 块',
        'pill.aria': 'ACP 压缩：已压 {blocks} 块，上下文占用 {percent}%',
        'panel.title': 'ACP 压缩控制台',
        'panel.blocks': '已压块数',
        'panel.tierMax': '最高 tier',
        'panel.shadowed': '累计被压 tokens',
        'panel.used': '上下文占用',
        'panel.lastNudge': '上次 nudge',
        'panel.noNudge': '本会话暂无记录',
        'panel.lastFallback': '上次兜底',
        'panel.noFallback': '未触发过（模型都在自己压）',
        'panel.fallback': '兜底自动压缩',
        'panel.fallbackValue': '≥{percent}% · 连续 {n} 次 nudge 未响应',
        'panel.handoff': '交接文档',
        'panel.handoffValue': '压满 {n} 次后写一份',
        'panel.handoffNone': '本会话还没写',
        'panel.handoffWritten': '已写出 · {file}',
        'panel.handoffNotWritten': '未写出（{reason}）',
        'panel.handoffAfter': '压满几次',
        'panel.handoffStatus': '状态',
        'panel.threshold': 'nudge 阈值',
        'panel.growth': '增长 tokens',
        'panel.note': 'nudge 在每步模型调用前检查压力；ACP 不会自动压缩，压哪段由模型决定。',
        'panel.hint': '修改即时生效；250ms 内连续调整合并为一次保存。',
        'panel.saved': '已保存',
        'panel.saveFailed': '保存失败：{message}',
        'value.unknown': '—',
        'dec': '减小',
        'inc': '增大',
      },
      en: {
        'pill.label': 'ACP {blocks} blocks',
        'pill.aria': 'ACP compression: {blocks} blocks compacted, context {percent}% used',
        'panel.title': 'ACP compression console',
        'panel.blocks': 'Blocks compacted',
        'panel.tierMax': 'Highest tier',
        'panel.shadowed': 'Tokens shadowed',
        'panel.used': 'Context used',
        'panel.lastNudge': 'Last nudge',
        'panel.noNudge': 'no record in this session',
        'panel.lastFallback': 'Last fallback',
        'panel.noFallback': 'never (the model compacts on its own)',
        'panel.fallback': 'Fallback auto-compact',
        'panel.fallbackValue': '≥{percent}% · after {n} unanswered nudges',
        'panel.handoff': 'Handoff doc',
        'panel.handoffValue': 'written after {n} compactions',
        'panel.handoffNone': 'not written for this session yet',
        'panel.handoffWritten': 'written · {file}',
        'panel.handoffNotWritten': 'not written ({reason})',
        'panel.handoffAfter': 'compactions before write',
        'panel.handoffStatus': 'status',
        'panel.threshold': 'Nudge threshold',
        'panel.growth': 'Growth tokens',
        'panel.note': 'Nudges check pressure before every model step; ACP never compacts automatically — the model decides what to compact.',
        'panel.hint': 'Changes apply immediately; adjustments within 250ms are saved once.',
        'panel.saved': 'saved',
        'panel.saveFailed': 'save failed: {message}',
        'value.unknown': '—',
        'dec': 'Decrease',
        'inc': 'Increase',
      },
    };

    // 度量照抄同排的 StatsPills / ContextMeter；面板排版照抄宿主面板。
    // 不用 --dsh-content-font-size-secondary 之外的动态字号，避免被 ui-theme 放大。
    const CSS = `
.acp_anchor{position:relative;min-width:0;display:inline-flex;
  font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.acp_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);
  font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;
  background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;
  display:inline-flex;cursor:pointer}
.acp_pill:hover{color:var(--dsw-alias-label-secondary)}
.acp_pill[data-open="true"]{color:var(--dsw-alias-label-primary)}
.acp_icon{width:13px;height:13px;flex:none;display:block}
.acp_panel{position:absolute;bottom:calc(100% + 8px);right:0;left:auto;z-index:1100;
  box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);
  width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);
  color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;
  font-size:12px;line-height:18px;backdrop-filter:var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent)}
.acp_title{color:var(--dsw-alias-label-primary);font-weight:500;
  align-items:center;gap:6px;margin-bottom:8px;display:flex}
.acp_rows{color:var(--dsw-alias-label-tertiary);margin:0;display:grid;
  grid-template-columns:minmax(86px,auto) minmax(0,1fr);gap:6px 16px}
.acp_rows dt{white-space:nowrap}
.acp_rows dd{margin:0;color:var(--dsw-alias-label-primary);font-weight:500;
  text-align:right;font-variant-numeric:tabular-nums;
  display:flex;align-items:center;justify-content:flex-end;gap:4px}
.acp_step{box-sizing:border-box;width:18px;height:18px;padding:0;flex:none;
  color:var(--dsw-alias-label-secondary);background:0 0;border:none;
  border-radius:var(--dsw-radius-sm);cursor:pointer;display:inline-flex;
  align-items:center;justify-content:center;font-size:13px;line-height:1}
.acp_step:hover{background:var(--dsw-alias-interactive-bg-hover-solid);
  color:var(--dsw-alias-label-primary)}
.acp_step:disabled{opacity:.35;cursor:default;background:0 0}
.acp_value{min-width:44px;text-align:right;font-variant-numeric:tabular-nums}
.acp_note{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-tertiary)}
.acp_note[data-error="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.acp_note[data-ok="true"]{color:var(--dsw-alias-state-success-primary)}
.acp_hint{margin-top:2px;color:var(--dsw-alias-label-tertiary);opacity:.8}
.acp_label{text-overflow:ellipsis;min-width:0;overflow:hidden}
/* ── 手机形态：以宿主给的 dsh-phone 类为准，而不是视口宽度 ─────────────
   为什么不能只用 @media (max-width:520px)：**横屏时宽度是 844**，媒体查询
   不命中，但宿主仍然标记 dsh-phone —— 于是药丸在横屏下又变回 0 宽。
   （2026-10-28 实测：横屏 844×390 下药丸 w=0、面板跑出屏外。） */
:root.dsh-phone .acp_panel{position:fixed;
  left:calc(8px + env(safe-area-inset-left,0px));
  right:calc(8px + env(safe-area-inset-right,0px));
  bottom:calc(140px + env(safe-area-inset-bottom,0px));
  width:auto;min-width:0;max-width:none;
  max-height:min(60dvh, 520px);overflow-y:auto;
  -webkit-overflow-scrolling:touch;padding:12px 14px;font-size:13px;line-height:19px}
/* 手机上 dock 的祖先宽度是 0（宿主 composer 用 0 宽占位层做布局），
   把药丸塞在 dock 里必然是 0 宽 —— 所以手机端改为**悬浮徽标**。 */
/* 手机端药丸**内联**在 dock 的右下格（由 dsh-mobile-ui 的两列网格定位），
   不再做悬浮徽标：悬浮会压在输入框边框上，而且旧版就是内联叠放的。 */
:root.dsh-phone .acp_anchor{position:static;
  display:inline-flex;align-items:center;font-size:12px;line-height:16px;
  min-width:auto;max-width:100%;background:none;border-radius:0;padding:0;box-shadow:none}
/* 注意：panel 是 position:fixed，它的祖先**不能**有 backdrop-filter / filter /
   transform —— 否则会创建包含块，面板就会相对药丸定位并跑出屏幕
   （2026-10-28 实测：横屏下面板 91px 宽、top=−80）。 */
:root.dsh-phone .acp_pill{gap:4px;padding:0 8px;min-height:40px;align-items:center}
/* 长中文标签（"兜底自动压缩：nudge 阈值"）必须能折行，否则 nowrap 会挤掉数值列 */
:root.dsh-phone .acp_rows{grid-template-columns:minmax(96px,1fr) minmax(0,1.15fr);gap:4px 10px}
:root.dsh-phone .acp_rows dt{white-space:normal;word-break:break-word}
/* 步进按钮：视觉 32×32，靠 ::after 把**可点区域**扩到 44×44，
   既不把 17 行面板撑高，又满足移动端最小触控尺寸。 */
:root.dsh-phone .acp_step{width:32px;height:32px;position:relative}
:root.dsh-phone .acp_step::after{content:"";position:absolute;inset:-6px}
:root.dsh-phone .acp_value{min-width:52px}
`;

    /** 有限非负数，否则 undefined。 */
    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    }

    /**
     * 把宿主给的时间戳归一成毫秒。
     *
     * 会话事件与投影的 `time` 都是 `Date.now()` 毫秒，但同名字段在别处可能是
     * 秒级 epoch —— 不归一的话「已压缩」会被误判成「没压」（差 1000 倍里外）。
     * 现在的毫秒 epoch 是 1.7e12 量级，< 1e11 只可能是秒（或 0）。
     */
    function toEpochMs(value) {
      const numeric = num(value);
      if (numeric === undefined) return undefined;
      if (numeric <= 0) return 0;
      return numeric < 1e11 ? numeric * 1000 : numeric;
    }

    /** `useProjection` 缺失（旧宿主）时的读写口：不投影就等于「什么都不知道」。 */
    function readNoProjection() {
      return undefined;
    }

    /**
     * 模型已响应后，成功回执停留多久再自动收起。
     *
     * 4 秒的依据：够看清「已压缩」这行字（手机上滑一眼的余量），又不会在用户
     * 已经开始看回答时还占着输入框上沿。它只是**回执**，不是需要操作的东西，
     * 所以必须自己走掉 —— 用户原话是「手动不是不行，就是有点不够高级」。
     */
    const NUDGE_AUTO_CLOSE_MS = 4000;

    /** 千分位；大数用 K/M，和宿主 pill 的紧凑风格一致。 */
    function compact(value) {
      if (value === undefined) return '—';
      if (value < 1000) return String(Math.round(value));
      if (value < 1e6) return `${Math.round((value / 1e3) * 10) / 10}K`;
      return `${Math.round((value / 1e6) * 10) / 10}M`;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    /** 一次 client-request（信封与 context-guard 完全一致）。 */
    async function rpc(method, payload) {
      const response = await fetch(`${ROUTE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `${Date.now()}`,
          method,
          payload,
        }),
      });
      const json = await response.json();
      const result = json?.result;
      if (result?.ok !== true) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      return result.value;
    }

    /** 压缩图标：上下两条被夹紧的横杠 + 中间活塞（自绘，不引第三方图标）。 */
    function AcpIcon(props) {
      return h(
        'svg',
        Object.assign(
          {
            className: 'acp_icon',
            viewBox: '0 0 14 14',
            width: 13,
            height: 13,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
            'aria-hidden': true,
          },
          props,
        ),
        h('path', { d: 'M2 2.6h10M2 11.4h10' }),
        h('path', { d: 'M5 5h4v4H5z' }),
        h('path', { d: 'M7 2.6v2.4M7 9v2.4' }),
      );
    }

    function AcpPill({ sessionId, useProjection, t }) {
      const acp = useProjection('contextAcp');
      const pressure = useProjection('contextPressure');
      const [open, setOpen] = React.useState(false);
      const [info, setInfo] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      // 保存成功后保留权威值：投影要等下一次会话事件才会更新，回落到旧值
      // 会让面板看起来像"没保存"。
      const [saved, setSaved] = React.useState(null);
      const [savedFlash, setSavedFlash] = React.useState(false);
      const [saveError, setSaveError] = React.useState(null);
      const rootRef = React.useRef(null);
      const draftRef = React.useRef(null);
      const saveTimer = React.useRef(undefined);
      const flashTimer = React.useRef(undefined);

      // 文案走 locale 服务；t 缺失时退回中文字典，面板不会因语言包缺失而空白。
      const tr = (key, params) => {
        let text;
        if (typeof t === 'function') {
          try {
            text = t(key, params);
          } catch {
            text = undefined;
          }
        }
        if (typeof text !== 'string' || text === key) text = DICT.zh[key] ?? key;
        if (!params) return text;
        return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
      };

      // 点面板外 / Esc 关闭。
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      React.useEffect(
        () => () => {
          if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
          if (flashTimer.current !== undefined) clearTimeout(flashTimer.current);
        },
        [],
      );

      // 打开面板时向 host 拉一次可调参数与「本会话」上次 nudge（带 sessionId，
      // 不带的话 host 只能给进程级读数 —— 那正是别的会话也在报 nudge 的根因）。
      React.useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        void (async () => {
          try {
            const value = await rpc('getSettings', { sessionId });
            if (alive) setInfo(value);
          } catch {
            if (alive) setInfo(null);
          }
        })();
        return () => {
          alive = false;
        };
      }, [open, sessionId]);

      const contextWindow = num(pressure?.contextWindow);
      const used = num(pressure?.projectedTokens) ?? num(pressure?.pressureTokens);
      const percent = contextWindow !== undefined && contextWindow > 0 && used !== undefined
        ? Math.round((used / contextWindow) * 100)
        : undefined;
      const blocks = num(acp?.blocks) ?? 0;
      const tierMax = num(acp?.tierMax) ?? 0;
      const shadowed = num(acp?.shadowedTokens) ?? 0;

      const infoRatio = num(info?.tunables?.pressureRatio);
      const infoGrowth = num(info?.tunables?.growthTokens);
      const infoFallback = num(info?.tunables?.fallbackRatio);
      const infoHandoff = num(info?.tunables?.handoffAfter);
      const shownPercent =
        num(draft?.pressurePercent)
        ?? num(saved?.pressurePercent)
        ?? (infoRatio === undefined ? undefined : Math.round(infoRatio * 100))
        ?? 65;
      const shownGrowth =
        num(draft?.growthTokens)
        ?? num(saved?.growthTokens)
        ?? (infoGrowth !== undefined && infoGrowth > 0 ? infoGrowth : undefined)
        ?? 12000;
      const shownFallbackPercent =
        num(draft?.fallbackPercent)
        ?? num(saved?.fallbackPercent)
        ?? (infoFallback === undefined ? undefined : Math.round(infoFallback * 100))
        ?? 75;
      const shownHandoff =
        num(draft?.handoffAfter)
        ?? num(saved?.handoffAfter)
        ?? (infoHandoff !== undefined && infoHandoff > 0 ? infoHandoff : undefined)
        ?? 2;

      /**
       * 改一个设置：draft → 250ms 去抖 → POST setSettings → 成功保留权威值。
       *
       * `patch(base)` 以 draftRef 为基准，所以连续点按能真的累积，而不是每次都
       * 从渲染时的旧值算 ±1 格。
       */
      const push = (patch) => {
        const base = {
          pressurePercent: num(draftRef.current?.pressurePercent) ?? shownPercent,
          growthTokens: num(draftRef.current?.growthTokens) ?? shownGrowth,
          fallbackPercent: num(draftRef.current?.fallbackPercent) ?? shownFallbackPercent,
          handoffAfter: num(draftRef.current?.handoffAfter) ?? shownHandoff,
        };
        const next = Object.assign({}, base, patch(base));
        draftRef.current = next;
        setDraft(next);
        setSaveError(null);
        if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
          try {
            const value = await rpc('setSettings', {
              pressureRatio: next.pressurePercent / 100,
              growthTokens: next.growthTokens,
              fallbackRatio: next.fallbackPercent / 100,
              handoffAfter: next.handoffAfter,
            });
            if (value?.saved !== true) throw new Error(value?.saveError ?? 'not saved');
            const confirmedRatio = num(value?.tunables?.pressureRatio);
            const confirmedGrowth = num(value?.tunables?.growthTokens);
            const confirmedFallback = num(value?.tunables?.fallbackRatio);
            const confirmedHandoff = num(value?.tunables?.handoffAfter);
            draftRef.current = null;
            setDraft(null);
            setSaved({
              pressurePercent: confirmedRatio === undefined ? next.pressurePercent : Math.round(confirmedRatio * 100),
              growthTokens: confirmedGrowth === undefined ? next.growthTokens : confirmedGrowth,
              fallbackPercent:
                confirmedFallback === undefined ? next.fallbackPercent : Math.round(confirmedFallback * 100),
              handoffAfter: confirmedHandoff === undefined ? next.handoffAfter : confirmedHandoff,
            });
            setSavedFlash(true);
            if (flashTimer.current !== undefined) clearTimeout(flashTimer.current);
            flashTimer.current = setTimeout(() => setSavedFlash(false), 1600);
          } catch (error) {
            draftRef.current = null;
            setDraft(null);
            setSaveError(String(error?.message ?? error));
          }
        }, 250);
      };

      if (acp === undefined && pressure === undefined) return null;

      const label = tr('pill.label', { blocks, percent: percent ?? tr('value.unknown') });
      const aria = tr('pill.aria', { blocks, percent: percent ?? tr('value.unknown') });

      // 上次 nudge：host 已按 sessionId 过滤；本会话没提醒过就诚实说「本会话暂无记录」。
      const lastNudge = info?.lastNudge ?? null;
      let nudgeText;
      if (info === null) {
        nudgeText = tr('value.unknown');
      } else if (lastNudge === null || typeof lastNudge !== 'object') {
        nudgeText = tr('panel.noNudge');
      } else {
        const at = num(lastNudge.at);
        const when = at === undefined || at <= 0 ? '' : new Date(at).toLocaleTimeString();
        const nudgeWindow = num(lastNudge.contextWindow);
        const nudgeUsed = num(lastNudge.usedTokens);
        const nudgePercent =
          nudgeWindow !== undefined && nudgeWindow > 0 && nudgeUsed !== undefined
            ? `${Math.round((nudgeUsed / nudgeWindow) * 100)}%`
            : '';
        nudgeText = [when, typeof lastNudge.reason === 'string' ? lastNudge.reason : '', nudgePercent]
          .filter((part) => part !== '')
          .join(' · ');
      }

      const usedText =
        percent === undefined
          ? tr('value.unknown')
          : `${percent}% (${compact(used)} / ${compact(contextWindow)})`;

      // 上次兜底：模型连续不理提醒之后，插件自己动手的痕迹。没有就是没有。
      const lastFallback = info?.lastFallback ?? null;
      let fallbackText;
      if (info === null) {
        fallbackText = tr('value.unknown');
      } else if (lastFallback === null || typeof lastFallback !== 'object') {
        fallbackText = tr('panel.noFallback');
      } else {
        const at = num(lastFallback.at);
        const when = at === undefined || at <= 0 ? '' : new Date(at).toLocaleTimeString();
        const pct = num(lastFallback.percent);
        fallbackText = [when, typeof lastFallback.reason === 'string' ? lastFallback.reason : '',
          pct === undefined ? '' : `${pct}%`, typeof lastFallback.detail === 'string' ? lastFallback.detail : '']
          .filter((part) => part !== '')
          .join(' · ');
      }

      // 交接文档：写没写、写在哪、为什么没写（和 context-guard 时期一样的诚实口径）。
      const handoffInfo = info?.handoff ?? null;
      let handoffText;
      if (info === null) {
        handoffText = tr('value.unknown');
      } else if (handoffInfo === null || typeof handoffInfo !== 'object') {
        handoffText = tr('panel.handoffNone');
      } else if (handoffInfo.written === true) {
        const file = typeof handoffInfo.file === 'string' ? handoffInfo.file.split('/').pop() : '';
        handoffText = tr('panel.handoffWritten', { file });
      } else {
        handoffText = tr('panel.handoffNotWritten', { reason: String(handoffInfo.reason ?? '?') });
      }

      /** 一行「标签 … [−] 值 [+]」，返回 [dt, dd]。 */
      // step 显式传入：之前靠 `unit === '%'` 猜步长，handoff（单位 '×'）因此
      // 误用了 GROWTH_STEP（上千级），一点加号就夹到上限、减号夹到下限，
      // 1~5 之间根本选不到（2026-11-05 用户实测）。
      const stepperRow = (term, value, unit, min, max, step, onDelta) => [
        h('dt', { key: `t-${term}` }, term),
        h(
          'dd',
          { key: `d-${term}` },
          h(
            'button',
            {
              key: 'dec',
              type: 'button',
              className: 'acp_step',
              disabled: value <= min,
              'aria-label': tr('dec'),
              title: tr('dec'),
              onClick: () => onDelta(-step),
            },
            '−',
          ),
          h('span', { key: 'value', className: 'acp_value' }, `${value}${unit}`),
          h(
            'button',
            {
              key: 'inc',
              type: 'button',
              className: 'acp_step',
              disabled: value >= max,
              'aria-label': tr('inc'),
              title: tr('inc'),
              onClick: () => onDelta(step),
            },
            '+',
          ),
        ),
      ];

      const rows = [
        [tr('panel.blocks'), String(blocks)],
        [tr('panel.tierMax'), tierMax > 0 ? `tier ${tierMax}` : tr('value.unknown')],
        [tr('panel.shadowed'), compact(shadowed)],
        [tr('panel.used'), usedText],
        [tr('panel.lastNudge'), nudgeText],
        stepperRow(tr('panel.threshold'), shownPercent, '%', RATIO_MIN, RATIO_MAX, RATIO_STEP, (delta) =>
          push((base) => ({ pressurePercent: clamp(base.pressurePercent + delta, RATIO_MIN, RATIO_MAX) })),
        ),
        stepperRow(tr('panel.growth'), shownGrowth, '', GROWTH_MIN, GROWTH_MAX, GROWTH_STEP, (delta) =>
          push((base) => ({ growthTokens: clamp(base.growthTokens + delta, GROWTH_MIN, GROWTH_MAX) })),
        ),
        // ── 合并自 dsh-context-guard 的能力（2026-10-27）───────────────────
        [tr('panel.fallback'), tr('panel.fallbackValue', {
          percent: shownFallbackPercent,
          n: num(info?.fallbackAfterNudges) ?? 2,
        })],
        stepperRow(tr('panel.fallback') + '：' + tr('panel.threshold'), shownFallbackPercent, '%', RATIO_MIN, RATIO_MAX, RATIO_STEP, (delta) =>
          push((base) => ({ fallbackPercent: clamp(base.fallbackPercent + delta, RATIO_MIN, RATIO_MAX) })),
        ),
        [tr('panel.lastFallback'), fallbackText],
        [tr('panel.handoff'), tr('panel.handoffValue', { n: shownHandoff })],
        stepperRow(tr('panel.handoff') + '：' + tr('panel.handoffAfter'), shownHandoff, '×', HANDOFF_MIN, HANDOFF_MAX, 1, (delta) =>
          push((base) => ({ handoffAfter: clamp(base.handoffAfter + delta, HANDOFF_MIN, HANDOFF_MAX) })),
        ),
        [tr('panel.handoff') + '：' + tr('panel.handoffStatus'), handoffText],
      ];

      return h(
        'span',
        { className: 'acp_anchor', ref: rootRef },
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'trigger',
            type: 'button',
            className: 'acp_pill',
            'data-open': open ? 'true' : 'false',
            'aria-label': aria,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            title: aria,
            onClick: () => setOpen((value) => !value),
          },
          h(AcpIcon, { key: 'icon' }),
          // 文案只保留块数：占用百分比与宿主自带的上下文药丸重复，已删除。
          // aria-label 仍带完整信息（块数 + 占用）。
          h('span', { key: 'label', className: 'acp_label' }, label),
        ),
        open &&
          h('div', { key: 'panel', className: 'acp_panel', role: 'dialog', 'aria-label': tr('panel.title') }, [
            h('div', { key: 'title', className: 'acp_title' }, [
              h(AcpIcon, { key: 'icon' }),
              h('span', { key: 'text' }, tr('panel.title')),
            ]),
            h(
              'dl',
              { key: 'rows', className: 'acp_rows' },
              rows.flatMap(([term, value]) => [h('dt', { key: `t-${term}` }, term), h('dd', { key: `d-${term}` }, value)]),
            ),
            h('div', { key: 'note', className: 'acp_note' }, tr('panel.note')),
            h('div', { key: 'hint', className: 'acp_hint' }, tr('panel.hint')),
            savedFlash && h('div', { key: 'saved', className: 'acp_note', 'data-ok': 'true' }, tr('panel.saved')),
            saveError !== null &&
              h('div', { key: 'err', className: 'acp_note', 'data-error': 'true' }, tr('panel.saveFailed', { message: saveError })),
          ]),
      );
    }

    /* ── 上下文压力提示（独立条目）─────────────────────────────────────
     * 为什么不改 AcpPill：药丸每次渲染都跑，一旦那里抛错整个 ACP 都会消失
     * （2026-11-05 实测踩过）。所以单独注册一个 dock 条目，它坏了只影响自己。
     *
     * 设计要点（经设计顾问评审 + 实测对比度校准）：
     *   · 位置：手机端独占 dock 第 3 行（grid-row:3），不跟「ACP 1 块」抢第 2 行；
     *   · 常驻：最近 15 分钟发生过 nudge 就显示，不做"1 秒就消失"的 toast；
     *   · **有回应就自动收**：本会话在 nudge 之后发生过压缩（投影 `contextAcp.lastAt`
     *     晚于 nudge 的 `at`）说明模型已经照办 —— 立刻从「建议压缩」切成一条
     *     成功回执，带 4 秒倒计时进度条后自动消失，不需要用户手动点 ×；
     *   · 动效：入场 2 次脉冲后**收敛为静态**，不做无限循环（避免视觉疲劳）；
     *   · 降级：prefers-reduced-motion 时彻底静态，靠描边+图标传达；
     *   · 主题：亮/暗走宿主 token 的等效安全色，赛博 2077 用霓虹黄底黑字。
     *
     * 实测对比度（WCAG）：
     *   亮 #fef3c7 底 + #92400e 字 = 6.37:1（AA）
     *   暗 16% 橙底 over #0a0e18 + #ffc94d 字 = 10.02:1（AAA）
     *   赛博 #0a101d 底 + #f6ff00 字 = 17+:1（AAA，亮柠檬黄）
     *   反例：暗色拿 --dsw-alias-state-warn-primary(#ffb300) 当底、warn-label(#ffc94d) 当字 = 1.17:1，禁用。
     */
    const NUDGE_CSS = `
/* 输入框上沿外嵌条：宽度对齐输入卡（和宿主 TodoPanel 同一套宽度变量）。 */
.acp_nudge_anchor{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) * 2);
  max-width:var(--dsh-composer-card-max-width,920px);margin:0 auto;display:flex}
.acp_nudge{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:26px;
  padding:0 10px 0 8px;border-radius:var(--dsw-radius-md);font-size:12px;font-weight:600;
  line-height:1;white-space:nowrap;color:#78350f;background:#fff8e6;border:1px solid #fde68a;
  box-shadow:0 1px 8px rgba(180,83,9,.18);
  /* 倒计时条是绝对定位的子元素：需要定位上下文 + 裁掉圆角外的部分。 */
  position:relative;overflow:hidden}
.acp_nudge_badge{display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;border-radius:50%;flex:none;
  background:#b45309;color:#fff;font-size:11px;font-weight:700}
.acp_nudge_hint{opacity:.85;font-weight:500}
.acp_nudge_close{display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;border:0;border-radius:50%;padding:0;flex:none;cursor:pointer;
  background:transparent;color:inherit;opacity:.55;font-size:14px;line-height:1;margin-left:auto}
.acp_nudge_close:hover{opacity:1}
/* 倒计时进度条：贴在横幅底沿，走完就自动收起（模型已响应时才有）。
   容器需要 relative + overflow:hidden，否则 2px 的条会溢出圆角。 */
.acp_nudge_progress{position:absolute;left:0;right:0;bottom:0;height:2px;
  background:currentColor;opacity:.5;transform-origin:left center;
  animation:dsh-acp-nudge-countdown var(--acp-nudge-auto-close-ms,4000ms) linear forwards}
@keyframes dsh-acp-nudge-countdown{from{transform:scaleX(1)}to{transform:scaleX(0)}}
/* 已响应：模型真的压缩过了 —— 从"建议压缩"的警报切成一条回执。
   用蓝色而不是绿色：绿色在这里会与"正常/无需操作"混淆，蓝色读作"已处理"。 */
.acp_nudge[data-resolved="true"]{color:#1e3a8a;background:#eff6ff;border-color:#bfdbfe;
  box-shadow:0 1px 8px rgba(37,99,235,.16)}
.acp_nudge[data-resolved="true"] .acp_nudge_badge{background:#2563eb;color:#fff}
.acp_nudge[data-resolved="true"] .acp_nudge_hint{opacity:.7}
body[data-ds-dark-theme] .acp_nudge[data-resolved="true"],
:root[data-ds-theme-source="dark"] .acp_nudge[data-resolved="true"]{color:#93c5fd;background:#0b1f33;
  border-color:#1e40af;box-shadow:0 0 0 1px rgba(37,99,235,.25),0 2px 10px rgba(0,0,0,.45)}
body[data-ds-dark-theme] .acp_nudge[data-resolved="true"] .acp_nudge_badge,
:root[data-ds-theme-source="dark"] .acp_nudge[data-resolved="true"] .acp_nudge_badge{background:#3b82f6;color:#04101f}
/* 暗色：深琥珀底 + 亮琥珀字（10.4:1） */
body[data-ds-dark-theme] .acp_nudge,
:root[data-ds-theme-source="dark"] .acp_nudge{color:#ffc94d;background:#231904;border-color:#7a5200;
  box-shadow:0 0 0 1px rgba(255,179,0,.18),0 2px 10px rgba(0,0,0,.45)}
body[data-ds-dark-theme] .acp_nudge_badge,
:root[data-ds-theme-source="dark"] .acp_nudge_badge{background:#ffb300;color:#1a1204}
/* 赛博 2077：深夜底 + 亮柠檬黄描边/字 + 左侧警示竖条。
   注意暗色规则是 body[data-ds-dark-theme] .acp_nudge（特异性 0,2,1），
   赛博主题本身也是暗色，所以这里必须用更高的特异性，否则会被暗色琥珀色压掉
   —— 之前“黄色偏暗”就是这么来的。 */
body[data-ds-dark-theme] .acp_nudge_cyber .acp_nudge,
:root[data-ds-theme-source="dark"] .acp_nudge_cyber .acp_nudge,
.acp_nudge_cyber .acp_nudge{
  color:#f6ff00;background:#0a101d;border-color:#f6ff00;border-radius:2px;
  box-shadow:0 0 8px rgba(246,255,0,.35),inset 3px 0 0 #f6ff00;
  padding-left:12px;letter-spacing:.03em;text-shadow:0 0 6px rgba(246,255,0,.55)}
body[data-ds-dark-theme] .acp_nudge_cyber .acp_nudge_badge,
:root[data-ds-theme-source="dark"] .acp_nudge_cyber .acp_nudge_badge,
.acp_nudge_cyber .acp_nudge_badge{background:#f6ff00;color:#05070d;border-radius:0}
body[data-ds-dark-theme] .acp_nudge_cyber .acp_nudge_hint,
:root[data-ds-theme-source="dark"] .acp_nudge_cyber .acp_nudge_hint,
.acp_nudge_cyber .acp_nudge_hint{color:#e8f1ff;opacity:.8}
/* 赛博主题下的「已响应」：上面的 .acp_nudge_cyber .acp_nudge（0,2,0）与
   .acp_nudge[data-resolved="true"]（0,2,0）同权重且在后面，会把蓝色回执压回霓虹黄 ——
   于是「压完了」和「该压了」在赛博主题下长得一样。这里用更高权重(0,3,0)显式给出
   青蓝回执色：赛博主题的语义是"信息高亮"，青蓝比柠檬黄更适合表示"已完成"。 */
body[data-ds-dark-theme] .acp_nudge_cyber .acp_nudge[data-resolved="true"],
:root[data-ds-theme-source="dark"] .acp_nudge_cyber .acp_nudge[data-resolved="true"],
.acp_nudge_cyber .acp_nudge[data-resolved="true"]{
  color:#7dfcff;background:#04141b;border-color:#7dfcff;
  box-shadow:0 0 8px rgba(125,252,255,.35),inset 3px 0 0 #7dfcff;
  text-shadow:0 0 6px rgba(125,252,255,.5)}
body[data-ds-dark-theme] .acp_nudge_cyber .acp_nudge[data-resolved="true"] .acp_nudge_badge,
:root[data-ds-theme-source="dark"] .acp_nudge_cyber .acp_nudge[data-resolved="true"] .acp_nudge_badge,
.acp_nudge_cyber .acp_nudge[data-resolved="true"] .acp_nudge_badge{background:#7dfcff;color:#04141b}
/* 入场：1 次上浮 + 2 次脉冲即收敛，不无限循环 */
.acp_nudge[data-fresh="true"]{animation:dsh-acp-nudge-in .24s cubic-bezier(.16,1,.3,1)}
@keyframes dsh-acp-nudge-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){
  .acp_nudge{animation:none!important;transition:none!important}
  /* 倒计时条靠动画走完；减弱动效时动画被关掉，条会僵在满格变谎话。
     所以直接藏条，只留「N 秒后自动收起」的文字承诺 —— JS 计时器照旧收起。 */
  .acp_nudge_progress{display:none!important}
}
/* 小屏不再精简文案：手机宽度放得下完整一行「上下文 N% · 建议压缩」。
   以前 430px 以下把文案压成「N%」并藏掉提示，用户实测明确要求与桌面一致。 */
`;

    /** 本会话最近一次 nudge 的可见提示。失败时静默返回 null，绝不影响主界面。 */
    function AcpNudge({ sessionId, useProjection }) {
      // 没有会话作用域（例如还没有会话的 hero 输入框）就不可能有"本会话的 nudge"。
      // 注意：这里**不能**提前 return —— hooks 必须每次都跑，只能最后按 hasSession 渲染 null。
      const hasSession = typeof sessionId === 'string' && sessionId !== '';
      // 本会话的压缩投影：`lastAt` 是最近一次 compaction/summary 的 event.time。
      // 它是"模型已经照办"的唯一权威信号 —— 提醒横幅自己数不到这件事。
      // `contextAcp` 由本插件的 host 侧投影注册（settings.mjs），本槽位的
      // standardProps 里 `useProjection` 一定有；投影未就绪时返回 undefined。
      const acp = (typeof useProjection === 'function' ? useProjection : readNoProjection)('contextAcp');
      const [state, setState] = React.useState(null);
      // 收起状态必须按会话分开存：在 A 会话点过 × 不能把 B 会话的提醒也吞掉。
      const dismissStoreKey = hasSession ? `dsh-acp-nudge-dismissed:${sessionId}` : null;
      // 用户点过 × 的**那一次** nudge 不再显示；换一次 nudge（at 变了）自动重新出现。
      const [dismissedAt, setDismissedAt] = React.useState(undefined);
      React.useEffect(() => {
        // 切会话时先清掉上一个会话的记忆，再从该会话自己的键读收起状态，
        // 避免"上一会话的提醒"在新会话里闪一下。
        setState(null);
        if (dismissStoreKey === null) {
          setDismissedAt(undefined);
          return;
        }
        try {
          const raw = sessionStorage.getItem(dismissStoreKey);
          setDismissedAt(raw === null ? undefined : Number(raw));
        } catch {
          setDismissedAt(undefined);
        }
      }, [dismissStoreKey]);

      React.useEffect(() => {
        if (!hasSession) return undefined;
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch(`${ROUTE}/getSettings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // 关键：带 sessionId。宿主只回**这个会话**的 nudge；不带的话会退化成
              // 进程级读数，任何会话都会显示别人的提醒（2026-11-06 修掉的 bug）。
              body: JSON.stringify({
                type: 'client-request',
                rpcId: 'nudge',
                method: 'getSettings',
                payload: { sessionId },
              }),
            });
            const data = await response.json();
            const value = data?.result?.value;
            if (alive && value !== undefined) setState(value);
          } catch {
            /* 拿不到就保持上一次状态，不报错、不影响输入框 */
          }
        };
        load();
        const timer = setInterval(load, 15000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId, hasSession]);

      /**
       * 「模型已经照办」的判定：本会话在**这次 nudge 之后**发生过压缩。
       *
       * 为什么必须比时间而不是看别的：nudge 的 `at` 在 host 侧是 nudge 发生的那一刻，
       * 压缩的 `lastAt` 是 `compaction/summary` 的 `event.time`。两者同源（都是
       * 会话/进程的毫秒时钟），所以 `compactAt >= at` 就是"压过了"的硬证据。
       * 用 `>=` 而不是 `>`：同一毫秒内完成也是完成；代价只是极罕见的假阳性，
       * 而那只会让一条提醒早 4 秒消失，不会掩盖真实压力（下一次 nudge 会再来）。
       *
       * 为什么以前没有它：横幅只数 `Date.now() - at < 15min`，完全不知道用户是否
       * 已经照着提醒压过了 —— 于是压完之后横幅还要杵满 15 分钟，只能手动点 ×。
       */
      const at = num(state?.lastNudge?.at);
      const compactAt = toEpochMs(acp?.lastAt);
      const resolved = at !== undefined && compactAt !== undefined && compactAt > 0 && compactAt >= at;

      // 自动收起：只对"已响应"的提醒生效，且每次 nudge 只排一次定时器。
      // 未响应的提醒继续常驻 —— 那是还需要用户/模型处理的东西，不该自己消失。
      const autoClosedAt = React.useRef(undefined);
      React.useEffect(() => {
        if (!hasSession || !resolved || at === undefined) return undefined;
        if (autoClosedAt.current === at) return undefined;
        autoClosedAt.current = at;
        const timer = setTimeout(() => {
          // 写进 sessionStorage：刷新后也不该再冒出来（这次 nudge 已经办完了）。
          try { sessionStorage.setItem(dismissStoreKey, String(at)); } catch { /* 隐私模式忽略 */ }
          setDismissedAt(at);
        }, NUDGE_AUTO_CLOSE_MS);
        return () => clearTimeout(timer);
      }, [hasSession, resolved, at, dismissStoreKey]);

      // 赛博 2077 主题在根节点上没有类名（它的 cp2077-on 只加在面板按钮上），
      // 只能靠它插入的 <style data-cyberpunk-theme> 来判定。轮询时重算一次即可。
      let cyber = false;
      try {
        cyber = !!document.querySelector('style[data-cyberpunk-theme]');
      } catch {
        cyber = false;
      }

      if (!hasSession) return null;
      if (at === undefined || at <= 0) return null;
      if (dismissedAt === at) return null;
      const ageMs = Date.now() - at;
      if (ageMs > 15 * 60 * 1000) return null;
      const used = num(state?.lastNudge?.usedTokens);
      const window = num(state?.lastNudge?.contextWindow);
      const percent = used !== undefined && window !== undefined && window > 0
        ? Math.round((used / window) * 100)
        : undefined;
      const fresh = ageMs < 90 * 1000;
      const when = new Date(at).toLocaleTimeString();

      return h(
        'span',
        { className: cyber ? 'acp_nudge_anchor acp_nudge_cyber' : 'acp_nudge_anchor' },
        h('style', { key: 'nudge-style' }, NUDGE_CSS),
        h(
          'span',
          {
            className: 'acp_nudge',
            role: 'status',
            'data-fresh': fresh ? 'true' : undefined,
            'data-resolved': resolved ? 'true' : undefined,
            style: resolved ? { '--acp-nudge-auto-close-ms': `${NUDGE_AUTO_CLOSE_MS}ms` } : undefined,
            title: resolved
              ? `上次 nudge：${when}${percent === undefined ? '' : `（上下文 ${percent}%）`} · 模型已压缩，回执即将自动收起`
              : `上次 nudge：${when}${percent === undefined ? '' : `（上下文 ${percent}%）`} · 模型可选择压缩历史`,
          },
          h('span', { key: 'badge', className: 'acp_nudge_badge' }, resolved ? '✓' : '!'),
          // 只用一份文案：手机与桌面完全一致（以前 430px 以下会换成精简版）。
          h('span', { key: 'text', className: 'acp_nudge_text' },
            resolved ? '已压缩' : (percent === undefined ? '上下文压力' : `上下文 ${percent}%`)),
          h('span', { key: 'hint', className: 'acp_nudge_hint' },
            resolved ? `${NUDGE_AUTO_CLOSE_MS / 1000} 秒后自动收起` : '建议压缩'),
          h('button', {
            key: 'close', type: 'button', className: 'acp_nudge_close',
            'aria-label': '收起提醒', title: '收起提醒（下次 nudge 再出现）',
            onClick: (event) => {
              event.stopPropagation();
              try { sessionStorage.setItem(dismissStoreKey, String(at)); } catch { /* 隐私模式忽略 */ }
              setDismissedAt(at);
            },
          }, '×'),
          // 倒计时条只在已响应时出现：它是"自己会走掉"的可视承诺。
          resolved
            ? h('span', { key: 'progress', className: 'acp_nudge_progress', 'aria-hidden': true })
            : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 语言包：dicts 形式 { zh, en }，与 ui-chat 的用法一致。
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-context-acp: dictionaries');
        // order=2：排在自带 stats pill 与 context-guard 之后，不顶掉宿主条目。
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-context-acp', order: 2, locale: NS }, AcpPill),
        );
        // 独立的 nudge 提示：故意与药丸分开注册，它自己挂了不会连累 ACP。
        // 挂在 conversation.input.dock：composerStack 里位于 inputBar 之前，
        // 是一条输入框上沿外嵌条（无 nudge 时组件返回 null，不占高度）。
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-acp-nudge', order: 30, locale: NS }, AcpNudge),
        );
      },
    };
  },
});
