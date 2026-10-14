// dsh-theme-manager — Client-side theme manager (settings section).
//
// Switching is delegated to the theme service (`ctx.theme.setTheme`). This
// plugin deliberately performs NO DOM cleanup: in a 0.2.0 profile every core
// UI package injects its CSS as `<style data-plugin=...>`, so a generic sweep
// of those nodes wipes the application's own stylesheets and breaks the page.
// Each theme plugin is responsible for removing only its own presentation.
//
// The chosen id is also persisted under a small localStorage key so a theme
// plugin can tell a deliberate choice from the boot-time settings adoption
// (the theme service itself only persists light/dark/system).

window.__ModuleLoader__.load({
  id: 'dsh-theme-manager',
  factory(require) {
    var React = require('react');
    var h = React.createElement;

    var PREF_STORE_KEY = 'dsh-theme-manager.preference';

    function persistPreference(id) {
      try {
        localStorage.setItem(PREF_STORE_KEY, id);
      } catch (e) {}
    }

    var T = {
      title: '主题管理',
      desc: '切换当前生效的主题。列表来自主题服务已注册的主题。',
      active: '使用中',
      following: '跟随系统',
      switch: '切换',
      empty: '暂无已注册主题',
      schemeLight: '浅色',
      schemeDark: '深色',
      more: '更多主题',
      collapse: '收起',
      footer: function (n, cur) { return '共 ' + n + ' 个已注册主题 · 当前：' + cur; },
      reload: '切换后立即生效。第三方主题的样式由各自的插件负责加载与清理。'
    };

    // Ids shown at the top level; anything else is grouped below so that a
    // pack registering dozens of themes does not turn the panel into a wall.
    var PRIMARY_IDS = ['light', 'dark', 'cyberpunk2077'];

    // 只做「id → 友好名」的映射；刻意不带 emoji，标题与主题名一律是纯文字。
    var THEME_META = {
      'cyberpunk2077': { name: 'Cyberpunk 2077' },
      'light': { name: '浅色' },
      'dark': { name: '深色' },
      'system': { name: '跟随系统' },
    };

    function themeName(theme) {
      var meta = THEME_META[theme.id];
      return theme.name || (meta && meta.name) || theme.id;
    }

    /** One theme row: name, id, color scheme, switch button. */
    function ThemeRow(props) {
      var theme = props.theme;
      var isActive = props.isActive;
      var following = props.following === true;
      var onSwitch = props.onSwitch;
      var scheme = theme.colorScheme === 'light' ? T.schemeLight : T.schemeDark;

      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          borderRadius: 8,
          border: '1px solid ' + (isActive
            ? 'var(--dsw-alias-brand-primary, #4f8cff)'
            : 'var(--dsw-alias-border-l1, rgba(128,128,128,0.25))'),
          background: isActive
            ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))'
            : 'transparent'
        }
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 600, fontSize: 14 } }, themeName(theme)),
          h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 2 } },
            theme.id + ' · ' + scheme)
        ),
        isActive
          ? h('span', {
              style: {
                fontSize: 12, padding: '3px 10px', borderRadius: 10,
                background: 'var(--dsw-alias-brand-primary, #4f8cff)', color: '#fff'
              }
            }, following ? T.following : T.active)
          : h('button', {
              type: 'button',
              onClick: function () { onSwitch(theme.id); },
              style: {
                fontSize: 12, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
                background: 'transparent', color: 'inherit'
              }
            }, T.switch)
      );
    }

    function rowsFor(themes, current, onSwitch, following) {
      return themes.map(function (t) {
        return h(ThemeRow, {
          key: t.id,
          theme: t,
          isActive: t.id === current,
          following: following === true,
          onSwitch: onSwitch
        });
      });
    }

    /** The settings section itself. */
    function ThemeManagerSection(props) {
      var getSnapshot = props.getSnapshot;
      var setTheme = props.setTheme;
      var subscribe = props.subscribe;

      var pair = React.useState(function () { return getSnapshot(); });
      var snap = pair[0];
      var setSnap = pair[1];

      var openPair = React.useState(false);
      var moreOpen = openPair[0];
      var setMoreOpen = openPair[1];

      React.useEffect(function () {
        setSnap(getSnapshot());
        var off = subscribe(function () { setSnap(getSnapshot()); });
        return typeof off === 'function' ? off : undefined;
      }, []);

      var themes = (snap && snap.themes) || [];
      var preference = snap ? snap.preference : '';
      // preference 可能是 'system'：主题服务已把系统色偏好解析进 snap.active
      // （ThemeSnapshot.active 是生效的 ThemeDefinition）。用它标记真正生效的那一行，
      // 否则 system 下没有任何一行显示"使用中"，页脚也只打印 'system'。
      var resolved = snap && snap.active && typeof snap.active.id === 'string' ? snap.active.id : '';
      var isSystem = preference === 'system';
      var current = isSystem && resolved ? resolved : preference;
      var currentLabel = isSystem && resolved ? resolved + '（' + T.following + '）' : current;

      var primary = themes.filter(function (t) { return PRIMARY_IDS.indexOf(t.id) !== -1; });
      var others = themes.filter(function (t) { return PRIMARY_IDS.indexOf(t.id) === -1; });

      function onSwitch(id) {
        // Remember the choice first, then let the theme service switch.
        persistPreference(id);
        setTheme(id);
      }

      var children = [
        h('div', { key: 'title', style: { fontWeight: 600, fontSize: 15, marginBottom: 4 } }, T.title),
        h('div', { key: 'desc', style: { fontSize: 12, opacity: 0.65, marginBottom: 14 } }, T.desc)
      ];

      if (themes.length === 0) {
        children.push(h('div', { key: 'empty', style: { fontSize: 13, opacity: 0.6 } }, T.empty));
      } else {
        children.push(h('div', {
          key: 'primary',
          style: { display: 'flex', flexDirection: 'column', gap: 8 }
        }, rowsFor(primary.length ? primary : themes, current, onSwitch, isSystem)));

        if (others.length) {
          children.push(h('button', {
            key: 'more-toggle',
            type: 'button',
            onClick: function () { setMoreOpen(!moreOpen); },
            style: {
              marginTop: 14, fontSize: 12, padding: '6px 12px', borderRadius: 6,
              cursor: 'pointer', width: '100%', textAlign: 'left',
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
              background: 'transparent', color: 'inherit'
            }
          }, (moreOpen ? '▾ ' + T.collapse : '▸ ' + T.more) + '（' + others.length + '）'));

          if (moreOpen) {
            children.push(h('div', {
              key: 'others',
              style: {
                display: 'flex', flexDirection: 'column', gap: 8,
                marginTop: 8, maxHeight: 420, overflowY: 'auto', paddingRight: 4
              }
            }, rowsFor(others, current, onSwitch, isSystem)));
          }
        }
      }

      children.push(h('div', {
        key: 'reload',
        style: { marginTop: 16, fontSize: 11, opacity: 0.5 }
      }, T.reload));
      children.push(h('div', {
        key: 'footer',
        style: { marginTop: 4, fontSize: 11, opacity: 0.5 }
      }, T.footer(themes.length, currentLabel)));

      return h('div', { style: { padding: '2px 0' } }, children);
    }

    /**
     * Register the "主题管理" settings section. The slot is claimed through
     * ctx.slots.inject() first: the settings shell declares `settings.section`
     * only once its own entry is mounted.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'theme-manager',
          order: 100,
          label: '主题管理',
          inject: function () {
            return {
              getSnapshot: function () { return ctx.theme.getTheme(); },
              setTheme: function (id) { ctx.theme.setTheme(id); },
              subscribe: function (listener) { return ctx.on('theme/change', listener); }
            };
          }
        }, ThemeManagerSection);
      });
    }

    return {
      inject: ['slots', 'theme'],
      apply: apply,
    };
  }
});
