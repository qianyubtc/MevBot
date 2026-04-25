// Re-export runner logic for Electron main process
// Uses esbuild-bundled runner via dynamic require
import { join } from 'path'
import { app } from 'electron'

export type LogLine = { level: 'info' | 'warn' | 'error'; text: string; ts: number }
const logListeners: ((line: LogLine) => void)[] = []

export function onLog(fn: (line: LogLine) => void) {
  logListeners.push(fn)
}

function emit(level: LogLine['level'], text: string) {
  logListeners.forEach(fn => fn({ level, text, ts: Date.now() }))
}

// Robust stringify — `String(errorObj)` yields "[object Object]".
// Render Errors with message, plain objects via JSON, rest via String().
function renderArg(a: any): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.message ?? a.toString()
  if (a && typeof a === 'object') {
    // viem errors have shortMessage/message
    if (a.shortMessage || a.message) {
      return String(a.shortMessage ?? a.message).split('\n')[0].slice(0, 240)
    }
    try { return JSON.stringify(a).slice(0, 240) } catch { return String(a) }
  }
  return String(a)
}

export async function startRunner() {
  // Patch console so we capture all runner output
  const _log = console.log.bind(console)
  const _warn = console.warn.bind(console)
  const _err = console.error.bind(console)

  console.log = (...args: any[]) => {
    const text = args.map(renderArg).join(' ')
    _log(text)
    emit('info', text)
  }
  console.warn = (...args: any[]) => {
    const text = args.map(renderArg).join(' ')
    _warn(text)
    emit('warn', text)
  }
  console.error = (...args: any[]) => {
    const text = args.map(renderArg).join(' ')
    _err(text)
    emit('error', text)
  }

  // Without these, viem's async WSS errors print as "[object Object]" via the
  // default node rejection handler (which bypasses our patched console).
  process.on('unhandledRejection', (reason: any) => {
    emit('error', `[Runner] 未处理的 Promise 异常: ${renderArg(reason)}`)
  })
  process.on('uncaughtException', (err: any) => {
    emit('error', `[Runner] 未捕获异常: ${renderArg(err)}`)
  })

  // Dynamically load the runner bundle
  // In production: bundled alongside app
  // In dev: load from runner/src
  try {
    const runnerPath = app.isPackaged
      ? join(__dirname, '../assets/runner-bundle.js')
      : join(__dirname, '../../runner/dist-cjs/bundle.js')
    require(runnerPath)
    emit('info', '✓ OC SuperBot Runner 已启动')
  } catch (err: any) {
    emit('error', `Runner 加载失败: ${err.message}`)
  }
}
