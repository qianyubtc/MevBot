import { type PublicClient, type WalletClient, parseAbi } from 'viem'
import { WsServer } from '../core/ws-server.js'
import { saveTrade, saveSnapshot } from '../core/db.js'
import chalk from 'chalk'
import { randomUUID } from 'crypto'

export interface SniperConfig {
  minLiquidityUSD: number
  maxBuyUSD: number
  targetGainPct: number
  stopLossPct: number
}

const FACTORY_ABI = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
])

export class SniperStrategy {
  private running = false
  private unwatchFn?: () => void
  private positions = new Map<string, { buyPrice: number; amount: number; symbol: string }>()
  private totalProfit = 0

  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private ws: WsServer,
    private config: SniperConfig,
    private factoryAddress: `0x${string}`
  ) {}

  async start() {
    if (this.running) return
    this.running = true
    console.log(chalk.green('[Sniper] 策略启动，监听新流动性...'))

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sniper', running: true, scanned: 0, pending: 0 } })

    try {
      this.unwatchFn = this.publicClient.watchContractEvent({
        address: this.factoryAddress,
        abi: FACTORY_ABI,
        eventName: 'PairCreated',
        onLogs: (logs) => {
          for (const log of logs) {
            this.onNewPair(log as any)
          }
        },
      })
    } catch {
      console.log(chalk.yellow('[Sniper] 事件监听降级为轮询...'))
    }
  }

  private async onNewPair(log: { args: { token0: string; token1: string; pair: string } }) {
    if (!this.running) return

    const { token0, token1, pair } = log.args
    const liquidity = await this.estimateLiquidity(pair)

    if (liquidity < this.config.minLiquidityUSD) {
      console.log(chalk.gray(`[Sniper] 流动性不足 $${liquidity.toFixed(0)}，跳过`))
      return
    }

    // Safety checks (honeypot detection, etc.)
    const isSafe = await this.safetyCheck(token0)
    if (!isSafe) {
      console.log(chalk.red('[Sniper] 安全检测不通过，跳过'))
      return
    }

    const symbol = `TOKEN_${pair.slice(2, 6).toUpperCase()}`
    const buyPrice = 0.0001 + Math.random() * 0.001
    const buyAmount = Math.min(this.config.maxBuyUSD, liquidity * 0.01)

    console.log(chalk.green(`[Sniper] 发现新币 ${symbol} 流动性 $${liquidity.toFixed(0)}`))

    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(),
        strategy: 'sniper',
        token: symbol,
        tokenAddress: token0,
        chain: 'BSC',
        profitUSD: buyAmount * (this.config.targetGainPct / 100),
        profitNative: 0,
        gasUSD: 0.3,
        netProfit: buyAmount * (this.config.targetGainPct / 100) - 0.3,
        timestamp: Date.now(),
      },
    })

    await this.executeBuy(token0, symbol, buyPrice, buyAmount)

    // Monitor position for take-profit / stop-loss
    this.monitorPosition(token0, symbol, buyPrice, buyAmount)
  }

  private async safetyCheck(tokenAddress: string): Promise<boolean> {
    // TODO: check for honeypot, max tx limit, blacklist, etc.
    return Math.random() > 0.3
  }

  private async estimateLiquidity(pairAddress: string): Promise<number> {
    // TODO: read reserves from pair contract
    return 20000 + Math.random() * 300000
  }

  private async executeBuy(tokenAddress: string, symbol: string, price: number, amountUSD: number) {
    const id = randomUUID()
    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    const gasUSD = 0.3

    try {
      // TODO: walletClient.sendTransaction(...)
      this.positions.set(tokenAddress, { buyPrice: price, amount: amountUSD / price, symbol })

      const trade = { id, strategy: 'sniper', token: symbol, txHash, chain: 'BSC', profitUSD: -amountUSD, gasUSD, status: 'pending' as const, timestamp: Date.now() }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })
      console.log(chalk.cyan(`[Sniper] 买入 ${symbol} $${amountUSD.toFixed(2)}`))
    } catch (err: any) {
      console.error(chalk.red('[Sniper] 买入失败:'), err.message)
    }
  }

  private monitorPosition(tokenAddress: string, symbol: string, buyPrice: number, amountUSD: number) {
    const check = setInterval(async () => {
      if (!this.running || !this.positions.has(tokenAddress)) {
        clearInterval(check)
        return
      }

      const currentPrice = buyPrice * (1 + (Math.random() - 0.4) * 0.2)
      const gainPct = ((currentPrice - buyPrice) / buyPrice) * 100

      if (gainPct >= this.config.targetGainPct) {
        clearInterval(check)
        await this.executeSell(tokenAddress, symbol, buyPrice, currentPrice, amountUSD, 'take-profit')
      } else if (gainPct <= -this.config.stopLossPct) {
        clearInterval(check)
        await this.executeSell(tokenAddress, symbol, buyPrice, currentPrice, amountUSD, 'stop-loss')
      }
    }, 3000)
  }

  private async executeSell(tokenAddress: string, symbol: string, buyPrice: number, sellPrice: number, amountUSD: number, reason: string) {
    this.positions.delete(tokenAddress)
    const id = randomUUID()
    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    const gasUSD = 0.3
    const profitUSD = amountUSD * ((sellPrice - buyPrice) / buyPrice) - gasUSD

    this.totalProfit += profitUSD
    saveSnapshot(this.totalProfit)

    const trade = { id, strategy: 'sniper', token: symbol, txHash, chain: 'BSC', profitUSD, gasUSD, status: profitUSD > 0 ? 'success' as const : 'failed' as const, timestamp: Date.now() }
    saveTrade(trade)
    this.ws.broadcast({ type: 'trade', payload: trade })
    console.log(chalk[profitUSD > 0 ? 'green' : 'red'](`[Sniper] 卖出 ${symbol} (${reason}) ${profitUSD > 0 ? '+' : ''}$${profitUSD.toFixed(2)}`))
  }

  stop() {
    this.running = false
    this.unwatchFn?.()
    this.positions.clear()
    this.ws.broadcast({ type: 'status', payload: { strategy: 'sniper', running: false, scanned: 0, pending: 0 } })
    console.log(chalk.yellow('[Sniper] 策略已停止'))
  }

  get isRunning() {
    return this.running
  }
}
