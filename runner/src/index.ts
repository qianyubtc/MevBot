import 'dotenv/config'
import chalk from 'chalk'
import { WsServer } from './core/ws-server.js'
import { buildClients, DEX_ROUTERS, DEX_FACTORIES } from './config/chains.js'
import { formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SandwichStrategy } from './strategies/sandwich.js'
import { ArbitrageStrategy } from './strategies/arbitrage.js'
import { SniperStrategy } from './strategies/sniper.js'
import { BackrunStrategy } from './strategies/backrun.js'
import { OnChainScanner } from './core/scanner.js'
import { getPnLSummary, saveSnapshot, resetData } from './core/db.js'
import { loadConfig, saveConfig } from './core/config.js'

console.log(chalk.cyan('╔════════════════════════════════╗'))
console.log(chalk.cyan('║       OC SuperBot Runner       ║'))
console.log(chalk.cyan('╚════════════════════════════════╝'))

let cfg = loadConfig()
console.log(chalk.dim(`Chain: ${cfg.chain} | RPC: ${cfg.rpcUrl.slice(0, 40)}`))
if (!cfg.privateKey) {
  console.log(chalk.yellow('[Runner] 未配置私钥，请在 Web 面板设置页完成配置'))
}

const ws = new WsServer(8765)
const strategies: Record<string, SandwichStrategy | ArbitrageStrategy | SniperStrategy | BackrunStrategy> = {}

// Log forwarder — used by Electron to capture logs
export type LogLine = { level: 'info' | 'warn' | 'error'; text: string; ts: number }
const logListeners: ((line: LogLine) => void)[] = []
export function onLog(fn: (line: LogLine) => void) { logListeners.push(fn) }
function emit(level: LogLine['level'], text: string) {
  const line: LogLine = { level, text, ts: Date.now() }
  logListeners.forEach(fn => fn(line))
}

// Patch chalk output to also emit to listeners. Render errors/objects readably
// so Electron log viewer doesn't show "[object Object]".
function renderArg(a: any): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.message ?? a.toString()
  if (a && typeof a === 'object') {
    if (a.shortMessage || a.message) {
      return String(a.shortMessage ?? a.message).split('\n')[0].slice(0, 240)
    }
    try { return JSON.stringify(a).slice(0, 240) } catch { return String(a) }
  }
  return String(a)
}
const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _err = console.error.bind(console)
console.log = (...args) => { _log(...args); emit('info', args.map(renderArg).join(' ')) }
console.warn = (...args) => { _warn(...args); emit('warn', args.map(renderArg).join(' ')) }
console.error = (...args) => { _err(...args); emit('error', args.map(renderArg).join(' ')) }

