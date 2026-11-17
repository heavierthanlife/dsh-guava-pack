/* DSH Arcade 共用运行时
 *
 * 为什么要有这个文件（2026-11-17 修订契约）：
 *   主题切换、分数管理、存档槽、二次确认这四件事原本要复制到 8 个页面里。
 *   抄 8 份的后果不是"多写点代码"，而是**行为漂移** —— 改一处忘了另一处，
 *   于是 2048 能删分数、扫雷不能，用户会觉得"时好时坏"。
 *   所以抽成一份，页面只引用它。
 *
 * 约定：
 *   · 只用 ES5 语法（var/function），不 import/export —— 与既有页面的内联脚本同代。
 *   · 全部 localStorage 读写都在 try 里：Safari 隐私模式会抛 SecurityError。
 *   · 在 <head> 里同步加载：主题必须在首帧前落到 <html> 上，否则会闪一下。
 *   · 任何 API 在存储不可用时都退化为"内存态"，页面继续能用，不白屏。
 *
 * 用法（每个子页面）：
 *   <script src="arcade.js"></script>
 *   Arcade.initTheme({ page: 'g2048' });     // 页面自己的明暗
 *   Arcade.initTheme({ themes: true });      // 首页：5 套主题
 */
(function () {
  'use strict';

  /* ── 存储 ──────────────────────────────────────────────────────────
   * 所有键都以 arcade. 开头。读失败一律回落到调用方给的默认值；
   * 写失败静默（功能降级为"本次有效、刷新即丢"），绝不抛到页面。
   */
  var PREFIX = 'arcade.';

  function readRaw(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch (err) {
      return null;
    }
  }

  function writeRaw(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
      return true;
    } catch (err) {
      /* 隐私模式 / 配额满：静默降级，调用方不需要知道细节 */
      return false;
    }
  }

  function removeRaw(key) {
    try {
      localStorage.removeItem(PREFIX + key);
      return true;
    } catch (err) {
      return false;
    }
  }

  function readJSON(key, fallback) {
    var raw = readRaw(key);
    if (raw === null || raw === '') return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      return writeRaw(key, JSON.stringify(value));
    } catch (err) {
      return false;
    }
  }

  /* ── 主题与明暗 ────────────────────────────────────────────────────
   * 三层：
   *   1. 首页用 5 套主题（与 dsh-console 同名同色，风格统一）；
   *   2. 每个子页面有自己的强调色（"更彩色"），靠 data-accent 选；
   *   3. 每个子页面独立切换明暗（data-mode），互不影响。
   * 主题名/明暗值都落到 <html> 上，CSS 用属性选择器接管。
   */
  var THEMES = ['graphite', 'cyber', 'navy', 'ember', 'ice'];
  var MODES = ['dark', 'light'];

  function root() {
    return document.documentElement;
  }

  function getTheme() {
    var value = readRaw('theme');
    return THEMES.indexOf(value) === -1 ? THEMES[0] : value;
  }

  function setTheme(name) {
    if (THEMES.indexOf(name) === -1) return getTheme();
    root().setAttribute('data-theme', name);
    writeRaw('theme', name);
    return name;
  }

  /** 某个页面自己的明暗（键按页面分开，所以各页互不干扰）。 */
  function getMode(page) {
    var value = readRaw((page || 'default') + '.mode');
    return MODES.indexOf(value) === -1 ? 'dark' : value;
  }

  function setMode(page, mode) {
    var next = MODES.indexOf(mode) === -1 ? 'dark' : mode;
    root().setAttribute('data-mode', next);
    writeRaw((page || 'default') + '.mode', next);
    return next;
  }

  /**
   * 首帧前应用主题。在 <head> 里同步调用。
   *
   * @param {{page?: string, themes?: boolean, accent?: string}} options
   *   page   子页面标识（决定明暗存哪个键）
   *   themes true = 首页，用 5 套主题
   *   accent 该页的强调色名（对应 CSS 的 data-accent）
   */
  function initTheme(options) {
    var opts = options || {};
    if (opts.accent) root().setAttribute('data-accent', opts.accent);
    if (opts.themes === true) {
      root().setAttribute('data-theme', getTheme());
      // 首页也跟随全局明暗（它没有自己的 page 概念）
      root().setAttribute('data-mode', getMode('index'));
    } else {
      if (opts.page) root().setAttribute('data-page', opts.page);
      root().setAttribute('data-mode', getMode(opts.page));
    }
  }

  /** 明暗切换按钮：返回新值。 */
  function toggleMode(page) {
    var next = getMode(page) === 'dark' ? 'light' : 'dark';
    return setMode(page, next);
  }

  /* ── 分数记录 ──────────────────────────────────────────────────────
   * 键沿用既有 arcade.<game>.best（不能改：改了等于把用户既有记录扔掉）。
   * "删一条"就是 removeItem；"清空"只清分数，不碰存档槽/画板/设置。
   */
  var GAMES = [
    { id: 'g2048', name: '2048', bestKey: 'g2048.best' },
    { id: 'snake', name: '贪吃蛇', bestKey: 'snake.best' },
    { id: 'mines', name: '扫雷', bestKey: 'mines.best', perLevel: true },
    { id: 'tetris', name: '俄罗斯方块', bestKey: 'tetris.best' }
  ];

  /** 读一条分数记录；不存在返回 null（面板据此显示"暂无记录"）。 */
  function getScore(gameId) {
    var raw = readRaw(gameId + '.best');
    if (raw === null || raw === '') return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      /* 旧版本可能存过裸数字 */
      var num = Number(raw);
      return isFinite(num) ? num : null;
    }
  }

  function delScore(gameId) {
    return removeRaw(gameId + '.best');
  }

  /** 一键清空：只删 4 个游戏的 best，不碰其他键。 */
  function clearScores() {
    for (var i = 0; i < GAMES.length; i++) removeRaw(GAMES[i].bestKey);
  }

  /** 面板用的快照：每条都带"有没有记录"。 */
  function scoreSnapshot() {
    var out = [];
    for (var i = 0; i < GAMES.length; i++) {
      var value = getScore(GAMES[i].id);
      out.push({
        id: GAMES[i].id,
        name: GAMES[i].name,
        value: value,
        has: value !== null
      });
    }
    return out;
  }

  /* ── 存档槽（每个游戏最多 5 个，超出淘汰分数最低的）──────────────────
   * 为什么淘汰"分数最低"而不是"最旧"：用户要的是"留下还值得继续的局"。
   * 一局刚开始就退出的存档分数最低，正是最该让位的。
   *
   * 槽结构：{ id, at, score, label, state }
   *   id    单调递增的字符串，用来定位
   *   at    存盘时间戳（面板显示"几分钟前"）
   *   score 当时的分数（淘汰依据，扫雷用秒数→负数存储，越小越好）
   *   state 游戏自己的可序列化快照，本模块不解释它
   */
  var MAX_SLOTS = 5;

  function slotsKey(gameId) {
    return gameId + '.slots';
  }

  function listSlots(gameId) {
    var list = readJSON(slotsKey(gameId), []);
    if (!Array.isArray(list)) return [];
    /* 防御：手改坏的槽（缺 state）当不存在 */
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string') continue;
      out.push(entry);
    }
    return out;
  }

  function saveSlots(gameId, list) {
    return writeJSON(slotsKey(gameId), list);
  }

  /**
   * 存一个进度槽。
   *
   * @param {string} gameId
   * @param {{score?: number, label?: string, state: *, id?: string}} entry
   *   给了 id 就**更新**那个槽（退出自动存档重复触发时不会堆垃圾槽）；
   *   没给 id 就新建。
   * @returns {{id: string, list: object[], evicted: object|null, saved: boolean}}
   */
  function saveSlot(gameId, entry) {
    var list = listSlots(gameId);
    var incoming = entry || {};
    var score = typeof incoming.score === 'number' && isFinite(incoming.score) ? incoming.score : 0;
    var id = typeof incoming.id === 'string' && incoming.id !== '' ? incoming.id : 'slot-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    var record = {
      id: id,
      at: Date.now(),
      score: score,
      label: typeof incoming.label === 'string' ? incoming.label : '',
      state: incoming.state === undefined ? null : incoming.state
    };

    var replaced = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        list[i] = record;
        replaced = true;
        break;
      }
    }
    if (!replaced) list.push(record);

    // 超出上限：淘汰分数最低的（同分淘汰更旧的，即数组里靠前的）
    var evicted = null;
    while (list.length > MAX_SLOTS) {
      var worst = 0;
      for (var j = 1; j < list.length; j++) {
        var a = typeof list[j].score === 'number' ? list[j].score : 0;
        var b = typeof list[worst].score === 'number' ? list[worst].score : 0;
        if (a < b) worst = j;
      }
      evicted = list.splice(worst, 1)[0] || null;
    }

    return { id: id, list: list, evicted: evicted, saved: saveSlots(gameId, list) };
  }

  function loadSlot(gameId, id) {
    var list = listSlots(gameId);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function removeSlot(gameId, id) {
    var list = listSlots(gameId);
    var next = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) next.push(list[i]);
    }
    saveSlots(gameId, next);
    return next;
  }

  function clearSlots(gameId) {
    return removeRaw(slotsKey(gameId));
  }

  /* ── 二次确认 ──────────────────────────────────────────────────────
   * 不用 window.confirm：手机上是系统弹窗、样式不可控，而且测试没法自动点。
   * 改成"按钮自身变成确认态"：第一次点进入待确认，第二次点才执行，
   * 5 秒不点自动复原 —— 这就是"二次确认"，且误触不会造成破坏。
   */
  function confirmAction(button, options) {
    var opts = options || {};
    var idleText = opts.text || button.textContent;
    var armedText = opts.confirmText || '确认删除？';
    var timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : 5000;
    var timer = null;

    function disarm() {
      button.textContent = idleText;
      button.classList.remove('armed');
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }

    button.textContent = idleText;
    var handler = function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (!button.classList.contains('armed')) {
        button.classList.add('armed');
        button.textContent = armedText;
        timer = setTimeout(disarm, timeoutMs);
        return;
      }
      disarm();
      if (typeof opts.onConfirm === 'function') opts.onConfirm();
    };
    button.addEventListener('click', handler);
    return { disarm: disarm };
  }

  /* ── 存档槽 UI（4 个游戏共用一份实现）────────────────────────────
   * 为什么放在这里而不是每个游戏各写一套：存档面板的交互（列表、载入、
   * 删除二次确认、满 5 个的提示）与游戏规则无关。抄 4 份的后果是行为漂移，
   * 改一处忘三处。游戏只需要提供两个纯函数：
   *   capture()             → { score, label?, state } | null（null = 现在没得存）
   *   restore(state)        → 把 state 应用回游戏
   *
   * 自动存档策略（用户要求"途中退出默认为暂停，保存进度"）：
   *   · 页面隐藏（切标签页/锁屏）或 pagehide 时，先调 onPause 再存档；
   *   · 自动存档固定用 id 'auto'，所以反复切标签页只会更新同一条，
   *     不会把 5 个槽位瞬间堆满垃圾；
   *   · 手动"保存当前进度"则新建槽位，这样才有意义地占满 5 个。
   */

  function makeSheet(title) {
    var sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.hidden = true;

    var panel = document.createElement('div');
    panel.className = 'sheet-panel';

    var head = document.createElement('div');
    head.className = 'sheet-head';
    var h2 = document.createElement('h2');
    h2.textContent = title;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.textContent = '✕';
    close.setAttribute('aria-label', '关闭');
    head.appendChild(h2);
    head.appendChild(close);

    var body = document.createElement('div');
    panel.appendChild(head);
    panel.appendChild(body);
    sheet.appendChild(panel);
    document.body.appendChild(sheet);

    function hide() { sheet.hidden = true; }
    close.addEventListener('click', hide);
    sheet.addEventListener('click', function (event) {
      if (event.target === sheet) hide();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !sheet.hidden) hide();
    });

    return {
      sheet: sheet,
      body: body,
      show: function () { sheet.hidden = false; },
      hide: hide
    };
  }

  /**
   * 装配存档槽：顶栏按钮 + 底部抽屉面板 + 自动存档。
   *
   * @param {{gameId:string, capture:Function, restore:Function, onPause?:Function, unit?:string}} options
   * @returns {{refresh:Function, autoSave:Function}}
   */
  function mountSlots(options) {
    var opts = options || {};
    var gameId = opts.gameId;
    var unit = typeof opts.unit === 'string' ? opts.unit : '分';
    var sheet = makeSheet('存档进度');
    var autoSaving = false;

    function scoreText(entry) {
      var score = typeof entry.score === 'number' ? entry.score : 0;
      var label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : (score + ' ' + unit);
      return label;
    }

    function render() {
      sheet.body.textContent = '';
      var list = listSlots(gameId);

      if (list.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'small muted';
        empty.style.margin = '0 0 12px';
        empty.textContent = '还没有存档。中途退出会自动存一份（最多 ' + MAX_SLOTS + ' 个）。';
        sheet.body.appendChild(empty);
      }

      for (var i = 0; i < list.length; i++) {
        (function (entry) {
          var row = document.createElement('div');
          row.className = 'slot';

          var main = document.createElement('div');
          main.className = 'slot-main';
          var title = document.createElement('div');
          title.className = 'slot-title';
          title.textContent = scoreText(entry) + (entry.id === 'auto' ? ' · 自动' : '');
          var sub = document.createElement('div');
          sub.className = 'slot-sub';
          sub.textContent = timeAgo(entry.at);
          main.appendChild(title);
          main.appendChild(sub);
          row.appendChild(main);

          var load = document.createElement('button');
          load.type = 'button';
          load.className = 'btn primary';
          load.textContent = '继续';
          load.addEventListener('click', function () {
            var found = loadSlot(gameId, entry.id);
            if (found === null) return;
            if (typeof opts.restore === 'function') opts.restore(found.state);
            sheet.hide();
          });
          row.appendChild(load);

          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'btn danger';
          del.textContent = '删除';
          confirmAction(del, {
            text: '删除',
            confirmText: '确认？',
            onConfirm: function () {
              removeSlot(gameId, entry.id);
              render();
            }
          });
          row.appendChild(del);

          sheet.body.appendChild(row);
        })(list[i]);
      }

      var actions = document.createElement('div');
      actions.className = 'row';
      actions.style.marginTop = '12px';

      var saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn';
      saveBtn.textContent = '保存当前进度';
      saveBtn.addEventListener('click', function () {
        var result = autoSave(false);
        if (result === null) {
          saveBtn.textContent = '现在没有可存的进度';
          setTimeout(function () { saveBtn.textContent = '保存当前进度'; }, 1600);
          return;
        }
        render();
      });
      actions.appendChild(saveBtn);
      sheet.body.appendChild(actions);

      var hint = document.createElement('p');
      hint.className = 'small muted';
      hint.style.margin = '10px 0 0';
      hint.textContent = '最多保留 ' + MAX_SLOTS + ' 个；满了会自动删掉分数最低的那个。';
      sheet.body.appendChild(hint);
    }

    /**
     * 存一份。
     * @param {boolean} useAutoId true = 覆盖 auto 槽（退出时自动存）；
     *                            false = 新建槽（手动存）
     * @returns {object|null} saveSlot 的返回值；没有可存内容时 null
     */
    function autoSave(useAutoId) {
      if (autoSaving) return null;
      var snapshot = null;
      try {
        snapshot = typeof opts.capture === 'function' ? opts.capture() : null;
      } catch (err) {
        snapshot = null;
      }
      if (!snapshot || snapshot.state === undefined || snapshot.state === null) return null;
      autoSaving = true;
      var result = saveSlot(gameId, {
        id: useAutoId ? 'auto' : undefined,
        score: snapshot.score,
        label: snapshot.label,
        state: snapshot.state
      });
      autoSaving = false;
      return result;
    }

    // 顶栏入口
    var bar = document.querySelector('.topbar');
    if (bar !== null) {
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'icon-btn';
      trigger.id = 'slots-btn';
      trigger.textContent = '⛁';
      trigger.setAttribute('aria-label', '存档进度');
      trigger.setAttribute('title', '存档进度');
      trigger.addEventListener('click', function () {
        render();
        sheet.show();
      });
      var modeBtn = bar.querySelector('#mode');
      if (modeBtn !== null && modeBtn.parentNode === bar) bar.insertBefore(trigger, modeBtn);
      else bar.appendChild(trigger);
    }

    // 离开页面：先暂停，再自动存档
    function onLeave() {
      try {
        if (typeof opts.onPause === 'function') opts.onPause();
      } catch (err) { /* 暂停失败也要继续存 */ }
      autoSave(true);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) onLeave();
    });
    window.addEventListener('pagehide', onLeave);

    return { refresh: render, autoSave: function () { return autoSave(true); } };
  }

  /**
   * 游戏页内的"最高分"行：显示 + 单独删除（二次确认）。
   * 首页也有整套记录管理，这里是就地操作，省得为了删一条跑回首页。
   *
   * @param {HTMLElement} container 放这一行的容器
   * @param {string} gameId
   * @param {{format?:Function}} [options]
   */
  function mountScoreRow(container, gameId, options) {
    if (!container) return null;
    var opts = options || {};
    var format = typeof opts.format === 'function' ? opts.format : function (value) {
      return value === null ? '暂无记录' : value + ' 分';
    };

    function render() {
      container.textContent = '';
      var value = getScore(gameId);

      var row = document.createElement('div');
      row.className = 'rec-row';

      var main = document.createElement('div');
      main.className = 'rec-main';
      var name = document.createElement('div');
      name.className = 'rec-name';
      name.textContent = '最高分';
      var val = document.createElement('div');
      val.className = 'rec-val' + (value !== null ? ' has' : '');
      val.textContent = format(value);
      main.appendChild(name);
      main.appendChild(val);
      row.appendChild(main);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn danger';
      del.textContent = '删除';
      del.disabled = value === null;
      confirmAction(del, {
        text: '删除',
        confirmText: '确认删除？',
        onConfirm: function () {
          delScore(gameId);
          render();
        }
      });
      row.appendChild(del);
      container.appendChild(row);
    }

    render();
    return { refresh: render };
  }

  /* ── 相对时间（面板显示"3 分钟前"）──────────────────────────────── */
  function timeAgo(at) {
    if (typeof at !== 'number' || !isFinite(at) || at <= 0) return '';
    var diff = Date.now() - at;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  }

  /* ── 明暗切换按钮的统一装配 ──────────────────────────────────────
   * 每个子页面顶栏放一个按钮，调用它即可。图标用文字（☀/☾），
   * 不引图标库（离线约定）。
   */
  function mountModeToggle(button, page) {
    if (!button) return null;
    function paint() {
      var mode = getMode(page);
      button.textContent = mode === 'dark' ? '☀' : '☾';
      button.setAttribute('aria-label', mode === 'dark' ? '切换到明亮主题' : '切换到暗色主题');
      button.setAttribute('title', mode === 'dark' ? '切换到明亮主题' : '切换到暗色主题');
    }
    paint();
    button.addEventListener('click', function () {
      toggleMode(page);
      paint();
    });
    return { paint: paint };
  }

  window.Arcade = {
    // 存储
    readRaw: readRaw, writeRaw: writeRaw, removeRaw: removeRaw,
    readJSON: readJSON, writeJSON: writeJSON,
    // 主题
    THEMES: THEMES, MODES: MODES,
    getTheme: getTheme, setTheme: setTheme,
    getMode: getMode, setMode: setMode, toggleMode: toggleMode,
    initTheme: initTheme, mountModeToggle: mountModeToggle,
    // 分数
    GAMES: GAMES, getScore: getScore, delScore: delScore,
    clearScores: clearScores, scoreSnapshot: scoreSnapshot,
    // 存档槽
    MAX_SLOTS: MAX_SLOTS, listSlots: listSlots, saveSlot: saveSlot,
    loadSlot: loadSlot, removeSlot: removeSlot, clearSlots: clearSlots,
    mountSlots: mountSlots, mountScoreRow: mountScoreRow,
    // 交互
    confirmAction: confirmAction, timeAgo: timeAgo
  };
})();
