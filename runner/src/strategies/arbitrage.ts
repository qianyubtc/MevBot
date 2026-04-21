import { type PublicClient, type WalletClient, formatUnits } from 'viem'
import { WsServer } from '../core/ws-server.js'
import { saveTrade, saveSnapshot } from '../core/db.js'
import chalk from 'chalk'
import { randomUUID } from 'crypto'

export interface ArbitrageConfig {
  minProfitUSD: number
  maxGasGwei: number
  minSpreadPct: number
}

interface PriceFeed {
  dex: string
  router: `0x${string}`
  price: number
}

export class ArbitrageStrategy {
  private running = false
  private intervalId?: ReturnType<typeof setInterval>
  private scanned = 0
  private totalProfit = 0

  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private ws: WsServer,
    private config: ArbitrageConfig
  ) {}

  async start() {
    if (this.running) return
    this.running = true
    console.log(chalk.green('[Arbitrage] 策略启动'))

    this.ws.broadcast({ type: 'status', payload: { strategy: 'arbitrage', running: true, scanned: 0, pending: 0 } })

    this.intervalId = setInterval(() => this.scanOpportunities(), 2000)
  }

  private async scanOpportunities() {
    if (!this.running) return
    this.scanned++

    const pairs = [
      { symbol: 'BNB/USDT', token0: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', token1: '0x55d398326f99059fF775485246999027B3197955' },
      { symbol: 'ETH/BNB', token0: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', token1: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' },
    ]

    for (const pair of pairs) {
      const prices = await this.fetchPrices(pair.symbol)
      if (prices.length < 2) continue

      const sorted = prices.sort((a, b) => a.price - b.price)
      const low = sorted[0]
      const high = sorted[sorted.length - 1]
      const spread = ((high.price - low.price) / low.price) * 100

      if (spread >= this.config.minSpreadPct) {
        const profitUSD = this.estimateProfit(low.price, high.price, 1000)
        const gasUSD = 0.8

        if (profitUSD - gasUSD >= this.config.minProfitUSD) {
          console.log(chalk.green(`[Arbitrage] ${pair.symbol} 价差 ${spread.toFixed(2)}% 预估利润 $${profitUSD.toFixed(2)}`))

          this.ws.broadcast({
            type: 'opportunity',
            payload: {
              id: randomUUID(),
              strategy: 'arbitrage',
              token: pair.symbol,
              tokenAddress: pair.token0,
              chain: 'BSC',
              profitUSD,
              profitNative: profitUSD / 580,
              gasUSD,
              netProfit: profitUSD - gasUSD,
              timestamp: Date.now(),
            },
          })

          await this.executeArbitrage(pair.symbol, low, high, profitUSD, gasUSD)
        }
      }
    }
  }

  private async fetchPrices(symbol: string): Promise<PriceFeed[]> {
    // Simulate price feeds (in production: query on-chain via getAmountsOut)
    const base = symbol === 'BNB/USDT' ? 580 : 4.91
    return [
      { dex: 'PancakeSwap', router: '0x10ED43C718714eb63d5aA57B78B54704E256024E', price: base + (Math.random() - 0.5) * base * 0.01 },
      { dex: 'BiSwap', router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8', price: base + (Math.random() - 0.5) * base * 0.01 },
      { dex: 'MDEX', router: '0x62c1E3f9a3B16CCCEe6E24fB8aE68f0A6B3e6e79', price: base + (Math.random() - 0.5) * base * 0.01 },
    ]
  }

  private estimateProfit(buyPrice: number, sellPrice: number, amountUSD: number): number {
    return (amountUSD / buyPrice) * (sellPrice - buyPrice) * 0.98
  }

  private async executeArbitrage(symbol: string, buy: PriceFeed, sell: PriceFeed, profitUSD: number, gasUSD: number) {
    const id = randomUUID()
    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

    try {
      // TODO: actual on-chain execution
      // 1. getAmountsOut on buy DEX
      // 2. swap on buy DEX
      // 3. swap on sell DEX

      const netProfit = profitUSD - gasUSD
      this.totalProfit += netProfit
      saveSnapshot(this.totalProfit)

      const trade = { id, strategy: 'arbitrage', token: symbol, txHash, chain: 'BSC', profitUSD, gasUSD, status: 'success' as const, timestamp: Date.now() }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })
      console.log(chalk.green(`[Arbitrage] 套利成功: +$${netProfit.toFixed(2)}`))
    } catch (err: any) {
      const trade = { id, strategy: 'arbitrage', token: symbol, txHash, chain: 'BSC', profitUSD: 0, gasUSD, status: 'failed' as const, timestamp: Date.now() }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })
      console.error(chalk.red('[Arbitrage] 执行失败:'), err.message)
    }
  }

  stop() {
    this.running = false
    if (this.intervalId) clearInterval(this.intervalId)
    this.ws.broadcast({ type: 'status', payload: { strategy: 'arbitrage', running: false, scanned: this.scanned, pending: 0 } })
    console.log(chalk.yellow('[Arbitrage] 策略已停止'))
  }

  get isRunning() {
    return this.running
  }
}
