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
      },
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
    var PROVIDERS = [
      { id: 'xiaomi-token-plan-cn', domestic: true, control: 'router' },
      { id: 'opencode-go', domestic: false, control: 'router' },
      { id: 'antigravity', domestic: false, control: 'external' },
      { id: 'agentrouter', domestic: false, control: 'router' },
      { id: 'commandcode', domestic: false, control: 'bridge' },
    ];

    function randomId() {
      return 'pr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
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

      function toggle(providerId, current) {
        var next = current === 'ssr' ? 'direct' : 'ssr';
        callHost('setMode', { provider: providerId, mode: next })
          .then(reload)
          .catch(function (e) { setErr(e); });
      }

      var rowStyle = {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
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
        var rows = PROVIDERS.map(function (p) {
          var mode = resolved[p.id];
          var name = LABELS.provider[p.id] || p.id;
          var category = p.domestic ? LABELS.categoryDomestic : LABELS.categoryForeign;
          var isSsr = mode === 'ssr';
          var locked = p.control === 'external';
          var controlText = LABELS.control[p.control] || '';

          var trailing = locked
            ? h('div', {
                key: 'locked',
                title: controlText,
                style: {
                  flex: 'none', fontSize: 11, opacity: 0.5, textAlign: 'right',
                  maxWidth: 150, lineHeight: 1.4,
                },
              }, (isSsr ? LABELS.ssr : LABELS.direct) + '｜' + controlText)
            : h('button', {
                key: 'btn', type: 'button',
                onClick: function () { toggle(p.id, mode); },
                'aria-pressed': isSsr,
                title: controlText,
                style: {
                  flex: 'none', cursor: 'pointer', borderRadius: 999,
                  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
                  background: isSsr
                    ? 'var(--dsw-alias-state-business-tertiary, rgba(0,240,255,0.12))'
                    : 'var(--dsw-alias-bg-layer-2, transparent)',
                  color: isSsr
                    ? 'var(--dsw-alias-label-primary-bluish, var(--dsw-alias-label-primary, inherit))'
                    : 'var(--dsw-alias-label-secondary, inherit)',
                  fontSize: 12, padding: '4px 12px',
                },
              }, isSsr ? LABELS.ssr : LABELS.direct);

          return h('div', { key: p.id, style: rowStyle }, [
            h('div', { key: 'info', style: { minWidth: 0 } }, [
              h('div', { key: 'n', style: { fontSize: 13, fontWeight: 500 } }, name),
              h('div', { key: 'c', style: { fontSize: 11, opacity: 0.55, marginTop: 2 } }, category),
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
