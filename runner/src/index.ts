import 'dotenv/config'
import chalk from 'chalk'
import { WsServer } from './core/ws-server.js'
import { buildClients, DEX_ROUTERS, DEX_FACTORIES } from './config/chains.js'
import { SandwichStrategy } from './strategies/sandwich.js'
import { ArbitrageStrategy } from './strategies/arbitrage.js'
import { SniperStrategy } from './strategies/sniper.js'
import { OnChainScanner } from './core/scanner.js'
import { getPnLSummary, saveSnapshot } from './core/db.js'
import { loadConfig, saveConfig } from './core/config.js'

console.log(chalk.cyan('╔════════════════════════════════╗'))
console.log(chalk.cyan('║      MEV Terminal Runner       ║'))
console.log(chalk.cyan('╚════════════════════════════════╝'))

let cfg = loadConfig()
console.log(chalk.dim(`Chain: ${cfg.chain} | RPC: ${cfg.rpcUrl.slice(0, 40)}`))
if (!cfg.privateKey) {
  console.log(chalk.yellow('[Runner] 未配置私钥，请在 Web 面板设置页完成配置'))
}

const ws = new WsServer(8765)
const strategies: Record<string, SandwichStrategy | ArbitrageStrategy | SniperStrategy> = {}

// Log forwarder — used by Electron to capture logs
export type LogLine = { level: 'info' | 'warn' | 'error'; text: string; ts: number }
const logListeners: ((line: LogLine) => void)[] = []
export function onLog(fn: (line: LogLine) => void) { logListeners.push(fn) }
function emit(level: LogLine['level'], text: string) {
  const line: LogLine = { level, text, ts: Date.now() }
  logListeners.forEach(fn => fn(line))
}

// Patch chalk output to also emit to listeners
const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _err = console.error.bind(console)
console.log = (...args) => { _log(...args); emit('info', args.join(' ')) }
console.warn = (...args) => { _warn(...args); emit('warn', args.join(' ')) }
console.error = (...args) => { _err(...args); emit('error', args.join(' ')) }

function buildScanClient() {
  cfg = loadConfig()
  const dummyKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
  return buildClients(cfg.rpcUrl, dummyKey, cfg.chain)
}

ws.on(async (msg, client) => {
  const { type, payload } = msg

  // ── Config sync ──────────────────────────────────────────
  if (type === 'get_config') {
    const current = loadConfig()
    ws.send(client, {
      type: 'config_state',
      payload: { ...current, privateKey: current.privateKey ? '***' : '' },
    })
    return
  }

  if (type === 'set_config') {
    cfg = saveConfig(payload)
    console.log(chalk.cyan('[Runner] 配置已更新'))
    ws.send(client, { type: 'config_saved', payload: { ok: true } })
    return
  }

  // ── Strategy control ─────────────────────────────────────
  if (type === 'start') {
    cfg = loadConfig()
    const { strategy, config, token } = payload

    if (!cfg.privateKey) {
      ws.send(client, { type: 'error', payload: { message: '请先在设置页配置钱包私钥' } })
      return
    }

    console.log(chalk.cyan(`[Runner] 启动策略: ${strategy}`))
    const { publicClient, walletClient } = buildClients(cfg.rpcUrl, cfg.privateKey, cfg.chain)
    const routers = Object.values(DEX_ROUTERS[cfg.chain] ?? {})

    if (strategy === 'sandwich') {
      const s = new SandwichStrategy(publicClient, walletClient, ws, { ...config, token }, routers)
      strategies[strategy] = s
      await s.start()
    } else if (strategy === 'arbitrage') {
      const s = new ArbitrageStrategy(publicClient, walletClient, ws, config)
      strategies[strategy] = s
      await s.start()
    } else if (strategy === 'sniper') {
      const factoryAddr = Object.values(DEX_FACTORIES[cfg.chain] ?? {})[0] ?? '0x0'
      const s = new SniperStrategy(publicClient, walletClient, ws, config, factoryAddr as `0x${string}`)
      strategies[strategy] = s
      await s.start()
    }
  }

  if (type === 'stop') {
    const { strategy } = payload
    const s = strategies[strategy]
    if (s) { s.stop(); delete strategies[strategy] }
  }

  // ── Scanner ──────────────────────────────────────────────
  if (type === 'scan') {
    console.log(chalk.cyan(`[Runner] 扫描: ${payload.strategy}`))
    try {
      cfg = loadConfig()
      const { publicClient } = buildScanClient()
      const factories = DEX_FACTORIES[cfg.chain] ?? {}
      const routers = DEX_ROUTERS[cfg.chain] ?? {}
      const factoryName = Object.keys(factories)[0] ?? 'PancakeSwap'
      const scanner = new OnChainScanner(
        publicClient,
        factories[factoryName] as `0x${string}`,
        routers[factoryName] as `0x${string}`,
        factoryName
      )
      const bnbPrice = await scanner.getBNBPrice()
      const scanner2 = new OnChainScanner(
        publicClient,
        factories[factoryName] as `0x${string}`,
        routers[factoryName] as `0x${string}`,
        factoryName,
        bnbPrice
      )
      const tokens = await scanner2.scanTopPairs(24)
      ws.broadcast({ type: 'tokens', strategy: payload.strategy ?? 'sandwich', payload: tokens })
    } catch (err: any) {
      console.error(chalk.red('[Scanner] 扫描失败:'), err.message)
      ws.broadcast({ type: 'tokens', strategy: payload.strategy ?? 'sandwich', payload: [] })
    }
  }
})

// ── Broadcast PnL every 5s ───────────────────────────────
setInterval(() => {
  if (ws.connectedCount === 0) return
  ws.broadcast({ type: 'pnl', payload: getPnLSummary() })
}, 5000)

// Broadcast config state on new connection so web can sync
ws.on((msg, client) => {
  if (msg.type === 'connected') {
    const current = loadConfig()
    ws.send(client, {
      type: 'config_state',
      payload: { ...current, privateKey: current.privateKey ? '***set***' : '' },
    })
  }
})

setInterval(() => saveSnapshot(getPnLSummary().totalUSD), 5 * 60 * 1000)

process.on('SIGINT', () => {
  console.log(chalk.yellow('\n[Runner] 正在停止...'))
  Object.values(strategies).forEach(s => s.stop())
  process.exit(0)
})

process.on('uncaughtException', (err) => {
  console.error(chalk.red('[Runner] 未捕获异常:'), err.message)
})
