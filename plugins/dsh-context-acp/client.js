/**
 * dsh-context-acp — 面板 pill 客户端（C 负责）。
 *
 * ## 结构
 *
 * 与 `dsh-context-guard/client.js` 同一套：挂在 `conversation.composer.dock`
 * 的 pill（和宿主自带的「X 轮 X 步」、ContextMeter 同一行），点开是面板。
 * 不 require 任何 Harness Client 包，只 require('react')；样式只用 `--dsw-*`
 * 主题 token，类名前缀 `acp_`，随组件卸载移除。
 *
 * ## 数据来源（为什么要两条路）
 *
 * slot 的渲染 props 只有 `{useProjection, t}`，**没有 sessionId**：
 *   - 每会话的块数 / 最高 tier / 被压 tokens → 宿主注册的 `contextAcp` 投影；
 *   - 上下文占用 → token-meter 自己的 `contextPressure` 投影（不重复造数）；
 *   - 可调参数 + 上次 nudge → `POST /context-acp/getSettings`（进程级信息）。
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
        'pill.label': 'ACP {blocks} 块 · {percent}%',
        'pill.aria': 'ACP 压缩：已压 {blocks} 块，上下文占用 {percent}%',
        'panel.title': 'ACP 压缩控制台',
        'panel.blocks': '已压块数',
        'panel.tierMax': '最高 tier',
        'panel.shadowed': '累计被压 tokens',
        'panel.used': '上下文占用',
        'panel.lastNudge': '上次 nudge',
        'panel.noNudge': '本进程暂无记录',
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
        'pill.label': 'ACP {blocks} blocks · {percent}%',
        'pill.aria': 'ACP compression: {blocks} blocks compacted, context {percent}% used',
        'panel.title': 'ACP compression console',
        'panel.blocks': 'Blocks compacted',
        'panel.tierMax': 'Highest tier',
        'panel.shadowed': 'Tokens shadowed',
        'panel.used': 'Context used',
        'panel.lastNudge': 'Last nudge',
        'panel.noNudge': 'no record in this process',
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
@media (max-width:520px){
  .acp_panel{position:fixed;left:calc(8px + env(safe-area-inset-left,0px));
    right:calc(8px + env(safe-area-inset-right,0px));bottom:calc(84px + env(safe-area-inset-bottom,0px));
    width:auto;min-width:0;max-width:none;max-height:55dvh;overflow-y:auto;
    -webkit-overflow-scrolling:touch;padding:12px 14px;font-size:13px;line-height:19px}
  .acp_anchor{font-size:11px;line-height:14px}
  .acp_pill{gap:4px;padding:0 6px}
}
`;

    /** 有限非负数，否则 undefined。 */
    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    }

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

    function AcpPill({ useProjection, t }) {
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

      // 打开面板时向 host 拉一次可调参数与上次 nudge。
      React.useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        void (async () => {
          try {
            const value = await rpc('getSettings', {});
            if (alive) setInfo(value);
          } catch {
            if (alive) setInfo(null);
          }
        })();
        return () => {
          alive = false;
        };
      }, [open]);

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

      // 上次 nudge：host 路由没有 sessionId，拿不到就诚实说"本进程暂无记录"。
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
      const stepperRow = (term, value, unit, min, max, onDelta) => [
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
              onClick: () => onDelta(-(unit === '%' ? RATIO_STEP : GROWTH_STEP)),
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
              onClick: () => onDelta(unit === '%' ? RATIO_STEP : GROWTH_STEP),
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
        stepperRow(tr('panel.threshold'), shownPercent, '%', RATIO_MIN, RATIO_MAX, (delta) =>
          push((base) => ({ pressurePercent: clamp(base.pressurePercent + delta, RATIO_MIN, RATIO_MAX) })),
        ),
        stepperRow(tr('panel.growth'), shownGrowth, '', GROWTH_MIN, GROWTH_MAX, (delta) =>
          push((base) => ({ growthTokens: clamp(base.growthTokens + delta, GROWTH_MIN, GROWTH_MAX) })),
        ),
        // ── 合并自 dsh-context-guard 的能力（2026-10-27）───────────────────
        [tr('panel.fallback'), tr('panel.fallbackValue', {
          percent: shownFallbackPercent,
          n: num(info?.fallbackAfterNudges) ?? 2,
        })],
        stepperRow(tr('panel.fallback') + '：' + tr('panel.threshold'), shownFallbackPercent, '%', RATIO_MIN, RATIO_MAX, (delta) =>
          push((base) => ({ fallbackPercent: clamp(base.fallbackPercent + delta, RATIO_MIN, RATIO_MAX) })),
        ),
        [tr('panel.lastFallback'), fallbackText],
        [tr('panel.handoff'), tr('panel.handoffValue', { n: shownHandoff })],
        stepperRow(tr('panel.handoff') + '：' + tr('panel.handoffAfter'), shownHandoff, '×', HANDOFF_MIN, HANDOFF_MAX, (delta) =>
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

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 语言包：dicts 形式 { zh, en }，与 ui-chat 的用法一致。
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-context-acp: dictionaries');
        // order=2：排在自带 stats pill 与 context-guard 之后，不顶掉宿主条目。
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-context-acp', order: 2, locale: NS }, AcpPill),
        );
      },
    };
  },
});
