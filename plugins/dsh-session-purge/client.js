/**
 * dsh-session-purge — client 半边。
 *
 * 挂在 `sidebar.footer.action`（**渲染在 `sidebar.settings` 之上那一行**，
 * 见 dsh-client-ui-sidebar 的 footArea：footerActions 在前、settingsArea 在后）。
 * 点开是内联面板：读计划 → 选模式 → 执行。
 *
 * 真正的删除在 host 侧（`POST /session-purge/execute`），客户端不碰文件系统。
 * 花名册（workspace.json）**不在这里清**：运行时会被内存态覆盖，停服后用 CLI 收尾。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-purge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'session-purge';
    const ROUTE = '/session-purge';

    const DICT = {
      zh: {
        title: '清理归档会话',
        loading: '读取计划…',
        empty: '没有可清理的归档会话',
        summary: '{count} 个会话 · 可回收 {size}',
        files: '{count} 个产出文件',
        attachments: '同时清理无人引用的附件',
        attachmentsHint: '（跨会话去重，只删别的会话不再引用的）',
        mode: '删除方式',
        modeTrash: '移到回滚区',
        modeHard: '直接删除',
        hardWarn: '不可回滚',
        execute: '执行',
        confirm: '确认执行',
        cancel: '取消',
        running: '执行中…',
        done: '完成：{count} 个会话 → {where}',
        doneHard: '完成：{count} 个会话已删除',
        rosterNote: '花名册残留需停服后用 CLI --roster-only 清理（只改 workspace.json，不删会话）',
        refresh: '刷新',
        failed: '失败：{message}',
        manifestFailed: '⚠️ 有 {count} 个会话的产出清单没写出来 —— 会话本身已按上面的模式处理，但清单缺失',
        staleTitle: '花名册残留 {count} 条',
        staleHint: '记录已删除，但 workspace.json 里还留着 id —— 所以侧栏照旧显示、点不进去。停服后跑这三条即可清掉：',
        copyCmds: '复制命令',
        copied: '已复制',
        deletedMarker: '记录已删除（仅剩花名册条目）',
      },
      en: {
        title: 'Purge archived sessions',
        loading: 'loading plan…',
        empty: 'no archived session to purge',
        summary: '{count} sessions · {size} reclaimable',
        files: '{count} output files',
        attachments: 'also purge unreferenced attachments',
        attachmentsHint: '(deduped across sessions; only unreferenced ones)',
        mode: 'Mode',
        modeTrash: 'move to trash',
        modeHard: 'delete',
        hardWarn: 'irreversible',
        execute: 'Run',
        confirm: 'Confirm',
        cancel: 'Cancel',
        running: 'running…',
        done: 'Done: {count} sessions → {where}',
        doneHard: 'Done: {count} sessions deleted',
        rosterNote: 'stale roster ids need the CLI --roster-only while DSH is stopped (touches workspace.json only)',
        refresh: 'Refresh',
        failed: 'failed: {message}',
        manifestFailed: '⚠️ {count} sessions had no output manifest written — the sessions themselves were handled, but the manifest is missing',
        staleTitle: '{count} stale roster entries',
        staleHint: 'Records are deleted but their ids remain in workspace.json, so the sidebar still lists them without data. Run these three commands while DSH is stopped:',
        copyCmds: 'Copy commands',
        copied: 'Copied',
        deletedMarker: 'record deleted (roster entry only)',
      },
    };

    const CSS = `
.spurge_wrap{display:flex;flex-direction:column;width:100%;min-width:0}
.spurge_row{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 10px;
  border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left}
.spurge_row:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}
.spurge_row[data-open="true"]{color:var(--dsw-alias-label-primary)}
.spurge_icon{width:16px;height:16px;flex:none;display:block}
.spurge_label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spurge_chevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.spurge_panel{margin:2px 0 6px;padding:8px 10px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:6px}
.spurge_sum{color:var(--dsw-alias-label-primary);font-weight:500}
.spurge_list{max-height:132px;overflow:auto;display:flex;flex-direction:column;gap:2px}
.spurge_item{display:flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums}
.spurge_item b{color:var(--dsw-alias-label-secondary);font-weight:400;flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spurge_seg{display:flex;gap:4px}
.spurge_seg button{flex:1;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer}
.spurge_seg button[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);
  color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.spurge_chk{display:flex;align-items:center;gap:6px;cursor:pointer}
.spurge_hint{color:var(--dsw-alias-label-tertiary);opacity:.85}
.spurge_actions{display:flex;gap:6px;align-items:center}
.spurge_actions button{padding:4px 10px;border:0;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;cursor:pointer}
.spurge_actions button[data-primary="true"]{background:var(--dsw-alias-state-error-secondary)}
.spurge_actions button:disabled{opacity:.5;cursor:default}
.spurge_link{border:0;background:0 0;color:var(--dsw-alias-label-tertiary);
  font:inherit;font-size:12px;cursor:pointer;padding:0}
.spurge_err{color:var(--dsw-alias-state-error-primary)}
.spurge_ok{color:var(--dsw-alias-state-success-primary)}
.spurge_stale{display:flex;flex-direction:column;gap:4px;padding:6px 8px;
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1)}
.spurge_warn{color:var(--dsw-alias-label-primary);font-weight:500}
.spurge_cmds{margin:0;padding:6px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);
  font-size:11px;line-height:16px;white-space:pre;overflow-x:auto}
.spurge_mark{color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px}
`;

    /** 人类可读体积。 */
    function human(bytes) {
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}K`;
      if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
      return `${(bytes / 1024 ** 3).toFixed(2)}G`;
    }

    /** 调 host 的面板路由。 */
    async function call(method, payload) {
      const response = await fetch(`${ROUTE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}`, method, payload }),
      });
      const json = await response.json();
      const result = json?.result;
      if (result?.ok !== true) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      return result.value;
    }

    /** 花名册残留 id（记录已删、id 还在 workspace.json）—— 面板与悬浮卡片共用。 */
    const staleIds = new Set();
    const staleSubs = new Set();

    /** 更新残留集合并通知订阅者。 */
    function setStale(ids) {
      staleIds.clear();
      for (const id of ids ?? []) staleIds.add(id);
      for (const notify of staleSubs) notify();
    }

    /** 订阅残留集合。 */
    function useStale() {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        staleSubs.add(force);
        return () => {
          staleSubs.delete(force);
        };
      }, []);
      return staleIds;
    }

    /** 刷新残留集合（只读，不删任何东西）。 */
    /** host 回传的 CLI 真实路径 —— 装成 pack 之后，playground 那个路径并不存在。 */
    let hostCliPath = '';

    async function refreshStale() {
      try {
        const value = await call('plan', { attachments: false });
        if (typeof value?.cli === 'string' && value.cli) hostCliPath = value.cli;
        setStale(value?.missing ?? []);
      } catch {
        /* 静默：面板打开时会再报错 */
      }
    }

    /**
     * 清残留的三条命令（必须停服：运行时改 workspace.json 会被内存态覆盖）。
     *
     * `--roster-only` **不能省**：不带 `--id` 时 `--clean-roster` 等于"清理全部归档会话"，
     * 会把这些命令本想保留的会话一起移走。这三条命令的定位只是摘掉花名册里的残留 id。
     */
    function cleanCmds() {
      const cli = hostCliPath || '<dsh-session-purge 插件目录>/lib/core.mjs';
      return [
        'systemctl --user stop dsh.service',
        `node ${cli} --confirm --roster-only`,
        'systemctl --user start dsh.service',
      ].join('\n');
    }

    /** 归档盒图标。 */
    function Icon(props) {
      return h(
        'svg',
        // 显式宽高兜底：HMR 重载组件时内联 <style> 会短暂消失，
        // 失去 CSS 约束的 SVG 会按默认尺寸（约 300×150）撑开，看着"膨胀到和对话框一样高"。
        Object.assign({ className: 'spurge_icon', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true }, props),
        h('rect', { x: 2, y: 3.2, width: 12, height: 2.6, rx: 0.7, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M3.1 5.8h9.8v7.2a0.9 0.9 0 0 1-0.9 0.9H4a0.9 0.9 0 0 1-0.9-0.9z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M6.6 8.6h2.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      );
    }

    function PurgeRow({ t }) {
      const [open, setOpen] = React.useState(false);
      const [plan, setPlan] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [done, setDone] = React.useState(null);
      const [mode, setMode] = React.useState('trash');
      const [attachments, setAttachments] = React.useState(false);
      const [confirming, setConfirming] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      const stale = useStale();

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
        return text.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
      };

      const load = React.useCallback(async (withAttachments) => {
        setBusy(true);
        setError(null);
        try {
          const value = await call('plan', { attachments: withAttachments === true });
          if (typeof value?.cli === 'string' && value.cli) hostCliPath = value.cli;
          setPlan(value);
          setStale(value?.missing ?? []);
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        if (open) void load(attachments);
      }, [open, load]); // 打开时读一次

      const execute = async () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setBusy(true);
        setError(null);
        setDone(null);
        try {
          const value = await call('execute', { mode, attachments });
          setDone(value);
          setConfirming(false);
          setPlan(null);
          void refreshStale();
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      const entries = plan?.entries ?? [];
      const totals = plan?.totals;
      const cleanCommands = cleanCmds();

      return h(
        'div',
        { className: 'spurge_wrap' },
        h('style', { key: 'css' }, CSS),
        h(
          'button',
          {
            key: 'row',
            type: 'button',
            className: 'spurge_row',
            'data-open': open ? 'true' : 'false',
            'aria-expanded': open,
            title: tr('title'),
            onClick: () => {
              setOpen((v) => !v);
              setConfirming(false);
            },
          },
          [h(Icon, { key: 'i' }), h('span', { key: 'l', className: 'spurge_label' }, tr('title')), h('span', { key: 'c', className: 'spurge_chevron' }, open ? '▾' : '▸')],
        ),
        open &&
          h('div', { key: 'panel', className: 'spurge_panel' }, [
            busy && plan === null ? h('div', { key: 'loading' }, tr('loading')) : null,

            plan !== null && entries.length === 0
              ? h('div', { key: 'empty', className: 'spurge_hint' }, tr('empty'))
              : null,

            // 花名册残留：记录已删、id 还在 —— 常驻显示（与有无可清理会话无关）。
            stale.size > 0
              ? h('div', { key: 'stale', className: 'spurge_stale' }, [
                  h('div', { key: 't', className: 'spurge_warn' }, tr('staleTitle', { count: stale.size })),
                  h('div', { key: 'h', className: 'spurge_hint' }, tr('staleHint')),
                  h('pre', { key: 'c', className: 'spurge_cmds' }, cleanCommands),
                  h(
                    'div',
                    { key: 'a', className: 'spurge_actions' },
                    h(
                      'button',
                      {
                        key: 'copy',
                        type: 'button',
                        className: 'spurge_link',
                        onClick: () => {
                          const done = () => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1600);
                          };
                          const clip = navigator.clipboard;
                          if (clip?.writeText) void clip.writeText(cleanCommands).then(done, () => {});
                        },
                      },
                      copied ? tr('copied') : tr('copyCmds'),
                    ),
                  ),
                ])
              : null,

            plan !== null && entries.length > 0
              ? h('div', { key: 'sum', className: 'spurge_sum' }, tr('summary', { count: entries.length, size: human(totals.bytes) }))
              : null,

            entries.length > 0
              ? h(
                  'div',
                  { key: 'list', className: 'spurge_list' },
                  entries.map((e) =>
                    h('div', { key: e.id, className: 'spurge_item' }, [
                      h('b', { key: 'id', title: e.id }, e.id.replace(/^session-/, '').slice(0, 12)),
                      h('span', { key: 'size' }, human(e.bytes)),
                      h('span', { key: 'files', title: tr('files', { count: e.files }) }, `${e.files}f`),
                    ]),
                  ),
                )
              : null,

            entries.length > 0
              ? h(
                  'label',
                  { key: 'att', className: 'spurge_chk' },
                  h('input', {
                    type: 'checkbox',
                    checked: attachments,
                    onChange: (event) => {
                      const next = event.target.checked;
                      setAttachments(next);
                      void load(next);
                    },
                  }),
                  h('span', null, tr('attachments')),
                )
              : null,

            entries.length > 0 ? h('div', { key: 'atthint', className: 'spurge_hint' }, tr('attachmentsHint')) : null,

            entries.length > 0
              ? h('div', { key: 'mode' }, [
                  h('div', { key: 'label', className: 'spurge_hint' }, tr('mode')),
                  h(
                    'div',
                    { key: 'seg', className: 'spurge_seg' },
                    h(
                      'button',
                      { type: 'button', 'data-on': mode === 'trash' ? 'true' : 'false', onClick: () => setMode('trash') },
                      tr('modeTrash'),
                    ),
                    h(
                      'button',
                      { type: 'button', 'data-on': mode === 'hard' ? 'true' : 'false', onClick: () => setMode('hard') },
                      tr('modeHard'),
                    ),
                  ),
                  mode === 'hard' ? h('div', { key: 'warn', className: 'spurge_err' }, tr('hardWarn')) : null,
                ])
              : null,

            entries.length > 0
              ? h('div', { key: 'actions', className: 'spurge_actions' }, [
                  h(
                    'button',
                    { key: 'go', type: 'button', 'data-primary': 'true', disabled: busy, onClick: execute },
                    busy ? tr('running') : confirming ? tr('confirm') : tr('execute'),
                  ),
                  confirming
                    ? h('button', { key: 'cancel', type: 'button', onClick: () => setConfirming(false) }, tr('cancel'))
                    : null,
                  h('button', { key: 'refresh', type: 'button', className: 'spurge_link', onClick: () => void load(attachments) }, tr('refresh')),
                ])
              : null,

            done !== null
              ? h(
                  'div',
                  { key: 'done', className: 'spurge_ok' },
                  done.mode === 'hard'
                    ? tr('doneHard', { count: done.count })
                    : tr('done', { count: done.count, where: done.trashRoot ?? '—' }),
                )
              : null,

            // 产出清单写失败以前被静默吞掉（host 不回传），面板必须看得见 ——
            // README 把"删前写一份清单"当安全承诺，无声落空比报错更糟。
            done !== null && Array.isArray(done.manifestFailures) && done.manifestFailures.length > 0
              ? h(
                  'div',
                  { key: 'mf', className: 'spurge_err' },
                  tr('manifestFailed', { count: done.manifestFailures.length }),
                )
              : null,

            error !== null ? h('div', { key: 'err', className: 'spurge_err' }, tr('failed', { message: error })) : null,

            h('div', { key: 'roster', className: 'spurge_hint' }, tr('rosterNote')),
          ]),
      );
    }

    /**
     * 悬浮卡片里的"记录已删除"标记。
     *
     * 为什么不做"标题划掉"：唯一的行内装饰槽 `sidebar.session.row.leading` 在宿主里的
     * 渲染条件是 `!row.archived && !row.blank` —— 归档行被显式跳过，而残留条目全是归档行；
     * 标题本身是私有 CSS-module 类，去改它属于被禁止的 DOM/样式表 hack。这是合规等价物。
     */
    function StaleNote({ sessionId, t }) {
      const stale = useStale();
      if (!sessionId || !stale.has(sessionId)) return null;
      let text = DICT.zh.deletedMarker;
      if (typeof t === 'function') {
        try {
          text = t('deletedMarker') || text;
        } catch {
          /* 用兜底文案 */
        }
      }
      return h('div', { className: 'spurge_mark' }, [h('style', { key: 'css' }, CSS), text]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'session-purge: dictionaries');
        // 样式表挂在插件生命周期上，而不是只放在组件里：HMR 重载组件时内联 <style>
        // 会短暂消失，图标就失去尺寸约束而膨胀（刷新才恢复）。组件内那份保留作兜底。
        ctx.effect(() => {
          const el = document.createElement('style');
          el.textContent = CSS;
          document.head.appendChild(el);
          return () => el.remove();
        }, 'session-purge: styles');
        // sidebar.footer.action 渲染在 sidebar.settings 之上那一行。
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'session-purge', order: 0, locale: NS }, PurgeRow),
        );
        // 归档行的悬浮卡片标记（行内装饰槽被宿主对归档行跳过）。
        ctx.slots.inject('sidebar.session.row.hover', () =>
          ctx.slots.register(
            { name: 'sidebar.session.row.hover', id: 'session-purge-stale', order: 0, locale: NS },
            StaleNote,
          ),
        );
        // 首屏就取一次残留集合，不必打开面板。
        void refreshStale();
      },
    };
  },
});
