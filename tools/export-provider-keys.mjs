#!/usr/bin/env node
/**
 * export-provider-keys — 把 DSH 凭证库里的 provider key 导出成 shell/systemd 环境变量。
 *
 * 为什么需要：DSH 把 key 存在 `<DSH_HOME>/.credentials.yaml`（`refs` 段，明文、
 * 文件 0600），LLM 请求由 DSH 自己解析，所以 provider 能用；但 **commandcode 桥接**
 * 和 **model-policy 定时任务** 是独立进程，只读环境变量 —— 它们拿不到凭证库，
 * 于是桥接启动即报 "COMMANDCODE_API_KEY 未设置"。
 *
 * 这里只做"读出来 → 打印成 export/NAME=VALUE"，不做任何网络或写入。
 *
 * 用法：
 *   eval "$(node tools/export-provider-keys.mjs)"            # shell: export K=V
 *   node tools/export-provider-keys.mjs --systemd > env      # systemd: K=V
 *
 * 安全：值只走 stdout；不落盘、不打印到日志（调用方负责 eval 或重定向到 0600 文件）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const systemdMode = process.argv.includes('--systemd');
const home = process.env.DSH_HOME || join(process.env.HOME || '', 'dsh');
const file = process.env.DSH_CREDENTIALS_FILE || join(home, '.credentials.yaml');

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  process.exit(0); // 没有凭证库：安静退出，调用方回落到既有来源
}

/** 去掉 YAML 里常见的包裹引号。 */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

/** 只解析顶层 `refs:` 段（缩进的 `NAME: value` 行），够用且无依赖。 */
const refs = {};
let inRefs = false;
for (const line of text.split('\n')) {
  if (/^refs:\s*$/.test(line)) {
    inRefs = true;
    continue;
  }
  if (!inRefs) continue;
  if (/^\S/.test(line)) break; // 回到顶格 → refs 段结束
  const m = line.match(/^\s+([A-Za-z0-9_]+):\s+(.+?)\s*$/);
  if (m) refs[m[1]] = unquote(m[2]);
}

for (const [name, value] of Object.entries(refs)) {
  if (!/^[A-Z0-9_]+$/.test(name) || value === '') continue;
  if (systemdMode) {
    // systemd EnvironmentFile：值里有空格需整体加引号
    process.stdout.write(`${name}=${/[\s"']/.test(value) ? `"${value}"` : value}\n`);
  } else {
    // shell：用单引号最安全（值里的单引号转义）
    process.stdout.write(`export ${name}='${value.replace(/'/g, `'\\''`)}'\n`);
  }
}
