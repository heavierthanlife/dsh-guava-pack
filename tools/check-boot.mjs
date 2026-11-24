#!/usr/bin/env node
/**
 * check-boot.mjs — DSH **运行态**自检：启动日志 / 监听端口 / 路由健康。
 *
 * 为什么需要它：`install.mjs --check` 只看"包和补丁对不对"，看不到"跑起来对不对"。
 * 2026-11-24 升级 0.2.2-rc.5 时踩过的雷正好都在运行态：
 *   · `dsh: warning: 2 required entries did not activate` —— 界面空壳，但磁盘上一切正常
 *   · `/api/web/listProviders` 404 —— 路由代理没挂上
 *   · `tool-subagent-list-agents ... never started` —— 所有会话打不开
 * 这些都不会让任何命令报错，只能从 web-run.log 的**最后一段**和端口上看出来。
 *
 * 用法：
 *   node tools/check-boot.mjs              # 严格模式：有问题 exit 1
 *   node tools/check-boot.mjs --advisory   # 永远 exit 0（install.mjs --check 用）
 *   node tools/check-boot.mjs --json       # 机器可读，不做彩色输出
 *   node tools/check-boot.mjs --no-title    # 不打印标题（被别的脚本调用时用）
 *
 * 环境变量：
 *   DSH_HOME             默认 ~/dsh
 *   DSH_ROUTER_PORT      默认 8318（路由代理）
 *   DSH_WEB_PORT         默认 3080（Web UI）
 *   DSH_CHECK_PORTS      覆盖"必须监听"的端口列表，逗号分隔，默认 "$DSH_WEB_PORT,$DSH_ROUTER_PORT"
 *                        设为 `none` 则只查日志、不判端口（离线看别人的日志时用）
 *   DSH_CHECK_LOG        覆盖日志路径，默认 $DSH_HOME/logs/web-run.log
 *
 * 只读：不写任何文件、不发任何请求出去的包、不改服务状态。
 */

import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import net from 'node:net'
import http from 'node:http'

const argv = new Set(process.argv.slice(2))
const ADVISORY = argv.has('--advisory')
const JSON_OUT = argv.has('--json')
const NO_TITLE = argv.has('--no-title')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), 'dsh')
const WEB_PORT = Number(process.env.DSH_WEB_PORT || 3080)
const ROUTER_PORT = Number(process.env.DSH_ROUTER_PORT || 8318)
const REQUIRED_PORTS = (process.env.DSH_CHECK_PORTS || `${WEB_PORT},${ROUTER_PORT}`)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)

/** 顺便看一眼的端口：缺了不判失败（命令桥、OpenCode 之类可能故意不开）。 */
const OPTIONAL_PORTS = [8317]

/**
 * `DSH_CHECK_PORTS=none` → 只判日志，完全不碰端口。
 * 两个用处：① 离线看别的机器的日志；② 测试里要隔离端口状态。
 * 此时视为"服务在跑"（日志判断不到端口，就按当前进程算）。
 */
const SKIP_PORTS = String(process.env.DSH_CHECK_PORTS || '').trim().toLowerCase() === 'none'

const LOG = process.env.DSH_CHECK_LOG || join(DSH_HOME, 'logs', 'web-run.log')

/**
 * 已知无害、不该污染判定的日志噪音。
 * `[deepseek-account]` / `[llm-deepseek-account]` 是官方账号接口在这些网络上
 * 连不通时的常态重试（`no-response`），和本机装配好坏无关。
 */
const BENIGN = [
  '[deepseek-account]',
  '[llm-deepseek-account]',
  'ExperimentalWarning',
  'stripTypeScriptTypes',
  '--trace-warnings',
  'request failed',
]

/** @type {{section:string, level:'ok'|'warn'|'fail'|'info', text:string}[]} */
const results = []
const add = (section, level, text) => results.push({ section, level, text })

/** 探一个 127.0.0.1 端口是否在监听（不依赖 ss，WSL/容器都可靠）。 */
function probePort(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** GET 一个本机 HTTP 端点，返回 {status, error}。 */
function probeHttp(port, path, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, error: null })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, error: 'timeout' })
    })
    req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }))
  })
}

