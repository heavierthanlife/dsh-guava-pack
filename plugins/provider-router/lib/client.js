// dsh-provider-router — Client half: a settings section that shows each
// provider's routing mode with a manual toggle (direct / ssr), styled with
// theme tokens so it reads correctly in light, dark and cyberpunk themes.
//
// ## How the page reaches the Host
//
// The Host registers a plain HTTP route on `ctx.webServer`:
//     POST <origin>/provider-router/<endpoint>
//     body     { type: 'client-request', rpcId, method, payload }
//     response { type: 'server-response', rpcId, result: { ok, value } | { ok, error } }
// (see lib/index.js for why `ctx.connection.rpc.handle` and `ctx.provide` are
// both unusable here).
//
// The page posts to it with a plain same-origin `fetch`. That deliberately
// avoids the connection handle's `ctx.remote.$host.rpc` caller: the handle only
// exists once the connection is established, so resolving it inside `apply`
// captured `null` forever and the section reported "rpc unavailable".
//
// No `inject` beyond `slots` is needed now, since nothing here reads `ctx`.

window.__ModuleLoader__.load({
  id: 'dsh-provider-router',
  factory(require) {
    var React = require('react');
    var h = React.createElement;

    var ROUTE = '/provider-router';

    var LABELS = {
      title: '供应商路由',
      desc: '每个供应商的请求走直连还是经 SSR（翻墙）。切换后由本机的本地路由代理生效。',
      direct: '直连',
      ssr: '经 SSR',
      categoryDomestic: '国内 · 直连',
      categoryForeign: '翻墙 · 经 SSR',
      loading: '读取中…',
      error: '读取路由状态失败',
      empty: '（没有任何供应商可显示）',
      control: {
        router: '由路由代理控制',
        bridge: '由本地桥接控制（读同一 mode.json）',
        external: '由外部工具控制 · 开关不可用',
        direct: '不经过本代理（直连上游）',
        unknown: '未判定（读不到 baseURL）',
        'router-missing-upstream': '上游表缺这一条 → 会 404',
      },
      modeLabel: { direct: '直连', ssr: '经 SSR', auto: '自动实测' },
      auto: '自动',
      measured: '已实测',
      measureNow: '实测',
      measuring: '测试中…',
      measuredWhy: '依据',
      routerDown: '路由代理没响应（8318）—— 下面这些开关可能不会生效',
      staleHost: '宿主插件是旧版本，面板展示的供应商可能不完整。请重启一次 DSH：~/dsh/restart-dsh.sh',
      hintCycle: '点按钮循环：直连 → 经 SSR → 自动实测',
      hintMeasure: '「自动」会在每次决策前实测两条路，取更快的那条（带 10 分钟缓存）。',
      dormant: '未注册',
      unset: '未设置（按内置默认；点按钮可选「自动实测」）',
      provider: {
        'xiaomi-token-plan-cn': '小米 MiMo（国内）',
        'opencode-go': 'DeepSeek via opencode-go',
        'antigravity': 'Antigravity（本地桥接）',
        'agentrouter': 'AgentRouter',
        'commandcode': 'CommandCode（本地桥接）',
      },
    };

    /**
     * `control` says where the mode is actually enforced:
     *   router   — baseURL points at 127.0.0.1:8318, so the switch is real.
     *   bridge   — a local bridge owns the upstream request; it hot-reads the
     *              same mode.json, so the switch is real too.
     *   external — a third-party tool (antigravity-tools on :8045) owns the
     *              egress; this plugin cannot change it, so no switch is shown.
     */
    /**
     * 供应商目录**不再写死**。
     *
     * 以前这里是 5 条硬编码，而 profile 里已经有 7 家 —— 新供应商永远不出现在面板、
     * `auto` 静默回落 direct（实测漂移）。现在目录来自 host：`ctx.llm.listProviders()`
     * ∪ `listConfigurableProviders()` ∪ 内置兜底，control 由 profile 里真实 baseURL 推导。
     *
     * 这里只保留**友好名覆盖**：显示名是产品文案，不是事实，放在客户端最合适。
     */

    function randomId() {
      return 'pr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /**
     * 这一行在**路由代理 / mode.json 里的键**。
     *
     * profile 的 id 不一定等于代理认识的路径前缀（例如 `agentrouter-responses`
     * 的 baseURL 是 `8318/agentrouter/v1`，代理只认 `agentrouter`）。发给 host 的
     * setMode/measure 以及查 resolved/measurements 都必须用这个键，否则请求会被
     * 代理判成 unknown provider、开关也落进了代理不读的键上 —— 静默失效。
     */
    function keyOf(p) {
      return p && typeof p.routerKey === 'string' && p.routerKey !== '' ? p.routerKey : p && p.id;
    }

    /** POST one endpoint to the Host route and unwrap the result envelope. */
    function callHost(endpoint, payload) {
      var rpcId = randomId();
      return fetch(ROUTE + '/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: endpoint, payload: payload || {} }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (full) {
        var result = full && full.result;
        if (!result || result.ok !== true) {
          var msg = result && result.error && result.error.message ? result.error.message : 'host call failed';
          throw new Error(msg);
        }
        return result.value;
      });
    }

    function ProviderRouterSection() {
      var pair = React.useState(null);
      var state = pair[0];
      var setState = pair[1];
      var errPair = React.useState(null);
      var err = errPair[0];
      var setErr = errPair[1];

      function reload() {
        return callHost('getState')
          .then(function (s) { setState(s); setErr(null); })
          .catch(function (e) { setErr(e); });
      }

      React.useEffect(function () {
        var alive = true;
        callHost('getState')
          .then(function (s) { if (alive) { setState(s); setErr(null); } })
          .catch(function (e) { if (alive) setErr(e); });
        return function () { alive = false; };
      }, []);

      var busyPair = React.useState(null);
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      /**
       * 三态循环：direct → ssr → auto。
       *
       * `auto` 不是"再一种固定值"，而是**每次决策前实测两条路**（见 host 的
       * measureProvider）。把它放进循环而不是单独一个开关，是因为它和
       * direct/ssr 是互斥的三选一语义。
       */
      function cycle(providerId, requested) {
        var order = ['direct', 'ssr', 'auto'];
        var idx = order.indexOf(requested);
        var next = order[(idx + 1) % order.length];
        setErr(null);
        callHost('setMode', { provider: providerId, mode: next })
          .then(reload)
          .catch(function (e) { setErr(e); });
      }

      /** 让路由代理当场实测该家（direct vs SSR），并把结果写进缓存。 */
      function measureNow(providerId) {
        if (busy) return;
        setBusy(providerId);
        setErr(null);
        callHost('measure', { provider: providerId })
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || 'measure failed');
            return reload();
          })
          .catch(function (e) { setErr(e); })
          .then(function () { setBusy(null); });
      }

      var rowStyle = {
        // 手机窄屏：允许换行，否则长备注与两个按钮会把行撑出屏幕
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', rowGap: 6,
        gap: 12, padding: '12px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14))',
      };

      var children = [
        h('div', { key: 'desc', style: { fontSize: 12, opacity: 0.62, lineHeight: 1.6, marginBottom: 4 } }, LABELS.desc),
      ];

      if (err) {
        children.push(h('div', {
          key: 'err',
          style: { color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12, margin: '8px 0', wordBreak: 'break-word' },
        }, LABELS.error + '：' + ((err && err.message) || '')));
      }

      if (!state) {
        children.push(h('div', { key: 'loading', style: { fontSize: 12, opacity: 0.55, padding: '12px 0' } }, LABELS.loading));
      } else {
        var resolved = state.resolved || {};
        var measurements = state.measurements || {};
        var providers = state.providers || [];

        // 版本握手：host 没到 v2 说明它还是旧版（client 走 HMR 会先更新）
        if (typeof state.apiVersion !== 'number' || state.apiVersion < 2) {
          children.push(h('div', {
            key: 'stale',
            style: { color: 'var(--dsw-alias-state-warning-primary, #f5a524)', fontSize: 12, margin: '6px 0', lineHeight: 1.5 },
          }, LABELS.staleHost));
        }
        if (state.router && state.router.reachable === false) {
          children.push(h('div', {
            key: 'rdown',
            style: { color: 'var(--dsw-alias-state-warning-primary, #f5a524)', fontSize: 12, margin: '6px 0' },
          }, LABELS.routerDown));
        }

        var rows = providers.map(function (p) {
          var rk = keyOf(p);
          var decision = resolved[rk] || {};
          var effective = decision.resolved || 'direct';
          var requested = decision.requested || effective;
          var name = LABELS.provider[p.id] || p.name || p.id;
          var isSsr = effective === 'ssr';
          var isAuto = requested === 'auto';
          var locked = p.control === 'external' || p.control === 'direct' || p.control === 'unknown';
          var controlText = LABELS.control[p.control] || '';

          var meta = [];
          if (decision.reason === 'default') meta.push(LABELS.unset);
          if (p.control !== 'router' && p.control !== 'bridge') meta.push(controlText);
          if (p.note) meta.push(p.note);
          var hit = measurements[rk];
          if (hit && hit.direct && hit.ssr) {
            meta.push(LABELS.measuredWhy + '：' + (hit.reason || ''));
          }

          var trailing;
          if (locked) {
            trailing = h('div', {
              key: 'locked',
              title: controlText,
              style: { flex: 'none', fontSize: 11, opacity: 0.5, textAlign: 'right', maxWidth: 160, lineHeight: 1.4 },
            }, (LABELS.modeLabel[effective] || effective) + '｜' + controlText);
          } else {
            var label = isAuto
              ? LABELS.auto + '（' + (LABELS.modeLabel[effective] || effective) + '）'
              : (LABELS.modeLabel[requested] || requested);
            trailing = h('div', { key: 'ctl', style: { flex: 'none', display: 'flex', gap: 6, alignItems: 'center' } }, [
              p.control === 'router' ? h('button', {
                key: 'm', type: 'button',
                disabled: busy === rk,
                title: LABELS.hintMeasure,
                onClick: function () { measureNow(rk); },
                style: {
                  cursor: 'pointer', fontSize: 11, padding: '6px 10px', borderRadius: 6, minHeight: 34,
                  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
                  background: 'transparent', color: 'inherit', opacity: busy === rk ? 0.5 : 0.85,
                },
              }, busy === rk ? LABELS.measuring : LABELS.measureNow) : null,
              h('button', {
                key: 'btn', type: 'button',
                onClick: function () { cycle(rk, requested); },
                'aria-pressed': isSsr,
                title: LABELS.hintCycle,
                style: {
                  cursor: 'pointer', borderRadius: 999,
                  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
                  background: isSsr
                    ? 'var(--dsw-alias-state-business-tertiary, rgba(0,240,255,0.12))'
                    : 'var(--dsw-alias-bg-layer-2, transparent)',
                  color: isSsr
                    ? 'var(--dsw-alias-label-primary-bluish, var(--dsw-alias-label-primary, inherit))'
                    : 'var(--dsw-alias-label-secondary, inherit)',
                  fontSize: 12, padding: '6px 12px', minHeight: 34,
                },
              }, label),
            ]);
          }

          return h('div', { key: p.id, style: rowStyle }, [
            h('div', { key: 'info', style: { minWidth: 0, flex: '1 1 160px' } }, [
              h('div', { key: 'n', style: { fontSize: 13, fontWeight: 500 } }, [
                name,
                p.live === false ? h('span', {
                  key: 'dormant',
                  style: { fontSize: 10, opacity: 0.55, marginLeft: 6, fontWeight: 400 },
                }, LABELS.dormant) : null,
              ]),
              h('div', { key: 'c', style: { fontSize: 11, opacity: 0.55, marginTop: 2, lineHeight: 1.5, wordBreak: 'break-word' } }, meta.join('；')),
            ]),
            trailing,
          ]);
        });
        if (rows.length === 0) {
          rows.push(h('div', { key: 'empty', style: { fontSize: 12, opacity: 0.55, padding: '12px 0' } }, LABELS.empty));
        }
        children.push(h('div', { key: 'list' }, rows));
      }

      return h('div', { style: { padding: '2px 0' } }, children);
    }

    /* ------------------------------------------------------------------ *
     * 连接信息：显示当前 DSH 进程的登录 token，方便复制到手机/平板
     * （token 每次 DSH 重启都会变，所以必须现取）
     * ------------------------------------------------------------------ */

    var ACCESS = {
      title: '连接信息',
      desc: 'DSH 每次启动都会换新的登录 token，下面的链接就是当前这一份。手机/平板请用 Tailscale 那条。',
      loading: '读取中…',
      failed: '读取失败',
      noToken: '未能取到 token（连接服务未提供）',
      local: '本机浏览器',
      tailnet: '手机 / 平板（Tailscale）',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      tokenLabel: 'Token',
      tailnetMissing: '未检测到 Tailscale 域名（/etc/resolv.conf 里没有 search 域）',
    };

    function CopyRow(props) {
      var pair = React.useState(false);
      var copied = pair[0];
      var setCopied = pair[1];

      function doCopy() {
        try {
          var p = navigator.clipboard && navigator.clipboard.writeText(props.text);
          if (p && typeof p.then === 'function') {
            p.then(function () { setCopied(true); setTimeout(function () { setCopied(false); }, 1500); })
             .catch(function () { setCopied(false); });
            return;
          }
          setCopied(false);
        } catch (e) {
          setCopied(false);
        }
      }

      return h('div', { style: { marginTop: 12 } }, [
        h('div', { key: 'l', style: { fontSize: 11, opacity: 0.55, marginBottom: 4 } }, props.label),
        h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h('code', {
            key: 'v',
            style: {
              flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.5, wordBreak: 'break-all',
              padding: '6px 8px', borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
              background: 'var(--dsw-alias-bg-layer-2, transparent)',
            },
          }, props.text),
          h('button', {
            key: 'b', type: 'button', onClick: doCopy,
            style: {
              flex: 'none', cursor: 'pointer', fontSize: 12, padding: '5px 10px', borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
              background: 'transparent', color: 'inherit',
            },
          }, copied ? ACCESS.copied : ACCESS.copy),
        ]),
      ]);
    }

    function AccessSection() {
      var pair = React.useState(null);
      var data = pair[0];
      var setData = pair[1];
      var errPair = React.useState(null);
      var err = errPair[0];
      var setErr = errPair[1];

      React.useEffect(function () {
        var alive = true;
        var origin = 'http://127.0.0.1:3080';
        try { origin = window.location.origin; } catch (e) {}
        callHost('getToken', { origin: origin })
          .then(function (d) { if (alive) { setData(d); setErr(null); } })
          .catch(function (e) { if (alive) setErr(e); });
        return function () { alive = false; };
      }, []);

      var children = [
        h('div', { key: 'desc', style: { fontSize: 12, opacity: 0.62, lineHeight: 1.6 } }, ACCESS.desc),
      ];

      if (err) {
        children.push(h('div', {
          key: 'err',
          style: { color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12, marginTop: 8, wordBreak: 'break-word' },
        }, ACCESS.failed + '：' + ((err && err.message) || '')));
      } else if (!data) {
        children.push(h('div', { key: 'l', style: { fontSize: 12, opacity: 0.55, marginTop: 8 } }, ACCESS.loading));
      } else if (!data.token) {
        children.push(h('div', { key: 'n', style: { fontSize: 12, opacity: 0.55, marginTop: 8 } }, ACCESS.noToken));
      } else {
        var port = '3080';
        try { port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80'); } catch (e) {}
        var localUrl = 'http://127.0.0.1:' + port + '/?token=' + data.token;
        children.push(h(CopyRow, { key: 'tok', label: ACCESS.tokenLabel, text: data.token }));
        children.push(h(CopyRow, { key: 'loc', label: ACCESS.local, text: localUrl }));
        if (data.tailnetHost) {
          children.push(h(CopyRow, {
            key: 'tn',
            label: ACCESS.tailnet,
            text: 'https://' + data.tailnetHost + '/?token=' + data.token,
          }));
        } else {
          children.push(h('div', { key: 'tnmiss', style: { fontSize: 11, opacity: 0.5, marginTop: 10 } }, ACCESS.tailnetMissing));
        }
      }

      return h('div', { style: { padding: '2px 0' } }, children);
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        try {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section', id: 'provider-router', order: 115, label: LABELS.title,
            }, ProviderRouterSection);
          });
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section', id: 'dsh-access', order: 120, label: ACCESS.title,
            }, AccessSection);
          });
        } catch (e) {
          try { console.warn('[dsh-provider-router] apply failed:', e); } catch (_) {}
        }
      },
    };
  },
});
