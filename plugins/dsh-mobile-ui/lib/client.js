// dsh-mobile-ui — Client half: phone-only typography + a phone-only drawer toggle.
//
// SCOPE（**这行注释以前写的是"只改字号"，那是错的 —— 已按代码更正**）：
//   这个插件**不再自己搭布局层**，但它确实**碰了两处不属于"字号"的东西**：
//     1. 侧栏抽屉开关：注册进官方槽 `conversation.header.leading`（**只在手机模式占座**，
//        桌面/平板会让出该座位 —— 它是 single 槽，占着会挡住别的插件）；
//     2. 一个全透明点击捕获层（`shell.overlay`，点抽屉外面关闭）。
//   另外 CSS 里**有定位/布局规则**（`position:fixed`、`flex-direction` 等 8 处），
//   主要集中在设置面板与 dock 的手机适配，不是"只改字号"。
//
//   历史：更早的版本还**强制单列 frame + 覆盖式抽屉**，那把手机 UI 弄黑屏了，
//   所以那层布局被整体回滚 —— 上面说的"不再自己搭布局层"指的是**这件事**。
//
// What it does:
//   * Phone-scoped type scale + a user-tunable conversation font size.
//   * Touch ergonomics (tap highlight, 300ms double-tap delay, :active feedback).
//   * Overflow / safe-area guards.
//   * 手机模式下的侧栏抽屉开关 + 点外部关闭（见上）。
//
// Why the overrides are `!important` and declared on `body` as well as `:root`:
//   the theme presenter writes `--dsh-content-font-size` as an INLINE variable
//   on body (theme-presenter.d.ts: "Body variable carrying the user's content
//   font size in px"), and an inline author style beats a normal stylesheet
//   declaration. Without `!important` on a `body`-level rule the font-size
//   control is silently dead.
//
// React note: settings updates are computed and applied OUTSIDE any setState
// updater — doing DOM work or a second setState inside an updater is
// unsupported (updaters may run twice, or during render).
//
// Everything is wrapped in try/catch so a failure can never blank the app.