/** 截取日志里**最后一次启动**之后的部分。 */
/** 只读文件末尾 maxBytes：日志能长到几十 MB，全文读进来没必要（只要最后一段）。 */
function readTailBytes(path, maxBytes = 512 * 1024) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return { text: buf.toString('utf8'), truncated: start > 0, size }
  } finally {
    closeSync(fd)
  }
}

function readLastRun() {
  if (!existsSync(LOG)) return { missing: true }
  let tail
  try {
    tail = readTailBytes(LOG)
  } catch (err) {
    return { error: err.message }
  }
  const lines = tail.text.split('\n')
  let start = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('dsh web: http')) {
      start = i
      break
    }
  }
  if (start < 0) return { noBanner: true, lines: lines.slice(-40) }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(LOG).mtimeMs
  } catch {}
  return {
    banner: lines[start],
    lines: lines.slice(start),
    mtimeMs,
    totalLines: lines.length,
    truncated: tail.truncated,
    size: tail.size,
  }
}

function checkLog(liveUp) {
  const S = '启动日志'
  const run = readLastRun()

  if (run.missing) {
    add(S, 'info', `没有日志 ${LOG} —— 这台机器还没跑过 dsh web？`)
    return
  }
  if (run.error) {
    add(S, 'warn', `日志读不了（${run.error}）—— 跳过日志判定`)
    return
  }
  if (run.noBanner) {
    add(S, 'warn', '日志里找不到 `dsh web: http` 启动横幅 —— 无法定位"最后一段"')
    return
  }

  // 服务没在跑时，日志里的告警属于上一次进程，不能当成当前故障。
  const sev = liveUp ? 'fail' : 'warn'
  const when = new Date(run.mtimeMs).toLocaleString('zh-CN', { hour12: false })
  add(S, 'info', `${LOG}（${run.truncated ? '只读末尾 512KB，' : ''}共 ${run.totalLines} 行，最后写入 ${when}）`)

  const token = (run.banner.match(/token=([A-Za-z0-9_-]+)/) || [])[1]
  if (token) add(S, 'info', `本次地址：${run.banner.replace(/^dsh web: /, '')}`)

  const body = run.lines.slice(1)
  const hay = body.join('\n')

  // ① 激活审计：最凶的一条，且它本身写得足够清楚，直接把整行带出来。
  const audit = body.filter((l) => /did not activate/.test(l))
  if (audit.length > 0) {
    for (const line of audit) add(S, sev, line.trim())
    add(S, sev, '→ 见反向索引 `ops/tunnel/BREAK-GLASS.md` §8.21（客户端模块清单缺包）')
  } else {
    add(S, 'ok', '没有 "entry did not activate"')
  }

  // ② pending：把还在等服务的条目名点出来，比审计那行更有用。
  // 行样：`@deepseek-ai/dsh-client-ui-sidebar (required): pending (waiting for service: uiWorkspace)`
  // 括号里可能是 `required` 也可能是别的，统一用 `\([^)]*\)` 吃掉。
  const pending = body
    .map((l) => (l.match(/^(\S+?)(?: \([^)]*\))?: pending \(waiting for/) || [])[1])
    .filter(Boolean)
  if (pending.length > 0) {
    add(S, sev, `${pending.length} 个插件仍 pending：${pending.slice(0, 6).join(', ')}${pending.length > 6 ? ' …' : ''}`)
  }

  // ③ 子路径 / 模块没起来：会话打不开的典型签名。
  const neverStarted = body.filter((l) => /never started/.test(l))
  if (neverStarted.length > 0) {
    for (const line of neverStarted.slice(0, 3)) add(S, sev, line.trim())
    add(S, sev, '→ 多半是上游包的 exports 子路径漏发（见 BREAK-GLASS §8.22）')
  }

  // ④ 其它真错误：滤掉已知噪音和堆栈帧，只留头部几行。
  const suspicious = body.filter((l) => {
    if (l.startsWith('    ') || l.startsWith('\t')) return false
    if (BENIGN.some((b) => l.includes(b))) return false
    return /Error:|error:|failed|Cannot|cannot/.test(l)
  })
  if (suspicious.length === 0) {
    add(S, 'ok', `最后一段没有其它错误（已滤掉 ${BENIGN.length} 类已知噪音）`)
  } else {
    add(S, 'warn', `最后一段还有 ${suspicious.length} 行疑似错误（前 3 行）：`)
    for (const line of suspicious.slice(0, 3)) add(S, 'warn', `  ${line.trim().slice(0, 160)}`)
  }
}