// Surface async rejections instead of letting node's default handler dump
// "[object Object]" to stderr.
process.on('unhandledRejection', (reason: any) => {
  console.warn(chalk.yellow(`[Runner] 未处理的 Promise 异常:`), reason?.shortMessage ?? reason?.message ?? String(reason))
})

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

  if (type === 'reset_data') {
    resetData()
    console.log(chalk.yellow('[Runner] 数据已重置'))
    ws.send(client, { type: 'reset_ok', payload: { ok: true } })
    ws.broadcast({ type: 'pnl', payload: getPnLSummary() })
    return
  }

  if (type === 'get_balance') {
    cfg = loadConfig()
    if (!cfg.privateKey) {
      ws.send(client, { type: 'wallet_balance', payload: { bnb: null, error: '未配置私钥' } })
      return
    }
    try {
      const { publicClient } = buildScanClient()
      const account = privateKeyToAccount(cfg.privateKey as `0x${string}`)
      const raw = await publicClient.getBalance({ address: account.address })
      const bnb = parseFloat(formatUnits(raw, 18))
      ws.send(client, { type: 'wallet_balance', payload: { bnb, address: account.address } })
    } catch (e: any) {
      ws.send(client, { type: 'wallet_balance', payload: { bnb: null, error: e.message } })
    }
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

    // ── Balance check ─────────────────────────────────────
    try {
      const { publicClient: scanClient } = buildScanClient()
      const account = privateKeyToAccount(cfg.privateKey as `0x${string}`)
      const raw = await scanClient.getBalance({ address: account.address })
      const bnb = parseFloat(formatUnits(raw, 18))
      // Dynamic minimum: execution amount in BNB + 0.005 BNB gas buffer
      const execUSD = config?.executionAmountUSD ?? 5
      const BNB_PRICE = 580
      // Gas buffer ≈ $5 worth of BNB so the $5 minimum execution amount sits
      // on top of a $10 total floor. Keeps the door open for shoestring users
      // while still leaving room for one reverted tx.
      const GAS_BUFFER_USD = 5
      const MIN_BNB = parseFloat(((execUSD + GAS_BUFFER_USD) / BNB_PRICE).toFixed(4))
      if (bnb < MIN_BNB) {
        ws.send(client, {
          type: 'error',
          payload: { message: `BNB 余额不足：当前 ${bnb.toFixed(4)} BNB，执行金额 $${execUSD} 至少需要 ${MIN_BNB} BNB（本金 $${execUSD} + Gas $${GAS_BUFFER_USD}）` },
        })
        return
      }
      console.log(chalk.dim(`[Runner] 钱包余额: ${bnb.toFixed(4)} BNB`))
    } catch (e: any) {
      console.warn(chalk.yellow('[Runner] 余额查询失败，跳过检查:'), e.message)
    }

    // Stop any existing instance of this strategy first (covers token-switch case)
    if (strategies[strategy]) {
      strategies[strategy].stop()
      delete strategies[strategy]
      console.log(chalk.yellow(`[Runner] 已停止旧 ${strategy} 策略`))
    }

    // Per-strategy RPC override: if the user filled `rpcUrl` in the strategy's
    // config card, use that; otherwise fall back to the global RPC. This lets
    // each bot run on its own dedicated node so they can't compete for sockets
    // or rate-limit each other.
    const strategyRpc = (typeof config?.rpcUrl === 'string' && config.rpcUrl.trim())
      ? config.rpcUrl.trim()
      : cfg.rpcUrl
    if (strategyRpc !== cfg.rpcUrl) {
      console.log(chalk.cyan(`[Runner] 启动策略: ${strategy} · 使用专用节点 ${strategyRpc.slice(0, 40)}…`))
    } else {
      console.log(chalk.cyan(`[Runner] 启动策略: ${strategy}`))
    }
    const { publicClient, walletClient } = buildClients(strategyRpc, cfg.privateKey, cfg.chain)
    const routers = Object.values(DEX_ROUTERS[cfg.chain] ?? {})

    if (strategy === 'sandwich') {
      const s = new SandwichStrategy(publicClient, walletClient, ws, { ...config, token }, routers)
      strategies[strategy] = s
      await s.start()
    } else if (strategy === 'backrun') {
      const s = new BackrunStrategy(publicClient, walletClient, ws, { ...config, token })
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

  // ── Analyze single token by CA ───────────────────────────
  if (type === 'analyze_token') {
    const { address } = payload
    try {
      cfg = loadConfig()
      const { publicClient } = buildScanClient()
      const factories = DEX_FACTORIES[cfg.chain] ?? {}
      const routers = DEX_ROUTERS[cfg.chain] ?? {}
      const factoryName = Object.keys(factories)[0] ?? 'PancakeSwap'
      const bnbScanner = new OnChainScanner(publicClient, factories[factoryName] as `0x${string}`, routers[factoryName] as `0x${string}`, factoryName)
      const bnbPrice = await bnbScanner.getBNBPrice()
      const scanner = new OnChainScanner(publicClient, factories[factoryName] as `0x${string}`, routers[factoryName] as `0x${string}`, factoryName, bnbPrice)
      const token = await scanner.analyzeToken(address)
      if (token) {
        ws.send(client, { type: 'token_analyzed', payload: token })
      } else {
        ws.send(client, { type: 'error', payload: { message: `未找到该合约的流动性池: ${address}` } })
      }
    } catch (err: any) {
      ws.send(client, { type: 'error', payload: { message: `查询失败: ${err.message}` } })
    }
    return
  }

  // ── LP Yield Snapshot ────────────────────────────────────
  // Read reserves of a fixed list of major BSC pools, compute TVL in USD
  // and the BNB-side reserve. Web side renders the table; runner does the
  // RPC work so we don't have to ship viem to the browser.
  if (type === 'query_lp_pools') {
    try {
      cfg = loadConfig()
      const { publicClient } = buildScanClient()
      const { parseAbi, formatUnits } = await import('viem')
      const PAIR_ABI = parseAbi([
        'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
        'function token0() view returns (address)',
        'function totalSupply() view returns (uint256)',
      ])
      const ROUTER_ABI = parseAbi([
        'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
      ])

      const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
      const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'
      const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
      // Hand-picked top-TVL Pancake V2 pairs. Stable DEX surface so we don't
      // need an indexer. Pair addresses are deterministic (CREATE2) so they
      // never change.
      const POOLS = [
        { sym: 'CAKE-BNB', pair: '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0' },
        { sym: 'BUSD-BNB', pair: '0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16' },
        { sym: 'USDT-BNB', pair: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE' },
        { sym: 'USDC-BNB', pair: '0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b' },
        { sym: 'ETH-BNB',  pair: '0x74E4716E431f45807DCF19f284c7aA99F18a4fbc' },
        { sym: 'BTCB-BNB', pair: '0x61EB789d75A95CAa3fF50ed7E47b96c132fEc082' },
        { sym: 'DOT-BNB',  pair: '0xDd5bAd8f8b360d76d12FdA230F8BAF42fe0022CF' },
        { sym: 'LINK-BNB', pair: '0x824eb9faDFb377394430d2744fa7C42916DE3eCe' },
      ]

      // Snapshot BNB price first.
      let bnbPrice = 580
      try {
        const a = await publicClient.readContract({
          address: ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut',
          args: [BigInt(1e18), [WBNB, BUSD]],
        }) as bigint[]
        const p = Number(formatUnits(a[1], 18))
        if (p > 100 && p < 10000) bnbPrice = p
      } catch { /* fall back */ }

      const results = await Promise.all(POOLS.map(async (p) => {
        try {
          const [reserves, token0] = await Promise.all([
            publicClient.readContract({ address: p.pair as `0x${string}`, abi: PAIR_ABI, functionName: 'getReserves' }),
            publicClient.readContract({ address: p.pair as `0x${string}`, abi: PAIR_ABI, functionName: 'token0' }),
          ])
          const isWbnb0 = String(token0).toLowerCase() === WBNB.toLowerCase()
          const reserveBNB = isWbnb0 ? reserves[0] : reserves[1]
          // LP TVL is BNB-side × 2 (the two halves are equal-value at equilibrium).
          const tvlUSD = Number(formatUnits(reserveBNB, 18)) * bnbPrice * 2
          return { sym: p.sym, pair: p.pair, tvlUSD, reserveBNB: Number(formatUnits(reserveBNB, 18)) }
        } catch (e: any) {
          return { sym: p.sym, pair: p.pair, tvlUSD: 0, reserveBNB: 0, error: e?.message ?? 'rpc error' }
        }
      }))

      ws.send(client, { type: 'lp_pools', payload: { pools: results, bnbPrice, ts: Date.now() } })
    } catch (err: any) {
      ws.send(client, { type: 'error', payload: { message: `LP 查询失败: ${err.message}` } })
    }
    return
  }

  // ── Venus Account Health ─────────────────────────────────
  // Given a list of addresses, fetch their Venus liquidity / shortfall.
  // Health Factor approximation: liquidity > 0 ⇒ healthy; shortfall > 0 ⇒
  // liquidatable. We surface both raw values + a derived ratio.
  if (type === 'query_venus_health') {
    try {
      cfg = loadConfig()
      const { publicClient } = buildScanClient()
      const { parseAbi, formatUnits } = await import('viem')
      const COMPTROLLER = '0xfD36E2c2a6789Db23113685031d7F16329158384' as `0x${string}`
      const COMPTROLLER_ABI = parseAbi([
        'function getAccountLiquidity(address account) view returns (uint256 error, uint256 liquidity, uint256 shortfall)',
      ])
      const addrs: string[] = Array.isArray(payload?.addresses) ? payload.addresses : []
      if (addrs.length === 0 || addrs.length > 50) {
        ws.send(client, { type: 'error', payload: { message: 'Venus 查询: addresses 数量需在 1-50 之间' } })
        return
      }

      const results = await Promise.all(addrs.map(async (a) => {
        try {
          const r = await publicClient.readContract({
            address: COMPTROLLER, abi: COMPTROLLER_ABI, functionName: 'getAccountLiquidity',
            args: [a as `0x${string}`],
          }) as readonly [bigint, bigint, bigint]
          const [errCode, liquidity, shortfall] = r
          if (errCode !== 0n) return { address: a, error: `comptroller error ${errCode}` }
          // Both values are in USD-scaled 1e18 (Venus follows Compound units).
          return {
            address:    a,
            liquidity:  Number(formatUnits(liquidity,  18)),
            shortfall:  Number(formatUnits(shortfall,  18)),
            healthy:    shortfall === 0n,
          }
        } catch (e: any) {
          return { address: a, error: e?.shortMessage ?? e?.message ?? 'rpc error' }
        }
      }))

      ws.send(client, { type: 'venus_health', payload: { accounts: results, ts: Date.now() } })
    } catch (err: any) {
      ws.send(client, { type: 'error', payload: { message: `Venus 查询失败: ${err.message}` } })
    }
    return
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
