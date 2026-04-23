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

export async function startRunner() {
  // Patch console so we capture all runner output
  const _log = console.log.bind(console)
  const _warn = console.warn.bind(console)
  const _err = console.error.bind(console)

  console.log = (...args: any[]) => {
    const text = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
    _log(text)
    emit('info', text)
  }
  console.warn = (...args: any[]) => {
    const text = args.map(a => String(a)).join(' ')
    _warn(text)
    emit('warn', text)
  }
  console.error = (...args: any[]) => {
    const text = args.map(a => String(a)).join(' ')
    _err(text)
    emit('error', text)
  }

  // Dynamically load the runner bundle
  // In production: bundled alongside app
  // In dev: load from runner/src
  try {
    const runnerPath = app.isPackaged
      ? join(process.resourcesPath, 'runner-bundle.js')
      : join(__dirname, '../../runner/dist-cjs/bundle.js')
    require(runnerPath)
    emit('info', '✓ MEV Terminal Runner 已启动')
  } catch (err: any) {
    emit('error', `Runner 加载失败: ${err.message}`)
  }
}
