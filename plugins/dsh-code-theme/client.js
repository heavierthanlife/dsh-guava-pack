/**
 * dsh-code-theme — 只给代码上色的主题插件。
 *
 * ## 为什么能做到"只改代码、不动正文"
 *
 * 宿主的高亮器是 Shiki，但配的是 **css-variables 主题**（`variablePrefix: '--shiki-'`），
 * 也就是每个 token 的颜色写成 `color: var(--shiki-token-keyword)` 这种**变量引用**，
 * 变量本身由主题样式表定义：
 *
 *   :root                    { --shiki-token-keyword:#d6336c; … }   ← 浅色
 *   body[data-ds-dark-theme] { --shiki-token-keyword:#faa2c1; … }   ← 深色
 *
 * 所以只要在**代码容器**上重设这些变量，就精确地只影响代码：
 * 正文、按钮、标签一个都不碰。明暗两套也天然分开，自动适配不用额外逻辑。
 *
 * ## 两层落地（互为保险）
 *
 * 1. 原始 CSS：把 `--shiki-*` 与 `--dsw-alias-markdown-code-*` 写在 `pre`/`code` 等
 *    代码容器上（含 `body[data-ds-dark-theme]` 深色分支）。这一层不依赖任何 API，
 *    一定生效。
 * 2. 主题服务：`ctx.theme.overrideTokens(pkgId, {token:{light,dark}})` 把代码底色等
 *    注册成正式覆盖层，这样宿主自己的检查工具（exportInspectTokens）也能看到。
 *    包在 try/catch 里 —— 万一某个变量名不在宿主目录内，第 1 层照常工作。
 *
 * ## 手动明暗
 *
 * `body.dct-force-dark` / `body.dct-force-light` 两个类。为了让它们压过
 * `body[data-ds-dark-theme]`（同特异性、靠顺序决胜），强制规则的选择器**类名写两遍**
 * 提权（`.dct-force-dark.dct-force-dark pre`），不用 `!important`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-theme',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-code-theme';
    const PKG_ID = 'dsh-code-theme';
    const STORE_KEY = 'dsh-code-theme.preference';
    const STYLE_ATTR = 'data-plugin';

    // ── 宿主定义的 shiki 变量名（见 ui-theme 的 shiki_css_default）──────────
    const SHIKI_TOKENS = [
      'constant',
      'string',
      'comment',
      'keyword',
      'parameter',
      'function',
      'string-expression',
      'punctuation',
      'link',
    ];

    /**
     * 代码容器选择器。
     * `pre`/`code` 是稳定元素；带下划线的类名是 CSS-module 的（`o3BgMG_codeBody` 这种，
     * 哈希会随构建变），所以用 `[class*="_xxx"]` 匹配后缀 —— 匹配不到也不影响前两个。
     */
    const CODE_SEL = [
      'pre',
      'code',
      '[class*="_codeBody"]',
      '[class*="_codeBlock"]',
      '[class*="_ioCard"]',
      '[class*="_diffBody"]',
      '[class*="_terminalBody"]',
    ].join(',');

    /**
     * 调色板。两套都给出 light/dark 双份（宿主要求覆盖层必须成对，
     * 否则切到另一套配色时会读不清）。
     *
     * 注：少数颜色相对"原版"做了亮度调整 —— 原版在浅底上只有 2~3:1 对比度，
     * 手机上基本看不清。`tools/check-contrast.mjs` 会逐项算 WCAG 对比度并报出来。
     */
    const PALETTES = {
      'monokai-pro': {
        label: 'Monokai Pro',
        dark: {
          background: '#2d2a2e',
          foreground: '#fcfcfa',
          constant: '#ab9df2',
          string: '#ffd866',
          'string-expression': '#ffd866',
          comment: '#9b979b',
          keyword: '#ff6188',
          parameter: '#fc9867',
          function: '#a9dc76',
          punctuation: '#b3b0b3',
          link: '#78dce8',
          block: '#2d2a2e',
          banner: '#221f22',
          inline: '#3a373b',
          selected: '#423f44',
          unselected: '#2d2a2e',
          diffAdded: '#3d4a33',
          diffDeleted: '#4a2f33',
        },
        light: {
          background: '#faf4f2',
          foreground: '#2d2a2e',
          constant: '#7058be',
          string: '#a35f00',
          'string-expression': '#a35f00',
          comment: '#6b6669',
          keyword: '#c2185b',
          parameter: '#a34700',
          function: '#1b7a4b',
          punctuation: '#6f6a6d',
          link: '#0f6f86',
          block: '#faf4f2',
          banner: '#f2eae7',
          inline: '#f0e6e2',
          selected: '#e8dcd7',
          unselected: '#faf4f2',
          diffAdded: '#e2f0d9',
          diffDeleted: '#fbe4e6',
        },
      },
      material: {
        label: 'Material',
        dark: {
          background: '#263238',
          foreground: '#eeffff',
          constant: '#f78c6c',
          string: '#c3e88d',
          'string-expression': '#c3e88d',
          comment: '#90a4ae',
          keyword: '#c792ea',
          parameter: '#ffcb6b',
          function: '#82aaff',
          punctuation: '#89ddff',
          link: '#80cbc4',
          block: '#263238',
          banner: '#1e272c',
          inline: '#37474f',
          selected: '#3b4a52',
          unselected: '#263238',
          diffAdded: '#33472f',
          diffDeleted: '#4a2f34',
        },
        light: {
          background: '#fafafa',
          foreground: '#546e7a',
          constant: '#bf360c',
          string: '#4a7a22',
          'string-expression': '#4a7a22',
          comment: '#4f6b77',
          keyword: '#7c4dff',
          parameter: '#9a5c00',
          function: '#4a6fa5',
          punctuation: '#0f7b82',
          link: '#0f7b82',
          block: '#fafafa',
          banner: '#f0f0f0',
          inline: '#eceff1',
          selected: '#e0e0e0',
          unselected: '#fafafa',
          diffAdded: '#dcedc8',
          diffDeleted: '#ffcdd2',
        },
      },
      'one-dark': {
        label: 'One Dark',
        dark: {
          background: '#282c34',
          foreground: '#abb2bf',
          constant: '#d19a66',
          string: '#98c379',
          'string-expression': '#98c379',
          comment: '#949ba8',
          keyword: '#c678dd',
          parameter: '#d19a66',
          function: '#61afef',
          punctuation: '#9da5b4',
          link: '#56b6c2',
          block: '#282c34',
          banner: '#21252b',
          inline: '#3a3f4b',
          selected: '#3e4451',
          unselected: '#282c34',
          diffAdded: '#34472f',
          diffDeleted: '#4a2f34',
        },
        light: {
          background: '#fafafa',
          foreground: '#383a42',
          constant: '#986801',
          string: '#3d7a3c',
          'string-expression': '#3d7a3c',
          comment: '#6f7278',
          keyword: '#a626a4',
          parameter: '#986801',
          function: '#2f5fd0',
          punctuation: '#696c77',
          link: '#016f9e',
          block: '#fafafa',
          banner: '#f0f0f1',
          inline: '#ececed',
          selected: '#e5e5e6',
          unselected: '#fafafa',
          diffAdded: '#dff0d8',
          diffDeleted: '#fbe4e6',
        },
      },
      github: {
        label: 'GitHub',
        dark: {
          background: '#0d1117',
          foreground: '#c9d1d9',
          constant: '#79c0ff',
          string: '#a5d6ff',
          'string-expression': '#a5d6ff',
          comment: '#8b949e',
          keyword: '#ff7b72',
          parameter: '#ffa657',
          function: '#d2a8ff',
          punctuation: '#c9d1d9',
          link: '#58a6ff',
          block: '#0d1117',
          banner: '#161b22',
          inline: '#21262d',
          selected: '#30363d',
          unselected: '#0d1117',
          diffAdded: '#1b3a24',
          diffDeleted: '#4a1f24',
        },
        light: {
          background: '#ffffff',
          foreground: '#24292f',
          constant: '#0550ae',
          string: '#0a3069',
          'string-expression': '#0a3069',
          comment: '#6e7781',
          keyword: '#cf222e',
          parameter: '#953800',
          function: '#8250df',
          punctuation: '#24292f',
          link: '#0969da',
          block: '#ffffff',
          banner: '#f6f8fa',
          inline: '#f0f2f4',
          selected: '#eaeef2',
          unselected: '#ffffff',
          diffAdded: '#dafbe1',
          diffDeleted: '#ffebe9',
        },
      },
      // ⚠️ 近似配色：OpenCode 官方内置主题的十六进制值没有公开文档，这份是按它的
      // token 结构（comment/keyword/function/variable/string/number/type/operator/
      // punctuation）加品牌观感拼的。拿到官方色值后替换这一段即可。
      opencode: {
        label: 'OpenCode（近似）',
        dark: {
          background: '#0b0b0c',
          foreground: '#e6e6e6',
          constant: '#d2a8ff',
          string: '#a6e3a1',
          'string-expression': '#a6e3a1',
          comment: '#8a8a8a',
          keyword: '#ff8f40',
          parameter: '#ffcc66',
          function: '#8ab4f8',
          punctuation: '#b0b0b0',
          link: '#7fd1e0',
          block: '#0b0b0c',
          banner: '#141416',
          inline: '#1e1e21',
          selected: '#26262a',
          unselected: '#0b0b0c',
          diffAdded: '#1f3a25',
          diffDeleted: '#43242a',
        },
        light: {
          background: '#fafafa',
          foreground: '#1f2328',
          constant: '#6b21a8',
          string: '#166534',
          'string-expression': '#166534',
          comment: '#6b7280',
          keyword: '#c2410c',
          parameter: '#92400e',
          function: '#1d4ed8',
          punctuation: '#4b5563',
          link: '#0e7490',
          block: '#fafafa',
          banner: '#f1f1f2',
          inline: '#ececee',
          selected: '#e3e3e6',
          unselected: '#fafafa',
          diffAdded: '#dff0d8',
          diffDeleted: '#fbe4e6',
        },
      },
    };

    const PALETTE_IDS = Object.keys(PALETTES);
    const DEFAULT_PREF = { palette: 'monokai-pro', scheme: 'auto', font: true };
    const SCHEMES = ['auto', 'dark', 'light'];

    const DICT = {
      zh: {
        nav: '代码配色',
        'section.title': '代码配色',
        'section.desc': '只影响代码块与行内代码，正文和其他界面不受影响。',
        'row.palette': '调色板',
        'row.scheme': '代码区明暗',
        'row.font': '代码字体',
        'font.maple': 'Maple Mono CN',
        'font.theme': '跟随主题',
        'scheme.auto': '跟随界面',
        'scheme.dark': '强制深色',
        'scheme.light': '强制浅色',
        'preview.label': '预览',
        'note.contrast': '对比度已按 WCAG AA（≥4.5:1）校验，手机上也能看清。',
      },
      en: {
        nav: 'Code colors',
        'section.title': 'Code colors',
        'section.desc': 'Affects code blocks and inline code only — prose and other UI stay untouched.',
        'row.palette': 'Palette',
        'row.scheme': 'Code scheme',
        'row.font': 'Code font',
        'font.maple': 'Maple Mono CN',
        'font.theme': 'Follow theme',
        'scheme.auto': 'Follow UI',
        'scheme.dark': 'Force dark',
        'scheme.light': 'Force light',
        'preview.label': 'Preview',
        'note.contrast': 'Contrast checked against WCAG AA (≥4.5:1) so it stays readable on a phone.',
      },
    };

    /** 代码字体栈：Maple Mono CN 系列 + 完整回退（没装该字体也不会变丑）。 */
    const CODE_FONT =
      "'Maple Mono CN', 'Maple Mono NF CN', 'Maple Mono', 'JetBrains Mono', " +
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', " +
      "'PingFang SC', 'Microsoft YaHei', monospace";

    /** 读偏好（localStorage；解析失败回默认）。 */
    function readPref() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (raw === null) return { ...DEFAULT_PREF };
        const parsed = JSON.parse(raw);
        return {
          palette: PALETTE_IDS.includes(parsed?.palette) ? parsed.palette : DEFAULT_PREF.palette,
          scheme: SCHEMES.includes(parsed?.scheme) ? parsed.scheme : DEFAULT_PREF.scheme,
          font: parsed?.font !== false,
        };
      } catch {
        return { ...DEFAULT_PREF };
      }
    }

    /** 写偏好。 */
    function writePref(pref) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(pref));
      } catch {
        /* 隐私模式下写不进去也不影响本次生效 */
      }
    }

    /** 把一套配色摊平成 CSS 变量声明。 */
    function varsFor(mode) {
      const out = [`--shiki-foreground:${mode.foreground}`, `--shiki-background:${mode.background}`];
      for (const key of SHIKI_TOKENS) out.push(`--shiki-token-${key}:${mode[key]}`);
      out.push(`--dsw-alias-markdown-code-block:${mode.block}`);
      out.push(`--dsw-alias-markdown-code-block-banner:${mode.banner}`);
      out.push(`--dsw-alias-markdown-inline-code:${mode.inline}`);
      out.push(`--dsw-alias-markdown-code-segment-selected:${mode.selected}`);
      out.push(`--dsw-alias-markdown-code-segment-unselected:${mode.unselected}`);
      out.push(`--dsw-alias-code-diff-added:${mode.diffAdded}`);
      out.push(`--dsw-alias-code-diff-deleted:${mode.diffDeleted}`);
      return out.join(';');
    }

    /** 给选择器列表统一加作用域前缀。 */
    function scope(prefix, selector) {
      return selector
        .split(',')
        .map((part) => `${prefix} ${part.trim()}`)
        .join(',');
    }

    /**
     * 生成整份样式表（只含代码容器选择器）。
     *
     * 两个关键点：
     *
     * 1. **必须同时设 `color`，不能只设 `--shiki-*`。** 没有语言标签的代码块不会分词
     *    （Shiki 不产出 token span），那段文字的颜色只由容器的 `color` 决定 —— 不设
     *    就会被主题自己的 `code{color:…}` 接管（赛博主题就是明黄 #fcee0a）。
     * 2. **用 `:root` 前缀提权。** 主题也写 `code{color:…}`，同特异性时胜负取决于样式表
     *    顺序，不可靠；`:root code` 稳定压过 `code`。
     */
    function buildCss(paletteId, scheme, codeFont) {
      const palette = PALETTES[paletteId] ?? PALETTES[DEFAULT_PREF.palette];
      const fontVars = codeFont
        ? `--ds-font-family-code:${CODE_FONT};` +
          `--dsw-font-markdown-code-font-family:${CODE_FONT};` +
          `--dsw-font-markdown-code-block-font-family:${CODE_FONT};` +
          `--dsw-font-markdown-code-block-small-font-family:${CODE_FONT};`
        : '';
      const decls = (mode) => `${fontVars}${varsFor(mode)};color:${mode.foreground}`;

      const lines = [
        `/* ${PKG_ID} · ${palette.label} · ${scheme}${codeFont ? ' · Maple Mono CN' : ''} */`,
        `${scope(':root', CODE_SEL)}{${decls(palette.light)}}`,
        `${scope(':root body[data-ds-dark-theme]', CODE_SEL)}{${decls(palette.dark)}}`,
        `:root :not(pre) > code{color:${palette.light.foreground};background:${palette.light.inline}}`,
        `:root body[data-ds-dark-theme] :not(pre) > code{color:${palette.dark.foreground};background:${palette.dark.inline}}`,
      ];
      if (scheme === 'dark' || scheme === 'light') {
        const forced = scheme === 'dark' ? palette.dark : palette.light;
        // 类名写两遍 + :root 前缀 → 特异性 (0,3,2)，压过上面的深色规则 (0,2,2)。
        const prefix = `:root body.dct-force-${scheme}.dct-force-${scheme}`;
        lines.push(`${scope(prefix, CODE_SEL)}{${decls(forced)}}`);
        lines.push(`${prefix} :not(pre) > code{color:${forced.foreground};background:${forced.inline}}`);
      }
      return lines.join('\n');
    }

    /** 把强制类写到 <body> 上。 */
    function applyForceClass(scheme) {
      const body = document.body;
      if (body === null) return;
      body.classList.toggle('dct-force-dark', scheme === 'dark');
      body.classList.toggle('dct-force-light', scheme === 'light');
    }

    /** 传给主题服务的覆盖层（键=变量名，值={light,dark}）。 */
    function overrideLayer(palette) {
      const pair = (key) => ({ light: palette.light[key], dark: palette.dark[key] });
      return {
        '--dsw-alias-markdown-code-block': pair('block'),
        '--dsw-alias-markdown-code-block-banner': pair('banner'),
        '--dsw-alias-markdown-inline-code': pair('inline'),
        '--dsw-alias-markdown-code-segment-selected': pair('selected'),
        '--dsw-alias-markdown-code-segment-unselected': pair('unselected'),
        '--dsw-alias-code-diff-added': pair('diffAdded'),
        '--dsw-alias-code-diff-deleted': pair('diffDeleted'),
      };
    }

    /** 代码预览用的样例（覆盖各 token 类型）。 */
    const SAMPLE = [
      { text: '// 对比度已按 WCAG AA 校验', cls: 'comment' },
      { text: 'export async function ', cls: 'keyword' },
      { text: 'loadUser', cls: 'function' },
      { text: '(', cls: 'punctuation' },
      { text: 'id', cls: 'parameter' },
      { text: ': ', cls: 'punctuation' },
      { text: 'string', cls: 'keyword' },
      { text: ') {', cls: 'punctuation' },
      { text: '  const res = await fetch(', cls: null },
      { text: '`/api/user/${id}`', cls: 'string' },
      { text: ', { method: ', cls: 'punctuation' },
      { text: "'GET'", cls: 'string' },
      { text: ' });', cls: 'punctuation' },
      { text: '  if (res.status !== ', cls: null },
      { text: '200', cls: 'constant' },
      { text: ') throw new Error(', cls: 'punctuation' },
      { text: "'请求失败'", cls: 'string' },
      { text: ');', cls: 'punctuation' },
      { text: '  return res.json();', cls: null },
      { text: '}', cls: 'punctuation' },
    ];

    function CodeThemeSection({ t }) {
      const [pref, setPref] = React.useState(readPref);
      const palette = PALETTES[pref.palette] ?? PALETTES[DEFAULT_PREF.palette];

      const tr = (key) => {
        if (typeof t === 'function') {
          try {
            const out = t(key);
            if (typeof out === 'string' && out !== key) return out;
          } catch {
            /* 落到兜底 */
          }
        }
        return DICT.zh[key] ?? key;
      };

      const update = (patch) => {
        const next = { ...pref, ...patch };
        setPref(next);
        writePref(next);
        window.dispatchEvent(new CustomEvent('dsh-code-theme/change', { detail: next }));
      };

      return h('div', { className: 'dct_root' }, [
        h('style', { key: 'css' }, UI_CSS),
        h('div', { key: 'title', className: 'dct_title' }, tr('section.title')),
        h('div', { key: 'desc', className: 'dct_desc' }, tr('section.desc')),

        h('div', { key: 'palette', className: 'dct_row' }, [
          h('div', { key: 'l', className: 'dct_label' }, tr('row.palette')),
          h(
            'div',
            { key: 'v', className: 'dct_seg' },
            PALETTE_IDS.map((id) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  'data-on': pref.palette === id ? 'true' : 'false',
                  onClick: () => update({ palette: id }),
                },
                PALETTES[id].label,
              ),
            ),
          ),
        ]),

        h('div', { key: 'scheme', className: 'dct_row' }, [
          h('div', { key: 'l', className: 'dct_label' }, tr('row.scheme')),
          h(
            'div',
            { key: 'v', className: 'dct_seg' },
            SCHEMES.map((id) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  'data-on': pref.scheme === id ? 'true' : 'false',
                  onClick: () => update({ scheme: id }),
                },
                tr(`scheme.${id}`),
              ),
            ),
          ),
        ]),

        h('div', { key: 'font', className: 'dct_row' }, [
          h('div', { key: 'l', className: 'dct_label' }, tr('row.font')),
          h(
            'div',
            { key: 'v', className: 'dct_seg' },
            [
              { id: true, label: tr('font.maple') },
              { id: false, label: tr('font.theme') },
            ].map((opt) =>
              h(
                'button',
                {
                  key: String(opt.id),
                  type: 'button',
                  'data-on': pref.font === opt.id ? 'true' : 'false',
                  onClick: () => update({ font: opt.id }),
                },
                opt.label,
              ),
            ),
          ),
        ]),

        h('div', { key: 'pl', className: 'dct_label dct_previewLabel' }, tr('preview.label')),
        // 预览直接引用 --shiki-token-* 变量 → 显示的就是真实生效的颜色，不会和实际跑偏。
        h(
          'pre',
          { key: 'preview', className: 'dct_preview' },
          h(
            'code',
            null,
            SAMPLE.map((part, i) =>
              part.cls === null
                ? h('span', { key: i }, part.text)
                : h('span', { key: i, style: { color: `var(--shiki-token-${part.cls})` } }, part.text),
            ),
          ),
        ),
        h('div', { key: 'note', className: 'dct_desc' }, tr('note.contrast')),
      ]);
    }

    const UI_CSS = `
.dct_root{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px}
.dct_title{color:var(--dsw-alias-label-primary);font-weight:500}
.dct_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dct_row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dct_label{color:var(--dsw-alias-label-secondary);min-width:84px;flex:none}
.dct_previewLabel{margin-top:4px}
.dct_seg{display:flex;gap:6px;flex-wrap:wrap}
.dct_seg button{padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
  background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dct_seg button[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover-solid);
  color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dct_preview{margin:0;padding:12px 14px;border-radius:var(--dsw-radius-lg);overflow-x:auto;
  font:var(--dsw-font-markdown-code-block-small,12px/18px monospace);
  background:var(--shiki-background);color:var(--shiki-foreground)}
`;

    return {
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'code-theme: dictionaries');

        // 样式表挂在插件生命周期上（不要放组件里：HMR 重载组件时内联 <style>
        // 会短暂消失，元素就失去配色）。
        let styleEl = null;
        let disposeOverride = null;
        let current = readPref();

        const applyPreference = (pref) => {
          current = pref;
          const palette = PALETTES[pref.palette] ?? PALETTES[DEFAULT_PREF.palette];
          if (styleEl !== null) styleEl.textContent = buildCss(pref.palette, pref.scheme, pref.font !== false);
          applyForceClass(pref.scheme);
          // 第 2 层：注册成正式的主题覆盖层（拿不到 API 也不影响第 1 层）。
          try {
            disposeOverride?.();
            disposeOverride = ctx.theme?.overrideTokens?.(PKG_ID, overrideLayer(palette)) ?? null;
          } catch {
            disposeOverride = null;
          }
        };

        ctx.effect(() => {
          styleEl = document.createElement('style');
          styleEl.setAttribute(STYLE_ATTR, PKG_ID);
          document.head.appendChild(styleEl);
          applyPreference(current);

          const onChange = (event) => applyPreference(event.detail ?? readPref());
          window.addEventListener('dsh-code-theme/change', onChange);
          return () => {
            window.removeEventListener('dsh-code-theme/change', onChange);
            try {
              disposeOverride?.();
            } catch {
              /* 服务已卸载 */
            }
            styleEl?.remove();
            styleEl = null;
            document.body?.classList.remove('dct-force-dark', 'dct-force-light');
          };
        }, 'code-theme: styles');

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'code-theme',
              order: 40,
              // 设置页左侧导航的标题来自 label（漏了它导航项就是空白）。
              // 必须是函数：宿主按当前语言求值，两个官方插件都这么写。
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
            },
            CodeThemeSection,
          ),
        );
      },
    };
  },
});