window.__ModuleLoader__.load({
  id: 'dsh-mobile-ui',
  factory(require) {
    var React = require('react');
    var h = React.createElement;

    var PHONE_CLASS = 'dsh-phone';
    var NOPRESS_CLASS = 'dsh-nopress';
    var STYLE_ID = 'dsh-mobile-ui-style';
    var STORE_KEY = 'dsh-mobile-ui.settings';

    /** A phone: short physical side <= 520 CSS px. Tablets start near 600. */
    var PHONE_SHORT_SIDE = 520;
    /** The type scale the multipliers below were measured against. */
    var BASELINE_PX = 14;

    var FONT_MIN = 12;
    var FONT_MAX = 20;
    var DEFAULTS = { fontPx: 13, press: true, force: false, enterNewline: true, rememberLocale: true, onlineWatchdog: true };

    /** 看门狗统计，供设置面板诊断显示。 */
    var onlineStats = { probes: 0, recoveries: 0, disconnects: 0, lastAt: 0, phaseOf: null };

    var SAMPLE = '手机上的对话正文应该像 App 一样好读：字够大、行距够松、点得到。';
    var SAMPLE_CODE = 'const answer = nums.filter(n => n % 2 === 0).map(n => n * n);';

    var T = {
      title: '移动端显示',
      desc: '只改字号，不动布局。只在手机尺寸的屏幕上生效；平板和桌面完全不受影响。',
      fontLabel: '字号（整体缩放）',
      fontHint: '正文、界面控件、代码字号按同一比例联动。基准 14px＝完全不改动。',
      previewLabel: '效果预览',
      previewHint: '这一段就是按当前字号渲染的（对话正文用的是这一档）。',
      pressLabel: '按压反馈',
      pressHint: '手机上没有 hover，点按控件时给一个即时视觉回应。',
      forceLabel: '在桌面也启用',
      forceHint: '预览用：勾上后桌面窗口收窄到 ≤560px 也能看到手机样式。',
      statusLabel: '当前状态',
      detected: '已判定为手机',
      notDetected: '未判定为手机（平板 / 桌面）',
      reasonScreen: '依据：屏幕短边 ≤ ' + PHONE_SHORT_SIDE + 'px',
      reasonForced: '依据：手动强制开启',
      reasonNone: '依据：无',
      reset: '恢复默认',
      drawerLabel: '展开 / 收起侧栏',
      scrimLabel: '关闭侧栏',
      enterLabel: '回车键换行',
      enterHint: '手机上键盘没有 Shift 键，所以按回车无法换行。开启后：回车＝换行，发送请点发送按钮。',
      localeLabel: '记住语言选择',
      localeHint: '通过网址（非本机地址）打开时，DSH 不会把语言偏好存到服务端 —— 改了语言一刷新就回英文。开启后在本机浏览器里记一份，进页面自动补回。仅在这种网页上生效，本机打开时不影响。',
      watchdogLabel: '流式显示中断时自动恢复',
      watchdogHint: '手机蜂窝网络下浏览器常误报"离线"，而 DSH 的流式通道在这时会挂起且不重试（指令发得出去、但回复不实时显示，切 WiFi 才恢复）。开启后：自称离线时用真实请求探活，确认能通就补发上线事件把它叫醒。真离线时不会有任何动作。',
    };

    /* ---------------------------------------------------------------- *
     * 设置
     * ---------------------------------------------------------------- */

    function readSettings() {
      // 从 DEFAULTS 起步：enterNewline / rememberLocale / onlineWatchdog 三个键
      // 在旧版本里只有 localStorage 里存过才会出现，导致全新安装时它们是 undefined
      // （面板勾选框 checked={undefined} 显示"关闭"，而功能判定用的是 `!== false`，
      // 实际是开启）。逐键校验/夹取逻辑保持不变。
      var out = Object.assign({}, DEFAULTS);
      try {
        var raw = localStorage.getItem(STORE_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p && typeof p === 'object') {
            if (typeof p.fontPx === 'number' && isFinite(p.fontPx)) {
              out.fontPx = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(p.fontPx)));
            }
            if (typeof p.press === 'boolean') out.press = p.press;
            if (typeof p.force === 'boolean') out.force = p.force;
            if (typeof p.enterNewline === 'boolean') out.enterNewline = p.enterNewline;
            if (typeof p.rememberLocale === 'boolean') out.rememberLocale = p.rememberLocale;
            if (typeof p.onlineWatchdog === 'boolean') out.onlineWatchdog = p.onlineWatchdog;
          }
        }
      } catch (e) {}
      return out;
    }

    function writeSettings(next) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch (e) {}
    }

    /** 界面控件缩放：与正文字号同比例。14px 基准 = 1。 */
    function uiScaleFor(fontPx) { return fontPx / BASELINE_PX; }

    /** 当前生效的设置，供 keydown 监听器实时读取（避免闭包拿到旧值）。 */
    var liveSettings = { fontPx: DEFAULTS.fontPx, press: DEFAULTS.press, force: DEFAULTS.force, enterNewline: DEFAULTS.enterNewline };

    /**
     * 手机态变化时的回调，由 `apply` 装上。
     *
     * 为什么需要它：`conversation.header.leading` 是 **single** 槽，桌面/平板下侧栏开关
     * 本来就被 CSS 隐藏，占着座位没意义却会挡住别的插件 —— 所以只在手机模式下占座。
     * 而手机态是 `applyToRoot` 算出来的，它在模块作用域、拿不到 `ctx`，于是用这个回调
     * 把状态递进去（只有设置里的 force 开关会改变它；屏幕短边不会变）。
     */
    var onPhoneStateChange = null;

    /**
     * 手机上把「回车」变成换行。
     *
     * 依据（读自 dsh-client-ui-conversation 源码）：输入框通过 shortcuts 服务注册了
     *   fixed.send    → { code:'Enter', modifiers: [] }
     *   fixed.newline → { code:'Enter', modifiers: ['shift'] }
     * 而编辑器内部也是 `_l(evt,'Enter',{shiftKey:true})` → isInsertLineBreak = true。
     * 所以只要在事件到达应用的监听器之前把 shiftKey 改成 true，走的就是**应用自己的
     * 换行分支** —— 不是在 DOM 里硬塞内容，也不需要阻止冒泡。
     *
     * 用 document 的捕获阶段：React 17+ 把监听器挂在根容器上，document 捕获一定更早。
     * 只对富文本编辑器（contenteditable）生效：设置里的单行输入框仍保持回车提交。
     */
    function installEnterAsNewline(isEnabled) {
      var onKeyDown = function (e) {
        try {
          if (!isEnabled()) return;
          if (e.key !== 'Enter') return;
          if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.isComposing || e.keyCode === 229) return; // 输入法组字中，别动
          var t = e.target;
          if (!t || !t.isContentEditable) return;
          Object.defineProperty(e, 'shiftKey', { value: true, configurable: true });
        } catch (err) {}
      };
      document.addEventListener('keydown', onKeyDown, true);
      return function () { document.removeEventListener('keydown', onKeyDown, true); };
    }

    var LOCALE_KEY = 'dsh-mobile-ui.locale';

    /**
     * 「浏览器误报离线」看门狗 —— 修「手机上不实时流式显示」。
     *
     * 机制（读自 dsh-client-connection 源码）：
     *   watchBrowserNetwork() 只用 navigator.onLine + online/offline 事件驱动
     *   ConnectionController.setNetworkAvailable()，而承载**流式通道**的
     *   ConnectionController.loop() 在该标志为 false 时是这样的：
     *
     *     if (!this.networkAvailable && !this.immediateRetry) {
     *       this.emitState("disconnected");
     *       await waitForAbort(retryDelay.signal);   // ← 挂起等事件，不会自己重试
     *     }
     *
     *   普通 RPC 走的是另一条 fetch 路径（createWebConnectionRpc），根本不查这个
     *   标志 —— 所以「指令发得出去、桌面端也正常跑，但手机端流式不回来」，
     *   而且只有切网卡触发一次 online 事件才会恢复。这与用户的现象完全吻合。
     *
     * 手机蜂窝网络下 navigator.onLine 很容易是 false（Android 的联网校验探测在
     * 国内常被墙；VPN 在场时也常被判为未验证），于是 DSH 把流式通道永久挂起。
     *
     * 这里只打**误报**：浏览器自称离线时，用一次真实同源请求探活；**能通**才补发
     * 一个 online 事件把循环叫醒。真离线时请求会失败，什么都不做。
     */
    function installOnlineWatchdog(ctx, isEnabled) {
      var probing = false;
      var disposers = [];
      // 连接状态与重连都来自 `connection` 服务（@deepseek-ai/dsh-client-connection：
      // state.getSnapshot() / state.subscribe() / reconnect()）。
      // 之前读的 ctx.remote.$host 只有 { home, isLoopback }，既没有 state 也没有
      // reconnect —— 于是 phaseOf() 永远返回 null，探活与诊断全是死的。
      // 服务可能比本插件晚就绪（connection 由 client-connection 的 apply 里 provide），
      // 所以懒取并缓存，订阅也延后到服务可用时再挂一次。
      var conn = null;
      var connOf = function () {
        if (!conn) {
          try { conn = ctx.get ? ctx.get('connection') : null; } catch (e) {}
        }
        return conn;
      };
      var stateWatched = false;

      /** 连接状态：'connected' | 'connecting' | 'disconnected'（兼容对象或字符串两种形状）。 */
      var phaseOf = function () {
        try {
          var c = connOf();
          var raw = c && c.state && c.state.getSnapshot ? c.state.getSnapshot() : null;
          if (raw && typeof raw === 'object') return raw.phase || raw.status || raw.state || null;
          return typeof raw === 'string' ? raw : null;
        } catch (e) { return null; }
      };
      onlineStats.phaseOf = phaseOf;

      // 断连次数统计（诊断用，只读不干预）
      var watchState = function () {
        if (stateWatched) return;
        var c = connOf();
        if (!c || !c.state || typeof c.state.subscribe !== 'function') return;
        stateWatched = true;
        try {
          var last = phaseOf();
          disposers.push(c.state.subscribe(function () {
            var now = phaseOf();
            if (now === last) return;
            if (now === 'disconnected') onlineStats.disconnects++;
            last = now;
          }));
        } catch (e) { stateWatched = false; }
      };
      watchState();

      /**
       * 探活成功后的唤醒：补发标准 online 事件（把 networkAvailable 翻回 true），
       * 再调官方 reconnect()（重置退避并立刻换一代连接）。
       * reconnect 会让挂起在 await waitForAbort(retryDelay.signal) 的 loop 立即恢复。
       */
      var wake = function () {
        onlineStats.recoveries++;
        onlineStats.lastAt = Date.now();
        try { window.dispatchEvent(new Event('online')); } catch (e) {}
        try {
          var c = connOf();
          if (c && typeof c.reconnect === 'function') c.reconnect();
        } catch (e) {}
      };

      var verify = function () {
        if (probing || !isEnabled()) return;
        watchState(); // 服务晚就绪时在这里补挂状态订阅
        // 只在「自称离线」或「确实处于断连」时才发请求，平时零开销
        if (navigator.onLine !== false && phaseOf() !== 'disconnected') return;
        probing = true;
        onlineStats.probes++;
        var finish = function () { probing = false; };
        try {
          fetch(location.origin + '/', {
            method: 'GET', cache: 'no-store', credentials: 'same-origin',
          }).then(function (r) {
            // 拿到任何 HTTP 响应就说明链路是通的 —— 浏览器的 offline 是误报
            if (r) wake();
            finish();
          }).catch(finish);
        } catch (e) { finish(); }
      };

      // 浏览器刚报离线就立刻探一次（不延迟：真在切换网络时请求会失败，什么都不做）
      var onOffline = function () { verify(); };
      window.addEventListener('offline', onOffline);

      // 兜底：页面可能在「一开始就自称离线」时加载（那时不会有 offline 事件），
      // 或者 DSH 处于断连但浏览器仍报在线。每 10 秒检查一次，条件不满足就零请求。
      var timer = setInterval(verify, 10000);

      return function () {
        window.removeEventListener('offline', onOffline);
        clearInterval(timer);
        disposers.forEach(function (d) { try { if (typeof d === 'function') d(); } catch (e) {} });
      };
    }

    /**
     * 语言偏好的「本机兜底持久化」。
     *
     * 背景（读自 dsh-client-locale 源码）：偏好存在 settings 作用域 ——
     *   new LocaleRuntime(ctx, ctx.configForms.get(LOCALE_SETTINGS_NAMESPACE))
     * 而 DSH 对**非 loopback 页面**把设置持久化设成 "memory"
     * （dsh-client-ui-settings：ctx.remote.$host.isLoopback ? "host" : "memory"），
     * 写入只留在内存里。于是手机（通过 Tailscale 域名打开）改成中文、一刷新
     * 就回英文，而电脑走 127.0.0.1 是 loopback，所以能保持。
     *
     * 这里不去拆 DSH 的安全边界（settings 含 provider 凭据，那正是它只对
     * loopback 开放的原因），只在浏览器 localStorage 里存一份，进页面时补写
     * 回去。显示语言本来就是「每台设备各自的偏好」，放本地也更合理。
     *
     * 只在**确知是非 loopback** 时才介入：loopback 页面 DSH 自己能持久化，
     * 抢着写反而会让它无法跟随 Host 侧的语言设置。
     */
    /**
     * 给 composer dock 打标记，让上面的两步网格在手机端生效。
     *
     * 为什么用 JS 打标记而不是纯 CSS：dock 的类名是 CSS module 哈希
     * （形如 `uV2eYG_dock`），而 `:has()` 在旧浏览器会被整条丢弃。
     * 定位方式：从**统计锚点** `[class*="bOPqQW"]` 向上找到 `<hash>_dock`。
     * 注意不能引用 apply() 作用域的 root（模块级函数 → ReferenceError，
     * 会被 apply 的 try/catch 静默吞掉，这是本轮踩过的坑）。
     */
    function installComposerDock() {
      var tagged = [];
      function isPhone() {
        return document.documentElement.classList.contains(PHONE_CLASS);
      }
      function findDock() {
        var stats = document.querySelector('[class*="bOPqQW_anchor"], [class*="bOPqQW_root"]');
        var el = stats;
        for (var i = 0; i < 8 && el; i += 1) {
          if (/(^|\s)[^\s]*_dock(\s|$)/.test(String(el.className || ''))) return el;
          el = el.parentElement;
        }
        var docks = document.querySelectorAll('[class*="_dock"]');
        for (var j = 0; j < docks.length; j += 1) return docks[j];
        return null;
      }
      function sync() {
        for (var i = 0; i < tagged.length; i += 1) {
          try { tagged[i].el.classList.remove(tagged[i].cls); } catch (e) {}
        }
        tagged = [];
        var dock = findDock();
        if (!dock) return;
        dock.classList.add('dsh-mobile-dock');
        tagged.push({ el: dock, cls: 'dsh-mobile-dock' });
        if (isPhone()) dock.setAttribute('data-dsh-mobile-dock', '1');
      }
      sync();
      var observer = new MutationObserver(function () { sync(); });
      try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
      return function () {
        try { observer.disconnect(); } catch (e) {}
        for (var i = 0; i < tagged.length; i += 1) {
          try {
            tagged[i].el.classList.remove(tagged[i].cls);
            tagged[i].el.removeAttribute('data-dsh-mobile-dock');
          } catch (e) {}
        }
        tagged = [];
      };
    }

    function installLocaleMemo(ctx, locale) {
      var enabled = function () { return liveSettings.rememberLocale !== false; };
      var host = null;
      try { host = ctx.remote && ctx.remote.$host; } catch (e) {}
      if (!host || host.isLoopback !== false) return; // 仅非 loopback 需要兜底
      if (!locale || typeof locale.getLocale !== 'function') return;

      var readSaved = function () {
        try { return localStorage.getItem(LOCALE_KEY); } catch (e) { return null; }
      };
      var activeOf = function () {
        try {
          var snap = locale.getLocale();
          return snap && typeof snap.active === 'string' ? snap.active : null;
        } catch (e) { return null; }
      };

      var saved = readSaved();
      var current = activeOf();
      // 只在保存的语言仍然可选时才补写，避免写进一个已不存在的 id
      if (enabled() && saved && current && saved !== current) {
        try {
          var snap = locale.getLocale();
          var known = snap && Array.isArray(snap.locales)
            && snap.locales.some(function (l) { return l && l.id === saved; });
          if (known && typeof locale.setLocale === 'function') locale.setLocale(saved);
        } catch (e) {}
      }

      if (typeof locale.subscribe !== 'function') return;
      return locale.subscribe(function () {
        try {
          if (!enabled()) return;
          var now = activeOf();
          if (now && now !== saved) {
            saved = now;
            localStorage.setItem(LOCALE_KEY, now);
          }
        } catch (e) {}
      });
    }

    /**
     * 判定是否是「手机」：只看**设备屏幕的短边**，完全不看窗口大小。
     *
     * 之前同时用 innerWidth/innerHeight 兜底，结果这三类会被误判成手机：
     *   · 平板分屏（半屏 ≈ 400px）
     *   · 平板悬浮窗
     *   · 桌面把窗口拖窄
     * 平板本来用得好好的，不该因为窗口一变窄就整体换布局。现在：
     *   手机 = 屏幕短边 ≤ 520px；平板 / 桌面一律不进入手机模式。
     * 想在窄窗口里预览手机样式，用设置里的「在桌面也启用」开关（force）。
     */
    function detectPhone() {
      try {
        var screenShort = Math.min(
          (window.screen && window.screen.width) || 9999,
          (window.screen && window.screen.height) || 9999,
        );
        return screenShort <= PHONE_SHORT_SIDE ? 'screen-short-side' : '';
      } catch (e) { return ''; }
    }

    /** 只写 <html> 的 class 与两个自定义属性。不碰任何其它 DOM。 */
    function applyToRoot(settings) {
      liveSettings = settings;
      var root = document.documentElement;
      if (!root) return { active: false, reason: 'no-document' };
      var reason = settings.force ? 'forced' : detectPhone();
      var phone = settings.force ? true : reason !== '';
      root.classList.toggle(PHONE_CLASS, phone);
      root.classList.toggle(NOPRESS_CLASS, !settings.press);
      root.style.setProperty('--dsh-mobile-content-font-size', settings.fontPx + 'px');
      root.style.setProperty('--mui-scale', String(uiScaleFor(settings.fontPx).toFixed(4)));
      // 手机态一变，侧栏开关就要相应地占座/让座（见 onPhoneStateChange 的注释）。
      if (typeof onPhoneStateChange === 'function') {
        try { onPhoneStateChange(phone); } catch (e) {}
      }
      return { active: phone, reason: reason || 'none', scale: uiScaleFor(settings.fontPx) };
    }

    /* ---------------------------------------------------------------- *
     * 样式层：只有字号 + 触控，没有任何布局规则
     * ---------------------------------------------------------------- */

    var SCOPE = ':root.' + PHONE_CLASS + ',\n:root.' + PHONE_CLASS + ' body';

    /**
     * STEP 2 / 3 用的选择器。
     * frame = 拥有 [data-shell-overlay] 直接子节点的元素（悬浮层是它的子节点）。
     * DocumentTitle 返回 null（已核对源码），所以 frame 的第 1 个 div 子节点
     * 就是 sidebarCol —— 用 div:first-of-type 定位。
     */
    var FRAME_PHONE = ':root.' + PHONE_CLASS + ' :has(> [data-shell-overlay])';
    /** 展开态（无 data-sidebar-collapsed）的侧栏列。 */
    var SIDEBAR_EXPANDED = FRAME_PHONE + ':not([data-sidebar-collapsed]) > div:first-of-type';

    function scaled(size, lh) {
      return 'calc(' + size + 'px * var(--mui-scale, 1)) / calc(' + lh + 'px * var(--mui-scale, 1))';
    }

    var UI_TOKENS = [
      ['--dsw-font-xxxs-11', scaled(11, 14), ''],
      ['--dsw-font-xxxs-strong-11', scaled(11, 14), '500 '],
      ['--dsw-font-xxs-12', scaled(12, 18), ''],
      ['--dsw-font-xxs-strong-12', scaled(12, 18), '500 '],
      ['--dsw-font-xs-13', scaled(13, 20), ''],
      ['--dsw-font-xs-strong-13', scaled(13, 20), '500 '],
      ['--dsw-font-s-14', scaled(14, 22), ''],
      ['--dsw-font-s-strong-14', scaled(14, 22), '500 '],
      ['--dsw-font-base-16', scaled(16, 24), ''],
      ['--dsw-font-base-strong-16', scaled(16, 24), '500 '],
      ['--dsw-font-m-18', scaled(16, 28), '500 '],
      ['--dsw-font-l-20', scaled(20, 28), '500 '],
      ['--dsw-font-xl-24', scaled(24, 32), '600 '],
    ];

    var CODE_TOKENS = [
      ['--dsw-font-markdown-code', scaled(12, 19)],
      ['--dsw-font-markdown-code-block', scaled(11, 19)],
      ['--dsw-font-markdown-code-block-small', scaled(11, 16)],
      ['--dsw-font-markdown-small', scaled(12, 20)],
      ['--dsw-font-markdown-small-strong', '600 ' + scaled(12, 20)],
    ];

    var CSS = [
      SCOPE + ' {',
    ]
      .concat(UI_TOKENS.map(function (r) {
        return '  ' + r[0] + ': ' + r[2] + r[1] + ' var(--dsw-font-family) !important;';
      }))
      .concat([
        '',
        '  --dsh-content-font-size: var(--dsh-mobile-content-font-size, ' + BASELINE_PX + 'px) !important;',
        '',
      ])
      .concat(CODE_TOKENS.map(function (r) {
        return '  ' + r[0] + ': ' + r[1] + ' var(--ds-font-family-code) !important;';
      }))
      .concat([
        '',
        '  -webkit-text-size-adjust: 100%;',
        '  text-size-adjust: 100%;',
        '}',
        '',
        ':root.' + PHONE_CLASS + ' * { -webkit-tap-highlight-color: transparent; }',
        ':root.' + PHONE_CLASS + ' a,',
        ':root.' + PHONE_CLASS + ' button,',
        ':root.' + PHONE_CLASS + " [role='button'],",
        ':root.' + PHONE_CLASS + " [role='tab'],",
        ':root.' + PHONE_CLASS + " [role='menuitem'],",
        ':root.' + PHONE_CLASS + " [role='option'],",
        ':root.' + PHONE_CLASS + ' label,',
        ':root.' + PHONE_CLASS + ' summary,',
        ':root.' + PHONE_CLASS + ' select { touch-action: manipulation; }',
        '',
        ':root.' + PHONE_CLASS + ':not(.' + NOPRESS_CLASS + ') button:active,',
        ':root.' + PHONE_CLASS + ':not(.' + NOPRESS_CLASS + ') a:active,',
        ':root.' + PHONE_CLASS + ':not(.' + NOPRESS_CLASS + ") [role='button']:active,",
        ':root.' + PHONE_CLASS + ':not(.' + NOPRESS_CLASS + ") [role='tab']:active,",
        ':root.' + PHONE_CLASS + ':not(.' + NOPRESS_CLASS + ") [role='menuitem']:active { opacity: 0.58; }",
        '',
        '/* 横向不溢出 + 刘海安全区（只作用在 body 的内边距上，不动布局容器） */',
        ':root.' + PHONE_CLASS + ' body {',
        '  overflow-x: hidden;',
        '  overscroll-behavior-y: contain;',
        '  box-sizing: border-box;',
        '  padding-left: env(safe-area-inset-left, 0px);',
        '  padding-right: env(safe-area-inset-right, 0px);',
        '}',
        ':root.' + PHONE_CLASS + ' img,',
        ':root.' + PHONE_CLASS + ' video,',
        ':root.' + PHONE_CLASS + ' canvas { max-width: 100%; height: auto; }',
        ':root.' + PHONE_CLASS + ' pre,',
        ':root.' + PHONE_CLASS + ' table { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }',
        ':root.' + PHONE_CLASS + ' textarea,',
        ':root.' + PHONE_CLASS + " input[type='text'],",
        ':root.' + PHONE_CLASS + " input[type='search'],",
        ':root.' + PHONE_CLASS + ' input:not([type]) { font-size: max(16px, 1em); }',
        '',
        '/* ══ STEP 2：手机上侧栏永不占网格轨道 ══════════════════════════',
        '   收起态本来是 56px 的 rail，压成 0 把宽度还给中列（省 14%）。',
        '   网格是 React 内联 style，必须 !important；中列写 minmax(0,1fr)，',
        '   因为原来的 minmax(400px,1fr) 在 393px 手机上必然横向溢出。',
        '   回滚：删掉这条规则，restore 到“rail 正常占位”。 */',
        FRAME_PHONE + ' {',
        '  grid-template-columns: 0 minmax(0, 1fr) 0 !important;',
        '}',
        '',
        '/* ══ STEP 3：展开态侧栏脱离网格，成为覆盖式抽屉 ══════════════════',
        '   只作用于展开态；收起态那一列本来就 0 宽（自带 overflow:hidden 会裁掉 rail）。',
        '   position:fixed 的元素不会被 frame 的 overflow:hidden 裁切（frame 没有 transform）。',
        '   z-index 25：必须高于 overlayLayer 的 20 —— overlay 自带 position:absolute+z-index,',
        '   它构成层叠上下文，STEP 4 的遮罩就在它内部，抽屉低于 20 就会被遮罩盖住并抢走点击。 */',
        SIDEBAR_EXPANDED + ' {',
        '  position: fixed !important;',
        '  top: 0;',
        '  bottom: 0;',
        '  left: 0;',
        '  width: min(78vw, 300px) !important;',
        '  max-width: none !important;',
        '  min-width: 0 !important;',
        '  z-index: 25;',
        '  box-shadow: 0 0 0 1px rgba(128,128,128,0.16), 0 16px 48px rgba(0,0,0,0.42);',
        '}',
        '',
        '/* 桌面用的拖动条：8px 宽、touch-action:none，在手机上会落进抽屉里抢触摸。',
        '   data-side 是 DragHandle 自己写的稳定属性。 */',
        FRAME_PHONE + ' > [data-side] { display: none !important; }',
        '',
        '/* ══ STEP 4：点抽屉外面关闭（纯点击捕获层，全透明）═════════════════',
        '   刻意用透明背景：这一步只加"点空白关闭"这个交互，不加任何视觉层，',
        '   所以它不可能让界面变黑。想加变暗效果随时说，改一行 background 即可。',
        '   只在「手机 + 展开态」出现，判据与抽屉完全一致。 */',
        '.dsh-mobile-scrim {',
        '  display: none;',
        '  position: fixed;',
        '  inset: 0;',
        '  z-index: 0;',
        '  background: transparent;',
        '  border: 0;',
        '  padding: 0;',
        '  pointer-events: auto;',
        '  cursor: default;',
        '}',
        FRAME_PHONE + ':not([data-sidebar-collapsed]) .dsh-mobile-scrim { display: block; }',
        '',
        '/* ══ STEP 5：设置面板适配手机 ══════════════════════════════════',
        '   面板原本是 width:800px / height:min(800px,100vh-48px) / display:flex（横向），',
        '   在手机上：左导航固定 188px 吃掉近一半宽度，内容被挤到 157px 而 overflow:hidden，',
        '   于是只能看见左上角一小块。这里改成铺满屏幕 + 导航变成顶部横向标签栏。',
        '',
        '   全部用结构选择器，不用 CSS Modules 哈希类名：',
        '   面板自带 data-shortcut-modal="settings"（源码里写死的），',
        '   导航是字面量 <nav>，其第 1 个子节点是标题、第 2 个是标签列表。 */',
        ":root." + PHONE_CLASS + " [data-shortcut-modal='settings'] {",
        '  width: 100vw !important;',
        '  max-width: 100vw !important;',
        '  height: 100vh !important;',
        '  max-height: 100vh !important;',
        '  height: 100dvh !important;',
        '  max-height: 100dvh !important;',
        '  border-radius: 0 !important;',
        '  flex-direction: column !important;',
        '}',
        '',
        '/* 左导航 → 顶部横向标签栏（可横向滑动） */',
        ":root." + PHONE_CLASS + " [data-shortcut-modal='settings'] > nav {",
        '  width: 100% !important;',
        '  flex: none !important;',
        '  flex-direction: row !important;',
        '  align-items: center !important;',
        '  gap: 6px !important;',
        '  padding: 10px 10px 6px !important;',
        '  overflow-x: auto !important;',
        '  overflow-y: hidden !important;',
        '  -webkit-overflow-scrolling: touch;',
        '}',
        "/* 标题在横排标签里没位置，隐藏 */",
        ":root." + PHONE_CLASS + " [data-shortcut-modal='settings'] > nav > div:first-child { display: none !important; }",
        "/* 标签列表本身也横过来 */",
        ":root." + PHONE_CLASS + " [data-shortcut-modal='settings'] > nav > div:nth-child(2) {",
        '  flex-direction: row !important;',
        '  gap: 6px !important;',
        '  overflow: visible !important;',
        '}',
        "/* 每个标签不被压缩、不换行 */",
        ":root." + PHONE_CLASS + " [data-shortcut-modal='settings'] > nav > div:nth-child(2) > button {",
        '  flex: none !important;',
        '  height: 36px !important;',
        '  padding: 6px 12px !important;',
        '  white-space: nowrap !important;',
        '}',
        "/* 内容区拿满剩余高度并自己滚动 */",
        ":root." + PHONE_CLASS + " [data-shortcut-modal='settings'] > div {",
        '  flex: 1 !important;',
        '  min-height: 0 !important;',
        '  width: 100% !important;',
        '}',
        '',
        '/* ══ STEP 6：输入框下方那三个数据小组件 ════════════════════════',
        '   原本是拿不下就各自 ellipsis 的单行 flex（.root{gap:12px;display:flex}',
        '   配 .label{text-overflow:ellipsis;min-width:0;overflow:hidden}），',
        '   手机上三块被压成只剩最后一个完整。改成允许换行 + 禁止收缩。',
        '   钩子：容器自带 data-composer-stats（源自 StatsPills 源码）。',
        '   字号/行距用变量暴露，想再紧只改这两个数：',
        '     --cp-stats-font  默认 11px（原来是 calc(内容字号 - 1px) ≈ 12px）',
        '     --cp-stats-line  默认 15px（原来是 calc(20px + delta) ≈ 20px）',
        '   注：pill 内部是 line-height:inherit，所以改根节点就能整体生效。 */',
        ':root.' + PHONE_CLASS + ' [data-composer-stats] {',
        '  --cp-stats-font: 11px;',
        '  --cp-stats-line: 15px;',
        '  flex-wrap: wrap !important;',
        '  gap: 3px 10px !important;',
        '  padding: 0 8px;',
        '  font-size: var(--cp-stats-font) !important;',
        '  line-height: var(--cp-stats-line) !important;',
        '}',
        ':root.' + PHONE_CLASS + ' [data-composer-stats] span,',
        ':root.' + PHONE_CLASS + ' [data-composer-stats] button {',
        '  min-width: auto !important;',
        '  overflow: visible !important;',
        '  white-space: nowrap !important;',
        '  text-overflow: clip !important;',
        '}',
        '',
        '/* ══ STEP 6.5：输入框下方的 dock —— 复原旧版两列叠放 ═══════════════',
        '   旧版（context-guard 时期）手机上很好看：左边上下两行统计',
        '   （「N 轮 M 步·x tok/s」「xxxM tok·缓存命中 x%」），右边上下两行',
        '   （上下文「63%」+ 插件药丸），都贴在输入栏下方。',
        '   宿主现在把这几块塞在同一个 flex 行里，手机上会挤成一行、字被截断，',
        '   所以这里把它改成 2×2 网格。',
        '   钩子：dock 容器 <hash>_dock（CSS module 哈希，用 JS 打标记），',
        '   子项：统计锚点 [class*="bOPqQW"]、上下文计量 [class*="JObwrW_root"]、',
        '   插件药丸的 [class*="_anchor"]。 */',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-dock {',
        '  display: grid !important;',
        '  grid-template-columns: minmax(0, 1fr) auto !important;',
        '  grid-template-rows: auto auto !important;',
        '  column-gap: 10px !important;',
        '  row-gap: 1px !important;',
        '  align-items: center !important;',
        '  width: 100% !important;',
        '  height: auto !important;',
        '  min-width: 0 !important;',
        '}',
        '/* 左列：统计两行上下叠放，且不截断 */',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-dock [class*="bOPqQW"] {',
        '  grid-column: 1 !important;',
        '  grid-row: 1 / span 2 !important;',
        '  display: flex !important;',
        '  flex-direction: column !important;',
        '  align-items: flex-start !important;',
        '  gap: 0 !important;',
        '  min-width: 0 !important;',
        '  overflow: visible !important;',
        '}',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-dock [class*="bOPqQW"] button,',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-dock [class*="bOPqQW"] span {',
        '  overflow: visible !important;',
        '  text-overflow: clip !important;',
        '  white-space: nowrap !important;',
        '  min-width: 0 !important;',
        '  max-width: 100% !important;',
        '}',
        '/* 右列上行：上下文占用（63%） */',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-dock [class*="JObwrW"] {',
        '  grid-column: 2 !important;',
        '  grid-row: 1 !important;',
        '  justify-self: end !important;',
        '}',
        '/* 右列下行：插件药丸（ACP 等）—— 按内容撑开，不再被压成 0 宽 */',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-dock [class*="_anchor"]:not([class*="bOPqQW"]) {',
        '  grid-column: 2 !important;',
        '  grid-row: 2 !important;',
        '  justify-self: end !important;',
        '  flex: 0 0 auto !important;',
        '  min-width: auto !important;',
        '  max-width: 100% !important;',
        '}',
        '',
        '/* ══ STEP 7：赛博主题的两个悬浮开关别压住发送按钮 ══════════════',
        '   主题把 #cp2077-snd-toggle / #cp2077-deck-toggle 固定在 right:14px，',
        '   bottom:14px / 44px，z-index 10050 —— 正好落在发送按钮上。',
        '   这里在手机上把它们挪到右侧竖直居中，并缩小、半透明。',
        '   --cp-gap 就是两个开关的「中心距」（上一个的 top 到下一个的 top），',
        '   想再紧/再松只改这一个数；想让它们在手机上彻底消失就加 display:none。 */',
        ':root.' + PHONE_CLASS + ' #cp2077-snd-toggle,',
        ':root.' + PHONE_CLASS + ' #cp2077-deck-toggle {',
        '  --cp-gap: 26px;',
        '  right: 0 !important;',
        '  bottom: auto !important;',
        '  font-size: 11px !important;',
        '  padding: 3px 8px !important;',
        '  border-radius: 8px 0 0 8px !important;',
        '  opacity: 0.72;',
        '}',
        ':root.' + PHONE_CLASS + ' #cp2077-deck-toggle { top: calc(50% - var(--cp-gap, 26px) / 2) !important; }',
        ':root.' + PHONE_CLASS + ' #cp2077-snd-toggle { top: calc(50% + var(--cp-gap, 26px) / 2) !important; }',
        '',
        '/* ══ STEP 9：输入栏右下角的「模型 / 思考强度」别被省略 ══════════',
        '   根因（读自 dsh-client-ui-model-selection 源码）：',
        '     .trigger { max-width: min(360px, 45cqw) }',
        '   cqw 相对最近的容器，而 .row 设了 container-type: inline-size。',
        '   手机上 45% 行宽 ≈ 162px，装不下「模型名 + 思考强度」；',
        '   加上 .triggerEffort 的 flex-shrink 是 1000（最先被压没），',
        '   于是思考强度消失、模型名接着省略号。',
        '',
        '   而 .row 本身是 flex-wrap: wrap —— 之所以没换行，是因为内部允许收缩。',
        '   所以：解除 45cqw 上限（改成 100%，仍然不会横向溢出）+ 禁止收缩，',
        '   行就会自动换行，模型名和思考强度独占一行完整显示。',
        '   选择器用 CSS Modules 的「本地名后缀」而不是哈希前缀：',
        '   _triggerLabel / _triggerEffort 这类名字来自源码，升级后依然成立。 */',
        ":root." + PHONE_CLASS + " [data-composer-seat] [class*='_trigger'] {",
        '  max-width: 100% !important;',
        '}',
        ":root." + PHONE_CLASS + " [data-composer-seat] [class*='_triggerLabel'],",
        ":root." + PHONE_CLASS + " [data-composer-seat] [class*='_triggerEffort'] {",
        '  flex-shrink: 0 !important;',
        '  min-width: auto !important;',
        '}',
        '',
        '/* 兜底：DSH 在「装不下」时会切紧凑模式（data-model-compact），把文字隐藏、',
        '   只留图标。但它的测量量的是【已经收缩后】的子元素宽度，needed 永远约等于',
        '   available，所以几乎不触发；一旦触发就会把模型名整个藏掉 —— 手机上那等于',
        '   看不到模型，这里把文字钉回显示。这两个变量是 slot 文档里公开的官方 API。 */',
        ":root." + PHONE_CLASS + " [data-composer-seat] [data-model-compact] {",
        '  --dsh-composer-model-text-display: block !important;',
        '  --dsh-composer-model-icon-display: none !important;',
        '}',
        '',
        '/* ══ STEP 1/8：侧栏开关按钮 ════════════════════════════════════',
        '   原来固定在左上角，会压住会话标题。现在注册进官方座位',
        '   conversation.header.leading（"Global navigation before the Session title"），',
        '   直接排在标题前面 —— 永远不会重叠，观感也原生。',
        '   样式做成头部里的幽灵按钮，不再需要 fixed / 毛玻璃 / z-index。 */',
        '.dsh-mobile-drawer-toggle {',
        '  display: none;',
        '  flex: none;',
        '  align-items: center;',
        '  justify-content: center;',
        '  width: 32px;',
        '  height: 32px;',
        '  padding: 0;',
        '  border: 0;',
        '  border-radius: 8px;',
        '  background: transparent;',
        '  color: inherit;',
        '  cursor: pointer;',
        '}',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-drawer-toggle { display: inline-flex; }',
        ':root.' + PHONE_CLASS + ' .dsh-mobile-drawer-toggle:hover {',
        '  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12));',
        '}',
      ])
      .join('\n');

    /* ---------------------------------------------------------------- *
     * STEP 1：侧栏开关按钮（注册进官方 shell.overlay 悬浮层）
     * ---------------------------------------------------------------- */

    function DrawerToggle(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-mobile-drawer-toggle',
        'aria-label': T.drawerLabel,
        title: T.drawerLabel,
        onClick: props.toggleSidebar,
      }, h('svg', {
        width: 20, height: 20, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true,
      }, [
        h('line', { key: 'a', x1: 3, y1: 6, x2: 21, y2: 6 }),
        h('line', { key: 'b', x1: 3, y1: 12, x2: 21, y2: 12 }),
        h('line', { key: 'c', x1: 3, y1: 18, x2: 21, y2: 18 }),
      ]));
    }

    /** STEP 4：点抽屉外面关闭。全透明，只负责接收点击。 */
    function DrawerScrim(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-mobile-scrim',
        'aria-label': T.scrimLabel,
        tabIndex: -1,
        onClick: props.toggleSidebar,
      });
    }

    /* ---------------------------------------------------------------- *
     * 设置面板
     * ---------------------------------------------------------------- */

    function Row(props) {
      return h('div', { style: { marginTop: 16 } }, [
        h('div', {
          key: 'label',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
        }, [
          h('span', { key: 'l', style: { fontSize: 13, fontWeight: 500 } }, props.label),
          props.value === undefined ? null
            : h('span', { key: 'v', style: { fontSize: 12, opacity: 0.7, fontVariantNumeric: 'tabular-nums' } }, props.value),
        ]),
        props.control,
        props.hint
          ? h('div', { key: 'h', style: { fontSize: 11, opacity: 0.55, marginTop: 4, lineHeight: 1.6 } }, props.hint)
          : null,
      ]);
    }

    function Check(props) {
      return h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, cursor: 'pointer' },
      }, [
        h('input', {
          key: 'cb',
          type: 'checkbox',
          checked: props.checked,
          onChange: function (e) { props.onChange(e.target.checked); },
          style: { width: 16, height: 16 },
        }),
        h('span', { key: 't' }, props.on === undefined ? (props.checked ? '开启' : '关闭') : props.on),
      ]);
    }

    function MobileUiSection(props) {
      var getSettings = props.getSettings;
      var applySettings = props.applySettings;

      var pair = React.useState(getSettings);
      var settings = pair[0];
      var setSettings = pair[1];

      var statusPair = React.useState(function () { return applySettings(getSettings()); });
      var status = statusPair[0];
      var setStatus = statusPair[1];

      React.useEffect(function () {
        var sync = function () {
          setSettings(getSettings());
          setStatus(applySettings(getSettings()));
        };
        sync();
        window.addEventListener('resize', sync, { passive: true });
        window.addEventListener('orientationchange', sync, { passive: true });
        return function () {
          window.removeEventListener('resize', sync);
          window.removeEventListener('orientationchange', sync);
        };
      }, []);

      // 计算与 DOM 写入都在 setState 之外：在 updater 里做这些是 React
      // 不支持的用法，正是它让滑块看起来"拖不动"。
      function update(patch) {
        var next = Object.assign({}, settings, patch);
        writeSettings(next);
        setSettings(next);
        setStatus(applySettings(next));
      }

      var reasonText = status.reason === 'screen-short-side' ? T.reasonScreen
        : status.reason === 'forced' ? T.reasonForced
        : T.reasonNone;

      var shortScreen = Math.min((window.screen && window.screen.width) || 0, (window.screen && window.screen.height) || 0);
      var shortView = Math.min(window.innerWidth, window.innerHeight);

      return h('div', { style: { padding: '2px 0' } }, [
        h('div', { key: 'desc', style: { fontSize: 12, opacity: 0.65, lineHeight: 1.65 } }, T.desc),

        h(Row, {
          key: 'font',
          label: T.fontLabel,
          value: settings.fontPx + 'px',
          hint: T.fontHint,
          control: h('input', {
            type: 'range', min: FONT_MIN, max: FONT_MAX, step: 1,
            value: settings.fontPx,
            'aria-label': T.fontLabel,
            onChange: function (e) { update({ fontPx: Number(e.target.value) }); },
            style: { width: '100%', marginTop: 6, accentColor: 'var(--dsw-alias-brand-primary, #4f8cff)' },
          }),
        }),

        h('div', {
          key: 'preview',
          style: {
            marginTop: 10, padding: '12px 14px', borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
            background: 'var(--dsw-alias-bg-layer-2, transparent)',
          },
        }, [
          h('div', { key: 'l', style: { fontSize: 11, opacity: 0.5, marginBottom: 6 } }, T.previewLabel),
          h('div', { key: 't', style: { fontSize: settings.fontPx + 'px', lineHeight: 1.85, letterSpacing: 0.1 } }, SAMPLE),
          h('div', {
            key: 'c',
            style: {
              marginTop: 8, fontSize: (settings.fontPx - 2) + 'px', lineHeight: 1.7,
              fontFamily: 'var(--ds-font-family-code, monospace)', opacity: 0.85,
              overflowX: 'auto', whiteSpace: 'nowrap',
            },
          }, SAMPLE_CODE),
          h('div', { key: 'h', style: { fontSize: 11, opacity: 0.5, marginTop: 8, lineHeight: 1.6 } }, T.previewHint),
        ]),

        h(Row, {
          key: 'enter',
          label: T.enterLabel,
          hint: T.enterHint,
          control: h(Check, {
            checked: settings.enterNewline,
            onChange: function (v) { update({ enterNewline: v }); },
          }),
        }),

        h(Row, {
          key: 'locale',
          label: T.localeLabel,
          hint: T.localeHint,
          control: h(Check, {
            checked: settings.rememberLocale,
            onChange: function (v) { update({ rememberLocale: v }); },
          }),
        }),

        h(Row, {
          key: 'watchdog',
          label: T.watchdogLabel,
          hint: T.watchdogHint,
          control: h(Check, {
            checked: settings.onlineWatchdog,
            onChange: function (v) { update({ onlineWatchdog: v }); },
          }),
        }),

        h(Row, {
          key: 'press',
          label: T.pressLabel,
          hint: T.pressHint,
          control: h(Check, { checked: settings.press, onChange: function (v) { update({ press: v }); } }),
        }),

        h(Row, {
          key: 'force',
          label: T.forceLabel,
          hint: T.forceHint,
          control: h(Check, {
            checked: settings.force,
            onChange: function (v) { update({ force: v }); },
            on: settings.force ? '已强制开启' : '关闭',
          }),
        }),

        h('div', {
          key: 'status',
          style: {
            marginTop: 16, padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.7,
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
            background: 'var(--dsw-alias-bg-layer-2, transparent)',
          },
        }, [
          h('div', { key: 'a', style: { fontWeight: 500 } },
            T.statusLabel + '：' + (status.active ? T.detected : T.notDetected)),
          h('div', { key: 'b', style: { opacity: 0.7 } }, reasonText),
          h('div', { key: 'c', style: { opacity: 0.7 } },
            '屏幕短边 ' + shortScreen + 'px · 窗口短边 ' + shortView + 'px'),
          h('div', { key: 'd', style: { opacity: 0.7 } },
            '样式层 ' + (document.getElementById(STYLE_ID) ? '已注入' : '缺失')
            + ' · 缩放 x' + (status.scale || 1).toFixed(2)
            + ' · <html> class: ' + (document.documentElement.className || '（空）')),

          // 网络诊断：用来确认「蜂窝网下浏览器误报离线」这个假设
          h('div', { key: 'e', style: { opacity: 0.7 } },
            '网络：navigator.onLine = ' + String(navigator.onLine)
            + ' · 类型 ' + ((navigator.connection && navigator.connection.effectiveType) || '未知')
            + (navigator.connection && navigator.connection.type
                ? '（' + navigator.connection.type + '）' : '')),
          h('div', { key: 'f', style: { opacity: 0.7 } },
            '连接状态：' + (onlineStats.phaseOf && onlineStats.phaseOf() || '未知')
            + ' · 累计断连 ' + onlineStats.disconnects + ' 次'),
          h('div', { key: 'g', style: { opacity: 0.7 } },
            '看门狗：探活 ' + onlineStats.probes + ' 次 · 唤醒 ' + onlineStats.recoveries + ' 次'
            + (onlineStats.lastAt ? ' · 最近 ' + new Date(onlineStats.lastAt).toLocaleTimeString() : '')),
        ]),

        h('button', {
          key: 'reset',
          type: 'button',
          onClick: function () { update(Object.assign({}, DEFAULTS)); },
          style: {
            marginTop: 14, fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
            background: 'transparent', color: 'inherit',
          },
        }, T.reset),
      ]);
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        try {
          var root = document.documentElement;
          if (!root) return;

          var style = document.createElement('style');
          style.id = STYLE_ID;
          style.dataset.plugin = 'dsh-mobile-ui';
          style.textContent = CSS;
          document.head.appendChild(style);

          var state = applyToRoot(readSettings());
          window.__dshMobileUI = {
            active: state.active, reason: state.reason,
            settings: readSettings(), hasStyle: true,
          };

          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section', id: 'mobile-ui', order: 110, label: T.title,
              inject: function () {
                return {
                  getSettings: readSettings,
                  applySettings: function (s) { return applyToRoot(s); },
                };
              },
            }, MobileUiSection);
          });

          // STEP 1/8：侧栏开关。注册进 conversation.header.leading —— 官方定义是
          // "Global navigation before the Session title"。
          //
          // 但它是 **single** 槽：同一优先级上第二个注册者会直接抛
          // `single slot "..." already has a registration`（见 dsh-client-ui-slots 的
          // register）。而桌面/平板下这个按钮本来就被 CSS 隐藏（display:none），
          // **占着座位没有任何意义**，却会让将来任何想用这个座位的插件在加载期炸掉。
          // 而且这张表里 conversation.header.leading 是**唯一 scope:'root' 的头部槽**
          // （其它列表型槽都是 scope:'session'，没会话时不渲染），所以没有"换个列表槽"
          // 这个选项 —— 正解是**只在手机模式下占座，其余时候把座位让出来**。
          //
          // 屏幕短边不会变（detectPhone 只看 screen，不看窗口大小），只有设置里的
          // force 开关会改状态，所以跟着 applyToRoot 同步就够了。
          var toggleSidebar = function () {
            try {
              var layout = ctx.get && ctx.get('layout');
              if (layout && typeof layout.toggleSidebar === 'function') layout.toggleSidebar();
            } catch (e) {}
          };
          var disposeToggle = null;
          var slotReady = false;
          var wantToggle = false;
          function syncDrawerToggle() {
            if (!slotReady) return;
            if (wantToggle && disposeToggle === null) {
              try {
                disposeToggle = ctx.slots.register({
                  name: 'conversation.header.leading',
                  inject: function () { return { toggleSidebar: toggleSidebar }; },
                }, DrawerToggle) || null;
              } catch (e) {
                // 座位已被别人占了：降级成"没有侧栏开关"，而不是把页面弄崩。
                disposeToggle = null;
                console.warn('[dsh-mobile-ui] conversation.header.leading 已被占用，跳过侧栏开关', e);
              }
            } else if (!wantToggle && disposeToggle !== null) {
              try { disposeToggle(); } catch (e) {}
              disposeToggle = null;
            }
          }
          onPhoneStateChange = function (phone) {
            wantToggle = phone === true;
            syncDrawerToggle();
          };

          ctx.slots.inject('conversation.header.leading', function () {
            slotReady = true;
            // 初始态直接读 <html> 上的 class：applyToRoot 在本函数更早处已经写好它，
            // 这样不必依赖两个调用点的先后顺序。
            wantToggle = root.classList.contains(PHONE_CLASS);
            syncDrawerToggle();
            return function () {
              slotReady = false;
              if (disposeToggle !== null) {
                try { disposeToggle(); } catch (e) {}
                disposeToggle = null;
              }
            };
          });

          // STEP 4：点抽屉外面关闭（全透明点击捕获层，留在 shell.overlay 里）
          ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({
              name: 'shell.overlay', id: 'mobile-drawer-scrim', order: 59,
              inject: function () { return { toggleSidebar: toggleSidebar }; },
            }, DrawerScrim);
          });

          ctx.effect(function () {
            return function () {
              try {
                style.remove();
                root.classList.remove(PHONE_CLASS);
                root.classList.remove(NOPRESS_CLASS);
                root.style.removeProperty('--dsh-mobile-content-font-size');
                root.style.removeProperty('--mui-scale');
                delete window.__dshMobileUI;
                onPhoneStateChange = null;
                // 显式让座：不依赖 slots 服务是否会在上下文销毁时回收注册，
                // 自己把座位交出去（single 槽，占着就是占着）。
                if (disposeToggle !== null) {
                  try { disposeToggle(); } catch (e) {}
                  disposeToggle = null;
                }
              } catch (e) {}
            };
          }, 'dsh-mobile-ui: phone font layer');

          // composer dock 两列布局（统计在左、占用量与插件药丸在右）
          ctx.effect(function () {
            return installComposerDock();
          }, 'dsh-mobile-ui: composer dock layout');

          // 手机上的回车＝换行（见 installEnterAsNewline 的注释）
          ctx.effect(function () {
            return installEnterAsNewline(function () {
              return liveSettings.enterNewline !== false
                && root.classList.contains(PHONE_CLASS);
            });
          }, 'dsh-mobile-ui: enter-as-newline');

          // 语言偏好：非 loopback 页面（手机走 Tailscale 域名）DSH 不会持久化，
          // 这里在浏览器本地补一份。详见 installLocaleMemo 的注释。
          // 用 ctx.inject 而不是硬依赖：locale 服务没就绪时不影响其它功能。
          ctx.inject(['locale'], function (scope) {
            ctx.effect(function () {
              return installLocaleMemo(ctx, scope.locale);
            }, 'dsh-mobile-ui: locale memo');
          });

          // 「浏览器误报离线」看门狗 —— 详见 installOnlineWatchdog 的注释。
          ctx.effect(function () {
            return installOnlineWatchdog(ctx, function () {
              return liveSettings.onlineWatchdog !== false;
            });
          }, 'dsh-mobile-ui: offline watchdog');
        } catch (e) {
          // 绝不让插件把整个界面带下去
          try { console.warn('[dsh-mobile-ui] apply failed:', e); } catch (_) {}
        }
      },
    };
  },
});
