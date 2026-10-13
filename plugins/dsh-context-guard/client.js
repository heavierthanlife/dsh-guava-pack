/**
 * dsh-context-guard — client half。
 *
 * 一块挂在 `conversation.composer.dock` 的 pill（和自带「X 轮 X 步」pill、
 * 原生 ContextMeter 同一行），点开是面板：
 *
 *   已用上下文（读 token-meter 的 `contextPressure`，不重复造数）
 *   自动压缩是否已就绪 / 阈值（可调，5% 一档）/ 压缩几次后写 handoff（可调 1–5）
 *   已压缩次数 + 上次释放的 token（读本插件 host 侧的 `contextGuard` 投影）
 *   handoff 状态
 *
 * 可调参数经 `POST /context-guard/setSettings` 回传 host 并落盘 —— 只改界面不改行为
 * 的面板是装饰，所以这里真的写回（通路与 provider-router 相同：自注册 webServer
 * 前缀路由 + connection 自己的 Host/Origin 围栏与浏览器鉴权）。
 *
 * 只用 `--dsw-*` 主题 token；pill 的度量照抄宿主 StatsPills / ContextMeter，
 * 不 require 任何 Harness Client 包，自带样式随组件卸载移除。
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'context-guard';
    const ROUTE = '/context-guard';

    /** 阈值档位：20%–95%，每档 5%。 */
    const THRESHOLD_MIN = 20;
    const THRESHOLD_MAX = 95;
    const THRESHOLD_STEP = 5;
    /** handoff 触发次数：1–5。 */
    const COUNT_MIN = 1;
    const COUNT_MAX = 5;

    const DICT = {
      zh: {
        'pill.none': '压缩 0 次',
        'pill.count': '压缩 {count} 次',
        'aria': '上下文守卫：已压缩 {count} 次，已用上下文 {percent}%',
        'panel.title': '上下文守卫',
        'panel.used': '已用上下文',
        'panel.window': '上下文窗口',
        'panel.armed': '自动压缩',
        'panel.armed.ready': '已就绪（每轮结束后检查）',
        'panel.armed.missing': '未就绪：没找到 compaction 服务',
        'panel.threshold': '自动压缩阈值',
        'panel.handoffAfter': '压缩几次后写 handoff',
        'panel.compactions': '已压缩次数',
        'panel.freed': '上次释放',
        'panel.freed.unit': '{tokens} tokens',
        'panel.handoff': 'handoff',
        'panel.handoff.waiting': '压缩满 {count} 次后自动写出',
        'panel.handoff.due': '已写出，建议开新会话',
        'panel.when': '每轮对话自然结束后检查；任务运行中绝不压缩',
        'panel.hold': '按住上下键可连续调整',
        'panel.saved': '已保存',
        'panel.saveFailed': '保存失败：{message}',
        'value.unknown': '—',
        'dec': '减小',
        'inc': '增大',
      },
      en: {
        'pill.none': 'compacted 0×',
        'pill.count': 'compacted {count}×',
        'aria': 'Context guard: {count} compactions, context {percent}% used',
        'panel.title': 'Context guard',
        'panel.used': 'Context used',
        'panel.window': 'Context window',
        'panel.armed': 'Auto-compact',
        'panel.armed.ready': 'ready (checked after each turn)',
        'panel.armed.missing': 'not wired: no compaction service found',
        'panel.threshold': 'Auto-compact threshold',
        'panel.handoffAfter': 'Compactions before handoff',
        'panel.compactions': 'Compactions',
        'panel.freed': 'Last freed',
        'panel.freed.unit': '{tokens} tokens',
        'panel.handoff': 'Handoff',
        'panel.handoff.waiting': 'written automatically at {count} compactions',
        'panel.handoff.due': 'written — start a new session',
        'panel.when': 'checked after each turn ends; never mid-task',
        'panel.hold': 'hold the arrows to repeat',
        'panel.saved': 'saved',
        'panel.saveFailed': 'save failed: {message}',
        'value.unknown': '—',
        'dec': 'Decrease',
        'inc': 'Increase',
      },
    };

    // 面板排版照抄宿主面板（会话统计对话框 .bRhRbq_panel / ContextMeter .JObwrW_panel）：
    //   font-size:12px; line-height:18px; padding:16px; radius:--dsw-radius-lg;
    //   background:--dsw-specific-menu; shadow:--dsw-elevation-prominent。
    // **不能**用 --dsh-content-font-size-secondary：那个会被 ui-theme 的 fontSize
    // 放大（本机 17），面板就会比自带面板大一圈。
    //
    // pill 的度量照抄同排的两块：
    //   StatsPills  → color:--dsw-alias-label-tertiary; gap:6px; padding:1px 8px; radius:999px
    //   ContextMeter→ font-size:--dsh-content-font-size-secondary(13px);
    //                 line-height:calc(20px + --dsh-content-font-delta-secondary)
    const CSS = `
.cguard_anchor{position:relative;min-width:0;display:inline-flex;
  font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.cguard_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);
  font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;
  background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;
  display:inline-flex;cursor:pointer}
.cguard_pill:hover{color:var(--dsw-alias-label-secondary)}
.cguard_pill[data-open="true"]{color:var(--dsw-alias-label-primary)}
.cguard_pill[data-due="true"]{color:var(--dsw-alias-state-warn-primary)}
.cguard_icon{width:13px;height:13px;flex:none;display:block}
.cguard_panel{position:absolute;bottom:calc(100% + 8px);right:0;left:auto;z-index:1100;
  box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);
  width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);
  color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;
  font-size:12px;line-height:18px;backdrop-filter:var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent)}
.cguard_title{color:var(--dsw-alias-label-primary);font-weight:500;
  align-items:center;gap:6px;margin-bottom:8px;display:flex}
.cguard_rows{color:var(--dsw-alias-label-tertiary);margin:0;display:grid;
  grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px}
.cguard_rows dt{white-space:nowrap}
.cguard_rows dd{margin:0;color:var(--dsw-alias-label-primary);font-weight:500;
  text-align:right;font-variant-numeric:tabular-nums;
  display:flex;align-items:center;justify-content:flex-end;gap:4px}
.cguard_step{box-sizing:border-box;width:16px;height:16px;padding:0;flex:none;
  color:var(--dsw-alias-label-secondary);background:0 0;border:none;
  border-radius:var(--dsw-radius-sm);cursor:pointer;display:inline-flex;
  align-items:center;justify-content:center}
.cguard_step:hover{background:var(--dsw-alias-interactive-bg-hover-solid);
  color:var(--dsw-alias-label-primary)}
.cguard_step:disabled{opacity:.35;cursor:default;background:0 0}
.cguard_step svg{width:10px;height:10px;display:block}
.cguard_value{min-width:40px;text-align:right;font-variant-numeric:tabular-nums}
.cguard_note{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-tertiary)}
.cguard_note[data-due="true"]{color:var(--dsw-alias-state-warn-primary);font-weight:600}
.cguard_note[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.cguard_note[data-ok="true"]{color:var(--dsw-alias-state-success-primary)}
.cguard_hint{margin-top:2px;color:var(--dsw-alias-label-tertiary);opacity:.8}
.cguard_label{text-overflow:ellipsis;min-width:0;overflow:hidden}

/* ── 手机适配 ────────────────────────────────────────────────────────────────
   作用域锚在 :root.dsh-phone —— 那是 dsh-mobile-ui 给手机打的类（含它的 force 开关），
   跟着它走就能和隔壁那套手机层自动一致。
   为什么要单独写：手机层把同槽的 stats 药丸调成了 11px/15px，但那条规则只作用于
   [data-composer-stats]；本插件的药丸是它的**兄弟节点**，覆盖不到，必须自己对齐。
   最后一段 @media 是兜底：万一没装 dsh-mobile-ui，纯按屏宽也能适配。 */
:root.dsh-phone .cguard_anchor{font-size:11px;line-height:15px}
:root.dsh-phone .cguard_pill{gap:4px;padding:1px 6px}
:root.dsh-phone .cguard_icon{width:12px;height:12px}
:root.dsh-phone .cguard_panel{position:fixed;left:calc(8px + env(safe-area-inset-left,0px));
  right:calc(8px + env(safe-area-inset-right,0px));bottom:calc(84px + env(safe-area-inset-bottom,0px));
  width:auto;min-width:0;max-width:none;max-height:55dvh;overflow-y:auto;
  -webkit-overflow-scrolling:touch;padding:14px;font-size:13px;line-height:19px}
:root.dsh-phone .cguard_step{width:34px;height:34px}
:root.dsh-phone .cguard_step svg{width:14px;height:14px}
:root.dsh-phone .cguard_rows{gap:8px 12px;grid-template-columns:minmax(64px,auto) minmax(0,1fr)}
:root.dsh-phone .cguard_value{min-width:36px}
:root.dsh-phone .cguard_note{margin-top:10px;padding-top:10px}

/* 手机：右侧「上下文份额 / 压缩」改成上下堆叠 —— 与左侧两行 stats 左右对称，
   同时把药丸压到只剩图标 + N×，少占横宽（原先会挤掉最左边的图标）。
   cguard_dock 这个标记类由 JS 打在 composer dock 上（见 GuardPill 里的 effect）：
   不用 :has() —— 旧浏览器（Chrome <105 / Safari <15.4）会整条丢弃选择器，
   宿主 dock 的类名又是哈希的、不能写死。 */
.cguard_short{display:none}
:root.dsh-phone .cguard_full{display:none}
:root.dsh-phone .cguard_short{display:inline}
:root.dsh-phone .cguard_dock{display:grid;
  grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;
  align-items:center;justify-content:stretch;column-gap:8px}
:root.dsh-phone .cguard_dock > [data-composer-stats]{grid-area:1/1/3/2;min-width:0}
:root.dsh-phone .cguard_dock > :not([data-composer-stats]):not(.cguard_anchor):last-child{
  grid-area:1/2/2/3;justify-self:end}
:root.dsh-phone .cguard_dock > .cguard_anchor{grid-area:2/2/3/3;justify-self:end}

/* 与上面同款，但改用 JS 判定出的 cguard_phone —— 更可靠：不依赖手机层的类，
   也不依赖媒体查询（没有 viewport meta 时手机布局视口是 980px，媒体查询不触发）。 */
.cguard_phone .cguard_anchor{font-size:11px;line-height:15px}
.cguard_phone .cguard_pill{gap:4px;padding:1px 6px}
.cguard_phone .cguard_icon{width:12px;height:12px}
.cguard_phone .cguard_full{display:none}
.cguard_phone .cguard_short{display:inline}
.cguard_phone .cguard_panel{position:fixed;left:calc(8px + env(safe-area-inset-left,0px));
  right:calc(8px + env(safe-area-inset-right,0px));bottom:calc(84px + env(safe-area-inset-bottom,0px));
  width:auto;min-width:0;max-width:none;max-height:55dvh;overflow-y:auto;
  -webkit-overflow-scrolling:touch;padding:14px;font-size:13px;line-height:19px}
.cguard_phone .cguard_step{width:34px;height:34px}
.cguard_phone .cguard_step svg{width:14px;height:14px}
.cguard_phone .cguard_rows{gap:8px 12px;grid-template-columns:minmax(64px,auto) minmax(0,1fr)}
.cguard_phone .cguard_value{min-width:36px}
.cguard_phone .cguard_note{margin-top:10px;padding-top:10px}
.cguard_dock.cguard_phone{display:grid;
  grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;
  align-items:center;justify-content:stretch;column-gap:8px}
.cguard_dock.cguard_phone > [data-composer-stats]{grid-area:1/1/3/2;min-width:0}
.cguard_dock.cguard_phone > :not([data-composer-stats]):not(.cguard_anchor):last-child{
  grid-area:1/2/2/3;justify-self:end}
.cguard_dock.cguard_phone > .cguard_anchor{grid-area:2/2/3/3;justify-self:end}
@media (max-width:520px){
  .cguard_panel{position:fixed;left:calc(8px + env(safe-area-inset-left,0px));
    right:calc(8px + env(safe-area-inset-right,0px));bottom:calc(84px + env(safe-area-inset-bottom,0px));
    width:auto;min-width:0;max-width:none;max-height:55dvh;overflow-y:auto;
    -webkit-overflow-scrolling:touch;padding:14px;font-size:13px;line-height:19px}
  .cguard_step{width:34px;height:34px}
  .cguard_step svg{width:14px;height:14px}
  /* 兜底：手机层没装/没判定成手机时，纯按屏宽也做同样的堆叠 */
  .cguard_full{display:none}
  .cguard_short{display:inline}
  .cguard_dock{display:grid;
    grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;
    align-items:center;justify-content:stretch;column-gap:8px}
  .cguard_dock > [data-composer-stats]{grid-area:1/1/3/2;min-width:0}
  .cguard_dock > :not([data-composer-stats]):not(.cguard_anchor):last-child{
    grid-area:1/2/2/3;justify-self:end}
  .cguard_dock > .cguard_anchor{grid-area:2/2/3/3;justify-self:end}
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

    /** zip 压缩包图标：方框 + 拉链虚线 + 拉链头。 */
    function ZipIcon(props) {
      return h(
        'svg',
        Object.assign({ className: 'cguard_icon', viewBox: '0 0 14 14', 'aria-hidden': true }, props),
        h('rect', { x: 2.9, y: 1.3, width: 8.2, height: 11.4, rx: 1.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.15 }),
        h('line', { x1: 7, y1: 3.1, x2: 7, y2: 10.9, stroke: 'currentColor', strokeWidth: 1.15, strokeDasharray: '1.5 1.6' }),
        h('rect', { x: 6.05, y: 3.3, width: 1.9, height: 2.3, rx: 0.5, fill: 'currentColor' }),
      );
    }

    /** 上下箭头（步进按钮）。 */
    function Chevron(props) {
      const up = props.direction === 'up';
      return h(
        'svg',
        { viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', {
          d: up ? 'M2.5 7.5 6 4l3.5 3.5' : 'M2.5 4.5 6 8l3.5-3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /**
     * 按住连发的步进按钮。
     *
     * 手感：按下立即走一格 → 350ms 后重复，每 130ms 一格 → 1.2s 后加速到 60ms 一格。
     *
     * 两点是踩过的坑：
     *   - **每次重复必须重新读取当前值**。`onStep` 用父组件传入的函数每次渲染都会变，
     *     但定时器持有的是按下那一刻的闭包；若它把值算成"基准值 ± 1 格"，
     *     连按就只会停在 ±1 格。所以父组件的 `push` 走 ref 读最新值（见 GuardPill）。
     *   - 键盘用户也要能按：指针产生的 click 已经由 pointerdown 处理过，
     *     用 `event.detail === 0` 只放行键盘触发的那次。
     */
    function StepButton(props) {
      const { direction, disabled, label, onStep, children } = props;
      const timers = React.useRef({ timeout: undefined, interval: undefined });

      const stop = React.useCallback(() => {
        const t = timers.current;
        if (t.timeout !== undefined) clearTimeout(t.timeout);
        if (t.interval !== undefined) clearInterval(t.interval);
        t.timeout = undefined;
        t.interval = undefined;
      }, []);

      React.useEffect(() => stop, [stop]);

      const start = React.useCallback(
        (event) => {
          if (disabled === true) return;
          event.preventDefault();
          onStep();
          const t = timers.current;
          t.timeout = setTimeout(() => {
            const startedAt = Date.now();
            let delay = 130;
            t.interval = setInterval(() => {
              onStep();
              if (Date.now() - startedAt > 1200 && delay !== 60) {
                clearInterval(t.interval);
                delay = 60;
                t.interval = setInterval(onStep, delay);
              }
            }, delay);
          }, 350);
        },
        [disabled, onStep],
      );

      return h(
        'button',
        {
          type: 'button',
          className: 'cguard_step',
          'data-direction': direction,
          'aria-label': label,
          title: label,
          disabled: disabled === true,
          onPointerDown: start,
          onPointerUp: stop,
          onPointerCancel: stop,
          onPointerLeave: stop,
          onContextMenu: (event) => event.preventDefault(),
          onClick: (event) => {
            // 键盘（Enter/Space）产生的 click detail 为 0；指针的已由 pointerdown 处理。
            if (event.detail === 0) onStep();
          },
        },
        children,
      );
    }

    function GuardPill({ useProjection, t }) {
      const guard = useProjection('contextGuard');
      const pressure = useProjection('contextPressure');
      const [open, setOpen] = React.useState(false);
      const [draft, setDraft] = React.useState(null);
      // 保存成功后的权威值。**不能**保存后回落到投影：投影只在会话事件时重发布，
      // 而改设置不产生会话事件，回落到投影会让面板立刻弹回旧值（看着像"没保存"）。
      const [saved, setSaved] = React.useState(null);
      const [savedFlash, setSavedFlash] = React.useState(false);
      // 提前声明：下面的 dock 标记 effect 要用它（否则 TDZ 报错，整个药丸会崩）。
      const rootRef = React.useRef(null);

      /**
       * 给 composer dock 打标记类（手机端要在这个容器上做网格：上下文份额在上、
       * 压缩药丸在下），并由 JS 判定手机、加 `cguard_phone`。
       *
       * 为什么不用 CSS 的 `:has()`：要 Chrome 105+ / Safari 15.4+，旧浏览器会**整条丢弃**
       * 选择器。为什么不只靠媒体查询：没有 viewport meta 时手机布局视口是 980px，
       * `max-width:520px` 永远不触发。为什么不只靠手机层的 `dsh-phone` 类：它可能没打。
       * 宿主 dock 的类名又是 CSS-module 哈希，写死即失效 —— 所以三者都别依赖，用 JS 判定。
       */
      React.useEffect(() => {
        const self = rootRef.current;
        if (self === null) return undefined;
        // slot 条目直接挂在 dock 下（renderer 的 list 分支返回 Fragment，
        // guarded / RootEntry 都不产生 DOM），所以父节点就是 dock。
        const dock = self.parentElement;
        if (dock === null || dock === document.body) return undefined;

        const sync = () => {
          const phone =
            document.documentElement.classList.contains('dsh-phone') ||
            window.matchMedia('(pointer: coarse)').matches ||
            window.matchMedia('(max-width: 520px)').matches;
          dock.classList.add('cguard_dock');
          dock.classList.toggle('cguard_phone', phone);
        };
        sync();

        // 手机层的开关、旋转、改窗口都要跟着重算。
        const observer = new MutationObserver(sync);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', sync);
        window.addEventListener('orientationchange', sync);
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', sync);
          window.removeEventListener('orientationchange', sync);
          dock.classList.remove('cguard_dock', 'cguard_phone');
        };
      }, []);
      const [saveError, setSaveError] = React.useState(null);
      const draftRef = React.useRef(null);
      const saveTimer = React.useRef(undefined);
      const flashTimer = React.useRef(undefined);

      // 文案走 locale 服务；拿不到 t 时退回中文字典，保证面板不会因语言包缺失而空白。
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

      // 点面板外 / 按 Esc 关闭。
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

      const contextWindow = num(pressure?.contextWindow) ?? num(guard?.contextWindow);
      const used = num(pressure?.projectedTokens) ?? num(pressure?.pressureTokens);
      const percent =
        contextWindow !== undefined && contextWindow > 0 && used !== undefined ? Math.round((used / contextWindow) * 100) : undefined;
      const compactions = num(guard?.compactions) ?? 0;
      const due = guard?.handoffDue === true;

      // 显示值优先级：面板上的即时值 → 最近一次保存成功的值 → host 投影。
      const shownThreshold =
        num(draft?.thresholdPercent) ?? num(saved?.thresholdPercent) ?? num(guard?.thresholdPercent) ?? 60;
      const shownAfter = num(draft?.handoffAfter) ?? num(saved?.handoffAfter) ?? num(guard?.handoffAfter) ?? 2;

      /**
       * 改一个设置：更新 draft → 250ms 去抖后 POST 回 host → 成功后清 draft
       * （之后以投影为准），失败则回退并显示原因。
       *
       * `patch(base)` 拿最新的 draft 作为基准，所以按住连发能真的累积。
       */
      const push = (patch) => {
        const base = {
          thresholdPercent:
            num(draftRef.current?.thresholdPercent) ?? num(saved?.thresholdPercent) ?? num(guard?.thresholdPercent) ?? 60,
          handoffAfter:
            num(draftRef.current?.handoffAfter) ?? num(saved?.handoffAfter) ?? num(guard?.handoffAfter) ?? 2,
        };
        const next = Object.assign({}, base, patch(base));
        draftRef.current = next;
        setDraft(next);
        setSaveError(null);
        if (saveTimer.current !== undefined) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
          try {
            const response = await fetch(`${ROUTE}/setSettings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: `${Date.now()}`,
                method: 'setSettings',
                payload: {
                  thresholdRatio: next.thresholdPercent / 100,
                  handoffAfterCompactions: next.handoffAfter,
                },
              }),
            });
            const json = await response.json();
            const result = json?.result;
            if (result?.ok !== true) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
            draftRef.current = null;
            // 保存成功后**留着这个值**（投影要等下一次会话事件才会更新）。
            setSaved(next);
            setDraft(null);
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

      if (guard === undefined && pressure === undefined) return null;

      const label = tr('pill.count', { count: compactions });
      const aria = tr('aria', { count: compactions, percent: percent ?? '—' });

      /** 一行「标签 … [▼] 值 [▲]」，返回 [dt, dd] 一对。 */
      const stepperRow = (term, value, unit, min, max, step, onDelta) => [
        h('dt', { key: `t-${term}` }, term),
        h(
          'dd',
          { key: `d-${term}` },
          h(
            StepButton,
            { key: 'dec', direction: 'down', disabled: value <= min, label: tr('dec'), onStep: () => onDelta(-step) },
            h(Chevron, { direction: 'down' }),
          ),
          h('span', { key: 'value', className: 'cguard_value' }, `${value}${unit}`),
          h(
            StepButton,
            { key: 'inc', direction: 'up', disabled: value >= max, label: tr('inc'), onStep: () => onDelta(step) },
            h(Chevron, { direction: 'up' }),
          ),
        ),
      ];

      const rows = [
        [tr('panel.used'), percent === undefined ? tr('value.unknown') : `${percent}%`],
        [tr('panel.window'), contextWindow === undefined ? tr('value.unknown') : compact(contextWindow)],
        [
          tr('panel.armed'),
          guard?.armed === true ? tr('panel.armed.ready') : guard === undefined ? tr('value.unknown') : tr('panel.armed.missing'),
        ],
        stepperRow(tr('panel.threshold'), shownThreshold, '%', THRESHOLD_MIN, THRESHOLD_MAX, THRESHOLD_STEP, (delta) =>
          push((base) => ({ thresholdPercent: clamp(base.thresholdPercent + delta, THRESHOLD_MIN, THRESHOLD_MAX) })),
        ),
        stepperRow(tr('panel.handoffAfter'), shownAfter, '×', COUNT_MIN, COUNT_MAX, 1, (delta) =>
          push((base) => ({ handoffAfter: clamp(base.handoffAfter + delta, COUNT_MIN, COUNT_MAX) })),
        ),
        [tr('panel.compactions'), String(compactions)],
        [tr('panel.freed'), tr('panel.freed.unit', { tokens: compact(num(guard?.lastFreedTokens)) })],
        [
          tr('panel.handoff'),
          guard?.handoffDue === undefined
            ? tr('value.unknown')
            : due
              ? tr('panel.handoff.due')
              : tr('panel.handoff.waiting', { count: shownAfter }),
        ],
      ];

      return h(
        'span',
        { className: 'cguard_anchor', ref: rootRef },
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'trigger',
            type: 'button',
            className: 'cguard_pill',
            'data-open': open ? 'true' : 'false',
            'data-due': due ? 'true' : 'false',
            'aria-label': aria,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            title: aria,
            onClick: () => setOpen((value) => !value),
          },
          [
            h(ZipIcon, { key: 'icon' }),
            // 手机只显示 "N×"（省横宽），桌面显示完整文案。
            // 按钮本身带 aria-label，所以这层显示切换不影响无障碍。
            h('span', { key: 'label', className: 'cguard_label cguard_full' }, label),
            h(
              'span',
              { key: 'short', className: 'cguard_label cguard_short', 'aria-hidden': true },
              `${compactions}×`,
            ),
          ],
        ),
        open &&
          h('div', { key: 'panel', className: 'cguard_panel', role: 'dialog', 'aria-label': tr('panel.title') }, [
            h('div', { key: 'title', className: 'cguard_title' }, [h(ZipIcon, { key: 'icon' }), h('span', { key: 'text' }, tr('panel.title'))]),
            h(
              'dl',
              { key: 'rows', className: 'cguard_rows' },
              rows.flatMap(([term, value]) => [h('dt', { key: `t-${term}` }, term), h('dd', { key: `d-${term}` }, value)]),
            ),
            h('div', { key: 'when', className: 'cguard_note' }, tr('panel.when')),
            h('div', { key: 'hint', className: 'cguard_hint' }, tr('panel.hold')),
            savedFlash && h('div', { key: 'saved', className: 'cguard_note', 'data-ok': 'true' }, tr('panel.saved')),
            saveError !== null &&
              h('div', { key: 'err', className: 'cguard_note', 'data-error': 'true' }, tr('panel.saveFailed', { message: saveError })),
          ]),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 语言包：dicts 形式 { zh, en }，与 ui-chat 的用法一致。
        ctx.effect(() => ctx.locale.register(NS, DICT), 'context-guard: dictionaries');
        // 用新 id 加在自带 pill 旁边（复用宿主 id "stats" 会顶掉它，这里不这么做）。
        // slots.inject 的注册随所属声明销毁，不需要额外 cleanup。
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'context-guard', order: 1, locale: NS }, GuardPill),
        );
      },
    };
  },
});
