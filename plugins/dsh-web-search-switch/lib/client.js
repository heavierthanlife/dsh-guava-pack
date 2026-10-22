/**
 * dsh-web-search-switch — client 半边（设置 → 搜索后端）。
 *
 * 一个分段控件：官方 DeepSeek / Tavily。点一下就切，**不需要重启 DSH**：
 * 偏好写在 host 侧的 `storages/web-search-switch.json`，provider 每次搜索热读。
 *
 * 状态由 host 的 `/web-search-switch` 路由提供；这里只渲染 + 调它。
 * 每个后端会显示"已配置 / 未配置（缺什么 key）"，因为切到一个没 key 的后端之后
 * 搜索会失败，而失败原因必须能提前看见。
 *
 * 客户端插件的加载约定（坑）：本仓库的 client 半边走的是
 * `window.__ModuleLoader__.load({ id, factory(require) })`，**不是 ESM import**。
 * `React` 必须从 `require('react')` 拿；写成 `import` 会在浏览器里直接 404/语法错。
 *
 * @module dsh-web-search-switch/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-web-search-switch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/web-search-switch';

    /**
     * 客户端期望的宿主能力版本。
     * 宿主 `state` 里没有这个字段（= 旧宿主）或版本更低时，**不要假装保存成功** ——
     * 旧宿主不认识 `tavilyApiKey`，会静默忽略，用户看到的就是"点了没反应"。
     */
    const EXPECTED_HOST_API = 2;

    const T = {
      title: '搜索后端',
      desc: '模型调用 web_search 时走哪个后端。切换立即生效，无需重启 DSH。',
      loading: '读取中…',
      notConfigured: '未配置',
      configured: '已配置',
      current: '当前',
      commandHint: '也可以在聊天里用 `/search-backend official|tavily` 切换。',
      keyLabel: 'Tavily API Key',
      keyPlaceholder: 'tvly-...（存在本机 storages，0600，不进配置文件）',
      keySave: '保存 key',
      keySaved: '已保存（本机）',
      keyClear: '清除',
      keyHint: '没 key 时切到 Tavily 会报 CREDENTIAL_MISSING。填在这里可以立刻生效，不用改 .bashrc / 不用重启。',
      fallback: '上次搜索已回落官方后端：',
      fallbackWhy: '原因：',
      hostStale: '宿主端插件是旧版本，无法保存 key（点了不会有反应）。请重启一次 DSH：~/dsh/restart-dsh.sh',
      loaded: '已刷新',
      pinWarning: '注意：web.searchProvider 没有钉在 switch 上，切换不会生效（需要重启 DSH 让 profile 生效）。',
    };

    const CSS = `
.wsw_sec{display:flex;flex-direction:column;gap:10px;padding:2px 0}
.wsw_title{font-weight:600;font-size:15px}
.wsw_desc{font-size:12px;opacity:.65;line-height:18px}
.wsw_seg{display:flex;gap:6px}
.wsw_seg button{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:2px;
  padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);
  background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.wsw_seg button[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);
  color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.wsw_seg button:disabled{opacity:.5;cursor:default}
.wsw_meta{font-size:11px;opacity:.7}
.wsw_bad{color:var(--dsw-alias-state-error-primary)}
.wsw_ok{color:var(--dsw-alias-state-success-primary)}
.wsw_hint{font-size:11px;opacity:.6;line-height:16px}
.wsw_err{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.wsw_key{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.wsw_key label{font-size:12px;opacity:.75}
.wsw_key .row{display:flex;gap:6px}
.wsw_key input{flex:1;min-width:0;padding:5px 8px;border-radius:var(--dsw-radius-sm,6px);
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:12px}
.wsw_key button{padding:5px 10px;border:0;border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.wsw_key button:disabled{opacity:.5;cursor:default}
`;

    /** 调 host 的面板路由（与 session-purge 同一套 client-request 信封）。 */
    async function call(method, payload) {
      const response = await fetch(`${ROUTE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}`, method, payload }),
      });
      const json = await response.json();
      const result = json && json.result;
      if (!result || result.ok !== true) {
        const failure = new Error((result && result.error && result.error.message) || `HTTP ${response.status}`);
        failure.code = (result && result.error && result.error.code) || '';
        throw failure;
      }
      return result.value;
    }

    function SwitchSection() {
      const statePair = React.useState(null);
      const state = statePair[0];
      const setState = statePair[1];
      const errorPair = React.useState('');
      const error = errorPair[0];
      const setError = errorPair[1];
      const busyPair = React.useState(false);
      const busy = busyPair[0];
      const setBusy = busyPair[1];

      React.useEffect(function () {
        let alive = true;
        call('state', {})
          .then(function (value) { if (alive) setState(value); })
          .catch(function (err) { if (alive) setError(String((err && err.message) || err)); });
        return function () { alive = false; };
      }, []);

      var keyPair = React.useState('');
      var keyDraft = keyPair[0];
      var setKeyDraft = keyPair[1];

      function choose(backend) {
        if (busy || (state && backend === state.backend)) return;
        setBusy(true);
        setError('');
        call('set', { backend })
          .then(function (value) { setState(value); })
          .catch(function (err) { setError(String((err && err.message) || err)); })
          .then(function () { setBusy(false); });
      }

      /** 保存/清除 Tavily key：走同一个 set 接口（顺带保持当前后端不变）。 */
      function saveKey(value) {
        if (busy) return;
        // 旧宿主会静默忽略这个字段 —— 与其"点了没反应"，不如当场说明。
        if (!state || typeof state.apiVersion !== 'number' || state.apiVersion < EXPECTED_HOST_API) {
          setError(T.hostStale);
          return;
        }
        setBusy(true);
        setError('');
        call('set', { backend: state ? state.backend : 'official', tavilyApiKey: value })
          .then(function (next) { setState(next); setKeyDraft(''); })
          .catch(function (err) { setError(String((err && err.message) || err)); })
          .then(function () { setBusy(false); });
      }

      const children = [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'title', className: 'wsw_title' }, T.title),
        h('div', { key: 'desc', className: 'wsw_desc' }, T.desc),
      ];

      if (!state) {
        children.push(h('div', { key: 'loading', className: 'wsw_desc' }, error || T.loading));
        return h('div', { className: 'wsw_sec' }, children);
      }

      const backends = state.backends || [];
      children.push(h('div', { key: 'seg', className: 'wsw_seg' },
        backends.map(function (b) {
          const on = b.id === state.backend;
          return h('button', {
            key: b.id,
            type: 'button',
            'data-on': String(on),
            disabled: busy,
            onClick: function () { choose(b.id); },
          }, [
            h('span', { key: 'l' }, b.label + (on ? '（' + T.current + '）' : '')),
            h('span', {
              key: 'm',
              className: 'wsw_meta ' + (b.configured ? 'wsw_ok' : 'wsw_bad'),
            }, b.configured ? T.configured : T.notConfigured + '：' + (b.hint || '')),
          ]);
        })));

      if (error) children.push(h('div', { key: 'err', className: 'wsw_err' }, error));
      if (state.lastFallback) {
        children.push(h('div', { key: 'fb', className: 'wsw_hint' },
          T.fallback + state.lastFallback.from + ' → ' + state.lastFallback.to +
          '（' + T.fallbackWhy + state.lastFallback.reason + '）'));
      }

      // 版本错位：宿主还没升级到支持保存 key。这不是用户的操作问题，必须直说。
      var hostApi = typeof state.apiVersion === 'number' ? state.apiVersion : 0;
      var hostStale = hostApi < EXPECTED_HOST_API;
      if (hostStale) {
        children.push(h('div', { key: 'stale', className: 'wsw_err' }, T.hostStale));
      }

      children.push(h('div', { key: 'key', className: 'wsw_key' }, [
        h('label', { key: 'l' }, T.keyLabel + (state.tavilyKeyFromPanel ? '（' + T.keySaved + '）' : '')),
        h('div', { key: 'row', className: 'row' }, [
          h('input', {
            key: 'i',
            type: 'password',
            value: keyDraft,
            placeholder: T.keyPlaceholder,
            disabled: busy || hostStale,
            onChange: function (e) { setKeyDraft(e.target.value); },
          }),
          h('button', {
            key: 's',
            type: 'button',
            disabled: busy || hostStale || !keyDraft.trim(),
            onClick: function () { saveKey(keyDraft); },
          }, T.keySave),
          state.tavilyKeyFromPanel ? h('button', {
            key: 'c',
            type: 'button',
            disabled: busy || hostStale,
            onClick: function () { saveKey(''); },
          }, T.keyClear) : null,
        ]),
        h('div', { key: 'h', className: 'wsw_hint' }, T.keyHint),
      ]));

      children.push(h('div', { key: 'hint', className: 'wsw_hint' }, T.commandHint));
      if (state.pinned === false) {
        children.push(h('div', { key: 'pin', className: 'wsw_err' }, T.pinWarning));
      }

      return h('div', { className: 'wsw_sec' }, children);
    }

    return {
      // 只要 slots：设置面板的 `settings.section` 槽由 settings shell 声明。
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'web-search-switch',
            order: 120,
            label: T.title,
          }, SwitchSection);
        });
      },
    };
  },
});
