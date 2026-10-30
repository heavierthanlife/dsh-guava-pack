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
        attachments: '同时清理无人引用的附件（含 handoff/清单里的引用）',
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
        skippedLocked: '⚠️ 有 {count} 个会话正在被写入（写锁被持有），已跳过、未删除 —— 等它们写完再试',
        removeFailed: '⚠️ 有 {count} 个会话没能删掉（其余已处理）—— 详见 CLI 输出',
        errConfirmRequired: '确认已失效（令牌过期或页面未刷新）：请刷新页面后重新点「执行」并确认。',
        errPlanChanged: '计划已变化（会话集合／模式／附件开关与确认时不同）：请重新确认。',
        staleTitle: '花名册残留 {count} 条',
        staleHint: '记录已删除，但 workspace.json 里还留着 id —— 所以侧栏照旧显示、点不进去。停服后跑这三条即可清掉：',
        copyCmds: '复制命令',
        copied: '已复制',
        deletedMarker: '记录已删除（仅剩花名册条目）',
        trashTitle: '回滚区',
        trashSummary: '{count} 个回滚点 · {size}',
        trashPolicyLine: '{days} / {size} / 最多 {n} 个',
        trashUnlimited: '不限',
        trashInvalid: '忽略 {count} 个非回滚点条目（清单/未知目录，永不清理）',
        trashEvict: '将清理 {count} 个 · {size}',
        trashNone: '没有需要清理的回滚点',
        trashGc: '清理过期回滚点（{count} 个 / {size}）',
        trashGcAll: '清空全部回滚点',
        trashGcConfirm: '再点一次确认清空',
        trashGcDone: '回滚区已清理 {count} 个 · 释放 {size}',
        trashGcFailed: '⚠️ {count} 个回滚点删除失败（其余已清理）',
        trashSettings: '保留策略（0 = 不限）',
        trashDays: '保留天数',
        trashMb: '体积上限 (MB)',
        trashEntries: '最多保留 (个)',
        trashSave: '保存策略',
        trashSaved: '策略已保存',
        trashSaveFailed: '策略保存失败：{message}',
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
        skippedLocked: '⚠️ {count} sessions are being written to right now (write lock held) — skipped, not deleted; try again once they finish',
        removeFailed: '⚠️ {count} sessions could not be removed (the rest were handled) — see the CLI output for details',
        errConfirmRequired: 'Confirmation expired (stale token or page not refreshed): refresh the page, then click Run and confirm again.',
        errPlanChanged: 'The plan changed (session set / mode / attachments differ from what you confirmed): please confirm again.',
        staleTitle: '{count} stale roster entries',
        staleHint: 'Records are deleted but their ids remain in workspace.json, so the sidebar still lists them without data. Run these three commands while DSH is stopped:',
        copyCmds: 'Copy commands',
        copied: 'Copied',
        deletedMarker: 'record deleted (roster entry only)',
        trashTitle: 'Rollback trash',
        trashSummary: '{count} rollback points · {size}',
        trashPolicyLine: '{days} / {size} / max {n}',
        trashUnlimited: 'unlimited',
        trashInvalid: 'ignoring {count} non-rollback entries (manifests/unknown dirs are never deleted)',
        trashEvict: 'will delete {count} · {size}',
        trashNone: 'nothing to clean up',
        trashGc: 'Clean expired ({count} / {size})',
        trashGcAll: 'Delete all rollback points',
        trashGcConfirm: 'Click again to confirm',
        trashGcDone: 'trash cleaned: {count} removed · {size} freed',
        trashGcFailed: '⚠️ {count} rollback points failed to delete (the rest were cleaned)',
        trashSettings: 'Retention (0 = unlimited)',
        trashDays: 'keep days',
        trashMb: 'size cap (MB)',
        trashEntries: 'max entries',
        trashSave: 'Save policy',
        trashSaved: 'policy saved',
        trashSaveFailed: 'failed to save policy: {message}',
      },
    };

    const CSS = `
.spurge_wrap{display:flex;flex-direction:column;width:100%;min-width:0}
.spurge_row{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 10px;
  border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left}
.spurge_row:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}
.spurge_row[data-open="true"]{color:var(--dsw-alias-label-primary)}
@media (max-width:520px){
  /* 手机触控：32px 行高太小，抬到 40 并加内边距 */
  .spurge_row{min-height:40px;padding:8px 10px}
}
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
.spurge_trash{display:flex;flex-direction:column;gap:4px;padding:6px 8px;
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1)}
.spurge_trashset{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end}
.spurge_field{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-tertiary);
  font-size:11px;line-height:15px}
.spurge_field input{width:76px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.spurge_trashset button{padding:3px 8px;border:0;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;cursor:pointer}
.spurge_trashset button:disabled{opacity:.5;cursor:default}
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
      if (result?.ok !== true) {
        const failure = new Error(result?.error?.message ?? `HTTP ${response.status}`);
        // 带上错误码：面板才能把已知失败翻成当前语言（英文界面下不至于冒出中文）。
        failure.code = result?.error?.code ?? '';
        throw failure;
      }
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
        // 走便宜的 `stale` 通道：这里只要"花名册记着、磁盘上没有"的 id。
        // 以前它调完整 `plan`，于是**每次页面加载**都要解压归档会话日志
        // （本机实测 208ms，而那份 4.5MB 日志解压 99ms + 解析 109ms），
        // 结果却只用到 missing 一个字段 —— 那才是真正每次都发生的阻塞。
        const value = await call('stale', {});
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
      const [confirmToken, setConfirmToken] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const stale = useStale();

      // ── 回滚区（.purge-trash）状态 ──────────────────────────────────
      const [trash, setTrash] = React.useState(null);          // 计划里带的回滚区摘要
      const [trashPolicy, setTrashPolicyState] = React.useState(null);
      const [trashInputs, setTrashInputs] = React.useState({ days: '', mb: '', entries: '' });
      const [trashBusy, setTrashBusy] = React.useState(false);
      const [trashError, setTrashError] = React.useState(null);
      const [trashDone, setTrashDone] = React.useState(null);
      const [trashSaved, setTrashSaved] = React.useState(null);
      const [trashConfirmAll, setTrashConfirmAll] = React.useState(false);
      // 用户改过输入后，刷新计划不要再覆盖他的草稿。
      const trashDirtyRef = React.useRef(false);
      const trashConfirmTimer = React.useRef(undefined);

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
          setTrash(value?.trash ?? null);
          const policy = value?.trashPolicy ?? value?.trash?.policy ?? null;
          if (policy !== null && policy !== undefined) {
            setTrashPolicyState(policy);
            if (!trashDirtyRef.current) {
              setTrashInputs({
                days: String(policy.maxAgeDays ?? 0),
                mb: String(Math.round((policy.maxBytes ?? 0) / (1024 ** 2))),
                entries: String(policy.maxEntries ?? 0),
              });
            }
          }
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

      /**
       * 执行按钮：第一次点只做「取确认令牌 + 变成确认态」，第二次才真发 execute。
       *
       * 令牌绑的是「当前这批会话 + 当前模式 + 当前附件开关」，所以模式或附件开关
       * 一变就要重新取 —— 否则 host 会因为指纹不符而拒绝（这是有意的：
       * 不能让"用户看过 trash 计划"变成"实际执行 hard 删除"）。
       */
      const execute = async () => {
        if (!confirming) {
          setBusy(true);
          setError(null);
          try {
            const fresh = await call('plan', { attachments, mode });
            setConfirmToken(typeof fresh?.confirmToken === 'string' ? fresh.confirmToken : '');
            setConfirming(true);
          } catch (e) {
            setError(String(e?.message ?? e));
          } finally {
            setBusy(false);
          }
          return;
        }
        setBusy(true);
        setError(null);
        setDone(null);
        try {
          const value = await call('execute', { mode, attachments, confirmToken });
          setDone(value);
          setConfirming(false);
          setConfirmToken('');
          setPlan(null);
          void refreshStale();
          // 会话清理可能顺带清了旧回滚点：面板上的回滚区摘要要跟着刷新。
          try {
            const info = await call('trash', {});
            setTrash(info);
            if (info?.policy) setTrashPolicyState(info.policy);
          } catch {
            /* 回滚区摘要刷新失败不影响主力流程 */
          }
        } catch (e) {
          // 已知失败翻成当前语言；其余照原样显示。
          const code = e?.code ?? '';
          const known =
            code === 'session-purge/confirm-required'
              ? 'errConfirmRequired'
              : code === 'session-purge/plan-changed'
                ? 'errPlanChanged'
                : null;
          setError(known === null ? String(e?.message ?? e) : tr(known));
          // 令牌是一次性的：无论失败原因，都要回到未确认态重新取。
          setConfirming(false);
          setConfirmToken('');
        } finally {
          setBusy(false);
        }
      };

      /**
       * 清理回滚区：先取新的确认令牌，再执行。
       *
       * 为什么两步：GC 会真删磁盘目录，令牌绑定"当前这批回滚点 + 策略 + all"，
       * 和会话清理同一套一次性、5 分钟有效、绑指纹的闸门。
       */
      const gcTrash = async (all) => {
        setTrashBusy(true);
        setTrashError(null);
        setTrashDone(null);
        try {
          const info = await call('trash', {});
          const token = all === true ? info?.confirmAllToken : info?.confirmToken;
          const value = await call('gcTrash', { all: all === true, confirmToken: token });
          setTrashDone(value);
          setTrashConfirmAll(false);
          if (trashConfirmTimer.current !== undefined) clearTimeout(trashConfirmTimer.current);
          // 清完刷新计划（回滚区摘要要跟着变）。
          const fresh = await call('plan', { attachments });
          setPlan(fresh);
          setTrash(fresh?.trash ?? null);
          if (fresh?.trashPolicy) setTrashPolicyState(fresh.trashPolicy);
        } catch (e) {
          setTrashError(String(e?.message ?? e));
          setTrashConfirmAll(false);
        } finally {
          setTrashBusy(false);
        }
      };

      /** 保存保留策略（落盘 + host 立刻生效）。 */
      const saveTrashPolicy = async () => {
        setTrashBusy(true);
        setTrashError(null);
        setTrashSaved(null);
        try {
          const value = await call('setSettings', {
            trash: {
              maxAgeDays: Number(trashInputs.days) || 0,
              maxBytes: (Number(trashInputs.mb) || 0) * 1024 ** 2,
              maxEntries: Number(trashInputs.entries) || 0,
            },
          });
          if (value?.saved !== true) throw new Error(String(value?.saveError ?? 'save failed'));
          trashDirtyRef.current = false;
          setTrashPolicyState(value.trash ?? null);
          setTrashSaved(value.trash ?? null);
          const fresh = await call('plan', { attachments });
          setPlan(fresh);
          setTrash(fresh?.trash ?? null);
        } catch (e) {
          setTrashError(String(e?.message ?? e));
        } finally {
          setTrashBusy(false);
        }
      };

      // 模式 / 附件开关一变，之前那份确认就作废了（令牌指纹会不符）。
      const changeMode = (next) => {
        setMode(next);
        setConfirming(false);
        setConfirmToken('');
      };
      const changeAttachments = (next) => {
        setAttachments(next);
        setConfirming(false);
        setConfirmToken('');
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
                      changeAttachments(next);
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
                      { type: 'button', 'data-on': mode === 'trash' ? 'true' : 'false', onClick: () => changeMode('trash') },
                      tr('modeTrash'),
                    ),
                    h(
                      'button',
                      { type: 'button', 'data-on': mode === 'hard' ? 'true' : 'false', onClick: () => changeMode('hard') },
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

            // 因写锁被跳过的会话：这是**保护**（它们还在原地），必须让用户看见，
            // 否则用户会以为"清干净了"。
            done !== null && Array.isArray(done.skippedLocked) && done.skippedLocked.length > 0
              ? h(
                  'div',
                  { key: 'sl', className: 'spurge_err' },
                  tr('skippedLocked', { count: done.skippedLocked.length }),
                )
              : null,

            // 单个会话没删掉（不影响其它会话），同样必须让用户看见。
            done !== null && Array.isArray(done.removeFailures) && done.removeFailures.length > 0
              ? h(
                  'div',
                  { key: 'rf', className: 'spurge_err' },
                  tr('removeFailed', { count: done.removeFailures.length }),
                )
              : null,

            error !== null ? h('div', { key: 'err', className: 'spurge_err' }, tr('failed', { message: error })) : null,

            // ── 回滚区：统计 / 过期清理 / 清空全部 / 保留策略 ──────────────
            h('div', { key: 'trash', className: 'spurge_trash' }, [
              h('div', { key: 'title', className: 'spurge_sum' }, tr('trashTitle')),
              trash === null
                ? h('div', { key: 'loading', className: 'spurge_hint' }, tr('loading'))
                : h('div', { key: 'sum', className: 'spurge_hint' }, tr('trashSummary', { count: trash.count, size: human(trash.bytes) })),
              trash !== null && trashPolicy !== null
                ? h('div', { key: 'policy', className: 'spurge_hint', title: tr('trashPolicyLine', {
                    days: trashPolicy.maxAgeDays === 0 ? tr('trashUnlimited') : `${trashPolicy.maxAgeDays}`,
                    size: trashPolicy.maxBytes === 0 ? tr('trashUnlimited') : human(trashPolicy.maxBytes),
                    n: trashPolicy.maxEntries === 0 ? tr('trashUnlimited') : `${trashPolicy.maxEntries}`,
                  }) }, tr('trashPolicyLine', {
                    days: trashPolicy.maxAgeDays === 0 ? tr('trashUnlimited') : `${trashPolicy.maxAgeDays} 天`,
                    size: trashPolicy.maxBytes === 0 ? tr('trashUnlimited') : human(trashPolicy.maxBytes),
                    n: trashPolicy.maxEntries === 0 ? tr('trashUnlimited') : `${trashPolicy.maxEntries}`,
                  }))
                : null,
              trash !== null && trash.invalid.length > 0
                ? h('div', { key: 'invalid', className: 'spurge_hint' }, tr('trashInvalid', { count: trash.invalid.length }))
                : null,
              trash !== null && trash.evicted.length > 0
                ? h(
                    'div',
                    { key: 'evicted', className: 'spurge_list' },
                    trash.evicted.map((entry) =>
                      h('div', { key: entry.name, className: 'spurge_item' }, [
                        h('b', { key: 'n', title: entry.name }, entry.name),
                        h('span', { key: 'b' }, human(entry.bytes)),
                        h('span', { key: 'a' }, `${entry.ageDays}d · ${(entry.reasons ?? []).join(',')}`),
                      ]),
                    ),
                  )
                : trash !== null
                  ? h('div', { key: 'nothing', className: 'spurge_hint' }, tr('trashNone'))
                  : null,
              h('div', { key: 'acts', className: 'spurge_actions' }, [
                h(
                  'button',
                  {
                    key: 'gc',
                    type: 'button',
                    disabled: trashBusy || !(trash?.evictCount > 0),
                    onClick: () => {
                      void gcTrash(false);
                    },
                  },
                  trashBusy
                    ? tr('running')
                    : tr('trashGc', { count: trash?.evictCount ?? 0, size: human(trash?.evictBytes ?? 0) }),
                ),
                trash !== null && trash.count > 0
                  ? h(
                      'button',
                      {
                        key: 'all',
                        type: 'button',
                        disabled: trashBusy,
                        'data-primary': trashConfirmAll ? 'true' : 'false',
                        onClick: () => {
                          if (!trashConfirmAll) {
                            setTrashConfirmAll(true);
                            if (trashConfirmTimer.current !== undefined) clearTimeout(trashConfirmTimer.current);
                            trashConfirmTimer.current = setTimeout(() => setTrashConfirmAll(false), 4000);
                            return;
                          }
                          void gcTrash(true);
                        },
                      },
                      trashConfirmAll ? tr('trashGcConfirm') : tr('trashGcAll'),
                    )
                  : null,
              ]),
              h('div', { key: 'settings', className: 'spurge_trashset' }, [
                h('div', { key: 'label', className: 'spurge_hint' }, tr('trashSettings')),
                h(
                  'label',
                  { key: 'days', className: 'spurge_field' },
                  tr('trashDays'),
                  h('input', {
                    type: 'number',
                    min: 0,
                    max: 365,
                    value: trashInputs.days,
                    onChange: (event) => {
                      trashDirtyRef.current = true;
                      setTrashInputs((value) => ({ ...value, days: event.target.value }));
                    },
                  }),
                ),
                h(
                  'label',
                  { key: 'mb', className: 'spurge_field' },
                  tr('trashMb'),
                  h('input', {
                    type: 'number',
                    min: 0,
                    max: 102400,
                    step: 256,
                    value: trashInputs.mb,
                    onChange: (event) => {
                      trashDirtyRef.current = true;
                      setTrashInputs((value) => ({ ...value, mb: event.target.value }));
                    },
                  }),
                ),
                h(
                  'label',
                  { key: 'entries', className: 'spurge_field' },
                  tr('trashEntries'),
                  h('input', {
                    type: 'number',
                    min: 0,
                    max: 100,
                    value: trashInputs.entries,
                    onChange: (event) => {
                      trashDirtyRef.current = true;
                      setTrashInputs((value) => ({ ...value, entries: event.target.value }));
                    },
                  }),
                ),
                h(
                  'button',
                  { key: 'save', type: 'button', disabled: trashBusy, onClick: () => { void saveTrashPolicy(); } },
                  tr('trashSave'),
                ),
              ]),
              trashSaved !== null ? h('div', { key: 'saved', className: 'spurge_ok' }, tr('trashSaved')) : null,
              trashDone !== null
                ? h(
                    'div',
                    { key: 'done', className: 'spurge_ok' },
                    tr('trashGcDone', {
                      count: trashDone.removed?.length ?? 0,
                      size: trashDone.freedHuman ?? human(trashDone.freedBytes ?? 0),
                    }),
                  )
                : null,
              trashDone !== null && (trashDone.failures?.length ?? 0) > 0
                ? h('div', { key: 'failed', className: 'spurge_err' }, tr('trashGcFailed', { count: trashDone.failures.length }))
                : null,
              trashError !== null ? h('div', { key: 'error', className: 'spurge_err' }, tr('failed', { message: trashError })) : null,
            ]),

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
