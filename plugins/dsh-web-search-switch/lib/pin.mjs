/**
 * 把 profile 里 `web` 条目的 `searchProvider` 钉到 `switch`。
 *
 * ## 为什么要单独一层
 *
 * seam 的选择是"配置优先"：`web.searchProvider` 指向谁就用谁。dsh-base 默认写死
 * `deepseek-official`，所以本插件注册的 `switch` provider 即使挂载成功也**永远不会
 * 被选中** —— 必须在 profile 里把这一项改掉。
 *
 * ## 两个实测出来的硬约束
 *
 * 1. **profile patch 是热生效的**（改完立刻重算组合，不用重启）——
 *    但**只对"写入/修改"成立**：把一条 `- id: ...` 覆盖**删掉**不会可靠回滚
 *    （实测：删除 `- id: web` 后 seam 仍报 `configured "switch" is not registered`）。
 *    所以这里永远"写目标值"，从不靠删除回退 —— 回滚也是写回 `deepseek-official`。
 * 2. **顺序有风险**：如果在插件还没挂载时就把 pin 改成 `switch`，搜索会立刻坏掉
 *    （`configured provider "switch" is not registered`）。所以调用方必须先确认
 *    插件已挂载，或者在同一个"用户明确点了切换"的动作里做这件事。
 *
 * ## 实现方式
 *
 * 纯文本手术（不 parse + dump：那会丢掉用户所有注释和字段顺序）。
 *   · 已有 `- id: web` 块 → 只改它下面的 `searchProvider:` 那一行；
 *   · 没有 → 在文件末尾追加一个块（Cordis patch 按顺序应用，追加即覆盖）。
 * 改前先写 `.bak-<ts>`，改后用最小结构校验兜底。
 *
 * @module dsh-web-search-switch/pin
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** base 默认值：也是"绕过本插件"时应当写回的值。 */
export const OFFICIAL_PROVIDER_ID = 'deepseek-official';
/** 本插件注册的 provider id。 */
export const SWITCH_PROVIDER_ID = 'switch';

/** profile patch 文件路径。 */
export function profilePatchPath(dshHome) {
  return join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
}

/**
 * 读当前 pin。返回 `{ value, blockStart, blockEnd, searchProviderLine }`；
 * 没有 `- id: web` 块时 value 为 `undefined`。
 */
export function readSearchProvider(text) {
  const lines = String(text).split('\n');
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s*id:\s*web\s*$/.test(lines[i])) { blockStart = i; break; }
  }
  if (blockStart === -1) return { value: undefined, blockStart: -1, blockEnd: -1, searchProviderLine: -1 };
  // 块结束：下一个顶格 `- ` 开头（或 `# ` 注释后跟顶格条目）之前
  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) { blockEnd = i; break; }
  }
  let searchProviderLine = -1;
  let value;
  for (let i = blockStart + 1; i < blockEnd; i++) {
    const m = lines[i].match(/^\s+searchProvider:\s*(.*)$/);
    if (m) {
      searchProviderLine = i;
      value = m[1].trim().replace(/^['"]|['"]$/g, '');
      break;
    }
  }
  return { value, blockStart, blockEnd, searchProviderLine };
}

/**
 * 生成"把 pin 设为 target"的新文本。纯函数，方便自检。
 * @param {string} text
 * @param {string} target
 * @returns {{ text: string, changed: boolean, how: 'rewritten'|'appended'|'unchanged' }}
 */
export function pinText(text, target = SWITCH_PROVIDER_ID) {
  const info = readSearchProvider(text);
  if (info.value === target) return { text, changed: false, how: 'unchanged' };

  if (info.blockStart !== -1 && info.searchProviderLine !== -1) {
    const lines = text.split('\n');
    const indent = (lines[info.searchProviderLine].match(/^(\s*)/) ?? ['', '    '])[1];
    lines[info.searchProviderLine] = `${indent}searchProvider: ${target}`;
    return { text: lines.join('\n'), changed: true, how: 'rewritten' };
  }

  if (info.blockStart !== -1) {
    // 有 `- id: web` 但没写 searchProvider：插到块首行之后。
    const lines = text.split('\n');
    const insertAt = info.blockStart + 1;
    lines.splice(insertAt, 0, '  config:', `    searchProvider: ${target}`, `    fetchProvider: http`);
    return { text: lines.join('\n'), changed: true, how: 'rewritten' };
  }

  // 追加块。注意结尾补换行，避免拼到上一行上。
  const suffix = text.endsWith('\n') ? '' : '\n';
  const block = [
    '',
    '# ── 联网搜索后端：钉到可切换的 provider（由 dsh-web-search-switch 维护）──',
    '# 想绕过本插件回到官方：把下面的 searchProvider 改回 deepseek-official',
    '# （**改值**会热生效；**删掉整块**不会可靠回滚 —— 实测踩过）。',
    '- id: web',
    '  config:',
    `    searchProvider: ${target}`,
    '    fetchProvider: http',
    '',
  ].join('\n');
  return { text: `${text}${suffix}${block}`, changed: true, how: 'appended' };
}

/**
 * 把 profile 里的 pin 写成 `target`。幂等；改前备份。
 *
 * @param {string} dshHome
 * @param {string} [target]
 * @returns {{ changed: boolean, how: string, file: string, backup?: string, value: string }}
 */
export function pinSearchProvider(dshHome, target = SWITCH_PROVIDER_ID) {
  const file = profilePatchPath(dshHome);
  if (!existsSync(file)) throw new Error(`找不到 profile patch：${file}`);
  const before = readFileSync(file, 'utf8');
  const result = pinText(before, target);
  if (!result.changed) return { changed: false, how: 'unchanged', file, value: target };

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `${file}.bak-searchpin-${stamp}`;
  copyFileSync(file, backup);
  writeFileSync(file, result.text, 'utf8');

  // 最小结构校验：写回后必须能读到自己写的值，且缩进没被破坏。
  const check = readSearchProvider(readFileSync(file, 'utf8'));
  if (check.value !== target) {
    copyFileSync(backup, file); // 回滚
    throw new Error(`写入后校验失败（读到 ${String(check.value)}），已回滚。备份：${backup}`);
  }
  return { changed: true, how: result.how, file, backup, value: target };
}

/** 读当前 pin（不写盘）。 */
export function currentSearchProvider(dshHome) {
  const file = profilePatchPath(dshHome);
  if (!existsSync(file)) return { value: undefined, file };
  return { value: readSearchProvider(readFileSync(file, 'utf8')).value, file };
}
