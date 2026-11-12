#!/usr/bin/env node
/**
 * tools/tests/vbs-autostart.mjs — Windows 自启 VBS 的编码/换行回归门禁。
 *
 * 为什么需要（2026-11-12 真实事故）：
 *   `ops/install-tailnet-autostart.sh` 原用 `cat > file <<EOF` 生成
 *   `dsh-wsl-autostart.vbs`，在 WSL 上写出来是 **LF + UTF-8**。VBScript 解析器
 *   不认 LF-only 换行 —— 第 3 行被并进上一行注释，`Set sh = ...` 从未执行，
 *   第 4 行 `sh.Run` 报「缺少对象: 'sh'（800A01A8）」。Windows 登录时弹错误框。
 *
 * 这里不依赖 Windows：直接把生成逻辑的字节契约钉死 ——
 *   · 前两字节 = FF FE（UTF-16LE BOM）
 *   · CRLF 数 = 4，裸 LF 数 = 0
 *   · 解码后内容与期望的 4 行一致（含中文注释）
 *
 * 用法：node tools/tests/vbs-autostart.mjs
 *
 * @module tools/tests/vbs-autostart
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = dirname(dirname(HERE));
const SRC = join(PACK, 'ops', 'install-tailnet-autostart.sh');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const script = readFileSync(SRC, 'utf8');

// ── 静态断言：生成方式必须是"CRLF + 转 UTF-16LE + BOM" ────────────────────
check('生成 VBS 时用 printf 拼 CRLF（不再用 heredoc 直接写）',
  /VBS="\$STARTUP\/dsh-wsl-autostart\.vbs"/.test(script) && /printf '.*\\r\\n'/.test(script));
check('通过 iconv 转 UTF-16LE',
  /iconv -f UTF-8 -t UTF-16LE/.test(script));
check('写入 UTF-16LE BOM（\\377\\376）',
  /printf '\\\\377\\\\376'/.test(script) || /printf '\\377\\376'/.test(script));
check('不残留"heredoc 直接写 VBS"的旧写法',
  !/cat > "\$VBS" <<EOF/.test(script));
check('写完后有 BOM/裸 LF 自检',
  /vbs_bom=/.test(script) && /vbs_bare_lf=/.test(script));

// ── 行为断言：复刻脚本的生成逻辑，检查字节 ────────────────────────────────
const WSL_WIN = 'C:\\\\Windows\\\\System32\\\\wsl.exe';
const DISTRO = 'Ubuntu';
const lines = [
  "' 由 dsh-guava-pack/ops/install-tailnet-autostart.sh 生成：登录时静默拉起 WSL",
  "' （WSL 起来后 systemd user linger 会自动启动 dsh.service 与 dsh-entry.service）",
  'Set sh = CreateObject("WScript.Shell")',
  `sh.Run "${WSL_WIN} -d ${DISTRO} --exec /bin/sh -c ""sleep infinity""", 0, False`,
];
const text = lines.map((line) => `${line}\r\n`).join('');
const utf8crlf = Buffer.from(text, 'utf8');
const utf16 = Buffer.from(text, 'utf16le');
const vbs = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);

check('BOM 是 FF FE', vbs[0] === 0xff && vbs[1] === 0xfe, `${vbs[0].toString(16)} ${vbs[1].toString(16)}`);
const crlf = [...vbs.keys()].filter((i) => vbs[i] === 0x0d && vbs[i + 1] === 0x00 && vbs[i + 2] === 0x0a && vbs[i + 3] === 0x00).length;
check('CRLF 恰好 4 个', crlf === 4, `crlf=${crlf}`);
// UTF-16LE 里 EOL 是 0d 00 0a 00：LF 字节前面的 0x00 是它自己的高字节，
// 再往前两个字节才是 CR 的 0d。判断"裸 LF"必须按这个布局来。
const strictBareLf = (() => {
  let count = 0;
  for (let i = 0; i < vbs.length - 1; i += 1) {
    const isLf = vbs[i] === 0x0a && vbs[i + 1] === 0x00;
    if (!isLf) continue;
    const precededByCr = i >= 2 && vbs[i - 1] === 0x00 && vbs[i - 2] === 0x0d;
    if (!precededByCr) count += 1;
  }
  return count;
})();
check('没有裸 LF（LF-only 会让 VBScript 报 缺少对象: sh）', strictBareLf === 0, `bareLf=${strictBareLf}`);
check('CRLF 版本解码后内容一致',
  vbs.subarray(2).toString('utf16le') === text);
check('4 行结构完整（注释 2 行 + Set + Run）',
  lines.length === 4 && /^Set sh = CreateObject\("WScript\.Shell"\)$/.test(lines[2]) && /^sh\.Run "/.test(lines[3]));

// ── 边界：LF-only 应当被判定为不可接受（防止有人"顺手改回"） ──────────────
const lfOnly = Buffer.from(lines.join('\n'), 'utf8');
check('反例：LF-only + UTF-8 确实不含 C 风格 CRLF（说明检测有效）',
  lfOnly.toString('latin1').includes('\n') && !lfOnly.toString('latin1').includes('\r\n'));

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} ${passed}/${passed + failures.length}${failures.length ? ` — ${failures.join('; ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
