#!/usr/bin/env node
/**
 * set-search-provider — 命令行切换联网搜索后端（等价于设置面板里的两个按钮）。
 *
 * ## 为什么还需要一个 CLI
 *
 * 面板按钮走 host 路由，只能在页面里点。但有两个场景 CLI 更方便：
 *   · 刚装好插件、还没重启时想先把 pin 摆好（注意见下面的警告）；
 *   · 排障时不想开浏览器。
 *
 * ## ⚠️ 顺序警告（真踩过）
 *
 * seam 的选择是"配置优先"。如果把 `web.searchProvider` 钉成 `switch`，而插件
 * **还没挂载**（新装后没重启），搜索会立刻变成：
 *
 *     configured web provider "switch" is not registered
 *
 * 所以：**先重启 DSH，再跑这个命令。** 面板按钮天然安全（能点开面板说明插件已挂载）。
 *
 * 用法：
 *   node tools/set-search-provider.mjs status
 *   node tools/set-search-provider.mjs official     # 偏好=官方，并把 pin 钉到 switch
 *   node tools/set-search-provider.mjs tavily       # 偏好=Tavily，并把 pin 钉到 switch
 *   node tools/set-search-provider.mjs bypass       # pin 写回 deepseek-official（绕过插件）
 *   node tools/set-search-provider.mjs switch       # 只钉 pin，不动偏好
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  currentSearchProvider,
  OFFICIAL_PROVIDER_ID,
  pinSearchProvider,
  profilePatchPath,
  SWITCH_PROVIDER_ID,
} from '../plugins/dsh-web-search-switch/lib/pin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(HERE);
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
const PREFERENCE_FILE = join(DSH_HOME, 'storages', 'web-search-switch.json');
const BACKENDS = ['official', 'tavily'];

const ok = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const info = (m) => console.log(`  ℹ️  ${m}`);

function readPreference() {
  try {
    const parsed = JSON.parse(readFileSync(PREFERENCE_FILE, 'utf8'));
    return BACKENDS.includes(parsed?.backend) ? parsed.backend : 'official';
  } catch {
    return 'official';
  }
}

function writePreference(backend) {
  mkdirSync(dirname(PREFERENCE_FILE), { recursive: true });
  writeFileSync(PREFERENCE_FILE, JSON.stringify({ backend, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

/** 插件是否已**装进** profile（bundles 列表里有它）。 */
function pluginInstalled() {
  try {
    const pkg = JSON.parse(readFileSync(join(DSH_HOME, 'profiles', 'web', 'package.json'), 'utf8'));
    return (pkg?.dsh?.profile?.bundles ?? []).includes('dsh-web-search-switch');
  } catch {
    return false;
  }
}

/**
 * 插件是否**已挂在运行中的 DSH 里**。
 *
 * 这两件事必须分开：
 *   · 装进 profile（bundles 列表）→ 下次启动才加载；
 *   · 已挂载 → 运行中的进程真的注册了 `switch` provider。
 *
 * 在"装好但没重启"的窗口里把 pin 改成 switch，搜索会立刻
 * `configured provider "switch" is not registered`（真踩过）。
 *
 * 判据：插件 apply() 时写的 mounted 标记里的 pid，必须等于当前监听 3080 的进程 pid。
 */
function pluginMounted() {
  const marker = join(DSH_HOME, 'storages', 'web-search-switch.mounted.json');
  let pid;
  try {
    pid = JSON.parse(readFileSync(marker, 'utf8'))?.pid;
  } catch {
    return { mounted: false, reason: '没有挂载标记（插件从未在本机启动过，或版本太旧）' };
  }
  const listener = listeningPid(3080);
  if (!listener) return { mounted: false, reason: `读不到 3080 的监听进程（标记 pid=${pid}）` };
  if (pid !== listener) {
    return { mounted: false, reason: `挂载标记是 pid=${pid}，但当前 DSH 是 pid=${listener}（装好后还没重启）` };
  }
  return { mounted: true, pid };
}