async function main() {
  const liveUp = SKIP_PORTS ? true : await probePort(WEB_PORT)

  checkLog(liveUp)

  if (SKIP_PORTS) {
    add('端口', 'info', 'DSH_CHECK_PORTS=none —— 跳过端口与路由探活')
  } else {
    // 端口
    const S = '端口'
    for (const port of REQUIRED_PORTS) {
      // eslint-disable-next-line no-await-in-loop
      const up = port === WEB_PORT ? liveUp : await probePort(port)
      const what = port === WEB_PORT ? 'Web UI' : port === ROUTER_PORT ? '路由代理' : ''
      if (up) add(S, 'ok', `${port} 在监听${what ? `（${what}）` : ''}`)
      else add(S, 'fail', `${port} 没在监听${what ? `（${what}）` : ''}`)
    }
    for (const port of OPTIONAL_PORTS) {
      if (REQUIRED_PORTS.includes(port)) continue
      // eslint-disable-next-line no-await-in-loop
      const up = await probePort(port)
      add(S, up ? 'ok' : 'info', `${port}${up ? ' 在监听（可选）' : ' 没在监听（可选，未开就不管）'}`)
    }

    // 路由健康
    const H = '路由健康'
    const routerUp = REQUIRED_PORTS.includes(ROUTER_PORT) ? await probePort(ROUTER_PORT) : true
    if (!routerUp) {
      add(H, 'info', `路由代理 ${ROUTER_PORT} 没起来，跳过 /health 探活`)
    } else {
      const health = await probeHttp(ROUTER_PORT, '/health')
      if (health.status === 200) add(H, 'ok', `${ROUTER_PORT}/health → 200`)
      else add(H, 'warn', `${ROUTER_PORT}/health → ${health.status || health.error}`)
    }
  }

  const failures = results.filter((r) => r.level === 'fail')
  const warns = results.filter((r) => r.level === 'warn')

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failures.length === 0, failures: failures.length, warns: warns.length, results }, null, 2))
  } else {
    // 被 install.mjs 调用时（--no-title）整体缩进两格，嵌进它的「  ✅」风格里，
    // 并且末行用「运行态：」而不是「结果：」—— 免得和安装自检的结论混在一起。
    const pad = NO_TITLE ? '  ' : ''
    const lines = []
    if (!NO_TITLE) lines.push('DSH 运行态自检', '')
    const order = ['启动日志', '端口', '路由健康']
    for (const section of order) {
      const rows = results.filter((r) => r.section === section)
      if (rows.length === 0) continue
      lines.push(`${section}：`)
      for (const r of rows) {
        const mark = r.level === 'ok' ? '✅' : r.level === 'fail' ? '❌' : r.level === 'warn' ? '⚠️ ' : 'ℹ️ '
        lines.push(`  ${mark} ${r.text}`)
      }
    }
    lines.push(
      '',
      `${NO_TITLE ? '运行态' : '结果'}：${failures.length === 0 ? '正常' : `${failures.length} 项异常`}` +
        (warns.length ? `（另有 ${warns.length} 条提醒）` : ''),
    )
    console.log(lines.map((l) => (l === '' ? l : pad + l)).join('\n'))
  }

  if (ADVISORY) process.exit(0)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`check-boot 自身出错：${err?.stack || err}`)
  process.exit(ADVISORY ? 0 : 2)
})
