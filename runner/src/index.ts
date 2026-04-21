import 'dotenv/config'
import chalk from 'chalk'
import { WsServer } from './core/ws-server.js'
import { buildClients, DEX_ROUTERS, DEX_FACTORIES } from './config/chains.js'
import { SandwichStrategy } from './strategies/sandwich.js'
import { ArbitrageStrategy } from './strategies/arbitrage.js'
import { SniperStrategy } from './strategies/sniper.js'
import { OnChainScanner } from './core/scanner.js'
import { getPnLSummary, saveSnapshot } from './core/db.js'

const CHAIN = process.env.CHAIN ?? 'BSC'
const RPC_URL = process.env.RPC_URL ?? 'https://bsc-dataseed.binance.org'
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? ''

// Build a read-only client for scanning (no private key needed)
function buildScanClient() {
  return buildClients(RPC_URL, '0x0000000000000000000000000000000000000000000000000000000000000001', CHAIN)
}

console.log(chalk.cyan('╔════════════════════════════════╗'))
console.log(chalk.cyan('║      MEV Terminal Runner       ║'))
console.log(chalk.cyan('╚════════════════════════════════╝'))
console.log(chalk.dim(`Chain: ${CHAIN} | RPC: ${RPC_URL.slice(0, 40)}...`))

const ws = new WsServer(8765)

const strategies: Record<string, SandwichStrategy | ArbitrageStrategy | SniperStrategy> = {}

ws.on(async (msg, client) => {
  const { type, payload } = msg

  if (type === 'start') {
    const { strategy, config, token } = payload
    console.log(chalk.cyan(`[Runner] 启动策略: ${strategy}`))

    if (!PRIVATE_KEY) {
      ws.broadcast({ type: 'error', payload: { message: '未配置私钥，无法启动策略' } })
      return
    }

    const { publicClient, walletClient } = buildClients(RPC_URL, PRIVATE_KEY, CHAIN)
    const routers = Object.values(DEX_ROUTERS[CHAIN] ?? {})

    if (strategy === 'sandwich') {
      const s = new SandwichStrategy(publicClient, walletClient, ws, { ...config, token }, routers)
      strategies[strategy] = s
      await s.start()
    } else if (strategy === 'arbitrage') {
      const s = new ArbitrageStrategy(publicClient, walletClient, ws, config)
      strategies[strategy] = s
      await s.start()
    } else if (strategy === 'sniper') {
      const factoryAddr = Object.values(DEX_FACTORIES[CHAIN] ?? {})[0] ?? '0x0'
      const s = new SniperStrategy(publicClient, walletClient, ws, config, factoryAddr as `0x${string}`)
      strategies[strategy] = s
      await s.start()
    }
  }

  if (type === 'stop') {
    const { strategy } = payload
    const s = strategies[strategy]
    if (s) {
      s.stop()
      delete strategies[strategy]
    }
  }

  if (type === 'scan') {
    console.log(chalk.cyan(`[Runner] 真实链上扫描: ${payload.strategy}`))
    try {
      const { publicClient } = buildScanClient()
      const factories = DEX_FACTORIES[CHAIN] ?? {}
      const routers = DEX_ROUTERS[CHAIN] ?? {}
      const factoryName = Object.keys(factories)[0] ?? 'PancakeSwap'
      const factoryAddr = factories[factoryName] as `0x${string}`
      const routerAddr = routers[factoryName] as `0x${string}`

      const scanner = new OnChainScanner(publicClient, factoryAddr, routerAddr, factoryName)
      const bnbPrice = await scanner.getBNBPrice()
      const scannerWithPrice = new OnChainScanner(publicClient, factoryAddr, routerAddr, factoryName, bnbPrice)
      const tokens = await scannerWithPrice.scanTopPairs(24)
      ws.broadcast({ type: 'tokens', payload: tokens })
    } catch (err: any) {
      console.error(chalk.red('[Scanner] 扫描失败:'), err.message)
      ws.broadcast({ type: 'tokens', payload: [] })
    }
  }

  if (type === 'get_prices') {
    // Real multi-DEX price comparison for arbitrage
    try {
      const { publicClient } = buildScanClient()
      const routers = DEX_ROUTERS[CHAIN] ?? {}
      const factories = DEX_FACTORIES[CHAIN] ?? {}
      const scanner = new OnChainScanner(
        publicClient,
        Object.values(factories)[0] as `0x${string}`,
        Object.values(routers)[0] as `0x${string}`,
        'PancakeSwap'
      )
      const routerList = Object.entries(routers).map(([name, address]) => ({ name, address: address as `0x${string}` }))
      const prices = await scanner.getMultiDexPrices(payload.tokenAddress, routerList)
      ws.send(client, { type: 'prices', payload: prices })
    } catch {}
  }
})

// Broadcast PnL every 5 seconds
setInterval(() => {
  if (ws.connectedCount === 0) return
  const pnl = getPnLSummary()
  ws.broadcast({ type: 'pnl', payload: pnl })
}, 5000)

// Save PnL snapshot every 5 minutes
setInterval(() => {
  const pnl = getPnLSummary()
  saveSnapshot(pnl.totalUSD)
}, 5 * 60 * 1000)

process.on('SIGINT', () => {
  console.log(chalk.yellow('\n[Runner] 正在停止所有策略...'))
  Object.values(strategies).forEach((s) => s.stop())
  process.exit(0)
})

process.on('uncaughtException', (err) => {
  console.error(chalk.red('[Runner] 未捕获异常:'), err)
})