/** 用 fuser 找监听某端口的 pid（Linux）。拿不到就返回 undefined。 */
function listeningPid(port) {
  try {
    const out = execFileSync('fuser', ['-n', 'tcp', String(port)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = out.match(/(\d+)/g);
    return match && match.length ? Number(match[match.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] ?? 'status').toLowerCase();

  const pin = currentSearchProvider(DSH_HOME);
  const preference = readPreference();
  const installed = pluginInstalled();

  if (cmd === 'status') {
    console.log('联网搜索后端状态\n');
    info(`profile patch : ${profilePatchPath(DSH_HOME)}`);
    info(`searchProvider: ${pin.value ?? '(未写，base 默认 deepseek-official)'}`);
    info(`偏好后端      : ${preference}`);
    info(`插件已装进 profile: ${installed ? '是' : '否'}`);
    const mounted = pluginMounted();
    info(`插件已挂载到运行中的 DSH: ${mounted.mounted ? `是（pid=${mounted.pid}）` : `否 —— ${mounted.reason}`}`);
    const effective = pin.value === SWITCH_PROVIDER_ID ? preference : OFFICIAL_PROVIDER_ID;
    console.log(`\n  → 当前实际生效：${effective}`);
    if (pin.value === SWITCH_PROVIDER_ID && !installed) {
      warn('pin 指向 switch 但插件没装进 profile —— 搜索会报 configured provider not registered');
    }
    return 0;
  }

  if (cmd === 'bypass') {
    const r = pinSearchProvider(DSH_HOME, OFFICIAL_PROVIDER_ID);
    ok(r.changed ? `pin 已写回 ${OFFICIAL_PROVIDER_ID}（${r.how}）` : `pin 已经是 ${OFFICIAL_PROVIDER_ID}`);
    if (r.backup) info(`备份：${r.backup}`);
    return 0;
  }

  if (cmd === 'switch') {
    const mounted = pluginMounted();
    if (!mounted.mounted) {
      warn('插件还没挂载到运行中的 DSH —— 现在把 pin 钉成 switch 会让搜索立刻报错：');
      warn(`  ${mounted.reason}`);
      warn('建议：先重启 DSH 再跑这条命令（或直接在设置面板里点）。');
      return 1;
    }
    const r = pinSearchProvider(DSH_HOME, SWITCH_PROVIDER_ID);
    ok(r.changed ? `pin 已钉到 ${SWITCH_PROVIDER_ID}（${r.how}）` : `pin 已经是 ${SWITCH_PROVIDER_ID}`);
    if (r.backup) info(`备份：${r.backup}`);
    return 0;
  }

  if (!BACKENDS.includes(cmd)) {
    console.error(`未知参数「${cmd}」。可选：status / official / tavily / switch / bypass`);
    return 2;
  }

  const mounted = pluginMounted();
  if (!mounted.mounted) {
    // 只记偏好、不动 pin：等插件挂载后 apply() 会自愈（那时 provider 已注册，安全）。
    writePreference(cmd);
    warn('插件还没挂载到运行中的 DSH，pin 先保持不动（否则搜索会立刻坏）。');
    warn(`  ${mounted.reason}`);
    ok(`偏好已记为 ${cmd}；重启 DSH 后插件会自己把 pin 钉到 switch`);
    return 0;
  }

  writePreference(cmd);
  ok(`偏好已切到 ${cmd}`);
  const r = pinSearchProvider(DSH_HOME, SWITCH_PROVIDER_ID);
  ok(r.changed ? `pin 已钉到 ${SWITCH_PROVIDER_ID}（${r.how}）` : `pin 已是 ${SWITCH_PROVIDER_ID}`);
  if (r.backup) info(`备份：${r.backup}`);
  info('profile patch 是热生效的：下一次搜索就走新后端，无需重启');
  return 0;
}

if (!existsSync(join(DSH_HOME, 'profiles', 'web'))) {
  console.error(`找不到 ${join(DSH_HOME, 'profiles', 'web')} —— DSH_HOME 对吗？`);
  process.exit(2);
}

process.exit(await main());
