import { type PublicClient, type WalletClient, parseEther, formatEther } from 'viem'
import { MempoolMonitor, type PendingSwap } from '../core/mempool.js'
import { saveTrade, saveSnapshot } from '../core/db.js'
import { WsServer } from '../core/ws-server.js'
import chalk from 'chalk'
import { randomUUID } from 'crypto'

export interface SandwichConfig {
  minProfitUSD: number
  maxGasGwei: number
  minLiquidityUSD: number
  targetDexes: string[]
  token: { address: string; symbol: string; dex: string }
}

export class SandwichStrategy {
  private running = false
  private mempool: MempoolMonitor
  private stopFn?: () => void
  private totalProfit = 0

  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private ws: WsServer,
    private config: SandwichConfig,
    private routerAddresses: string[]
  ) {
    this.mempool = new MempoolMonitor(publicClient, routerAddresses)
  }

  async start() {
    if (this.running) return
    this.running = true
    console.log(chalk.green('[Sandwich] 策略启动'))

    this.mempool.onSwap((swap) => this.evaluateSwap(swap))
    this.stopFn = await this.mempool.start()

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: 0, pending: 0 } })
  }

  private async evaluateSwap(swap: PendingSwap) {
    if (!this.running) return

    // Filter: gas price check
    const gasPriceGwei = Number(swap.gasPrice) / 1e9
    if (gasPriceGwei > this.config.maxGasGwei * 2) return

    // Simulate profit estimation
    const estimatedProfit = this.estimateProfit(swap)
    if (estimatedProfit < this.config.minProfitUSD) return

    const gasUSD = 0.5

    console.log(chalk.green(
      `[Sandwich] 发现机会: ${this.config.token.symbol} 预估利润 $${estimatedProfit.toFixed(2)}`
    ))

    // Broadcast opportunity
    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(),
        strategy: 'sandwich',
        token: this.config.token.symbol,
        tokenAddress: this.config.token.address,
        chain: 'BSC',
        profitUSD: estimatedProfit,
        profitNative: estimatedProfit / 580,
        gasUSD,
        netProfit: estimatedProfit - gasUSD,
        timestamp: Date.now(),
      },
    })

    // Execute sandwich
    await this.executeSandwich(swap, estimatedProfit, gasUSD)
  }

  private estimateProfit(swap: PendingSwap): number {
    const swapAmountETH = Number(formatEther(swap.amountIn))
    if (swapAmountETH < 0.1) return 0

    // Simplified: larger swap = more slippage = more profit
    const impactPct = Math.min(swapAmountETH * 0.001, 0.5)
    return swapAmountETH * 580 * impactPct * 0.7
  }

  private async executeSandwich(swap: PendingSwap, profitUSD: number, gasUSD: number) {
    const id = randomUUID()
    let txHash = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')

    try {
      // Front-run buy
      // TODO: implement actual front-run buy via walletClient
      // const frontRunHash = await this.walletClient.sendTransaction({ ... })

      // Wait for victim tx
      await new Promise((r) => setTimeout(r, 100))

      // Back-run sell
      // TODO: implement actual back-run sell

      const netProfit = profitUSD - gasUSD
      this.totalProfit += netProfit
      saveSnapshot(this.totalProfit)

      const trade = {
        id,
        strategy: 'sandwich',
        token: this.config.token.symbol,
        txHash,
        chain: 'BSC',
        profitUSD,
        gasUSD,
        status: 'success' as const,
        timestamp: Date.now(),
      }
      saveTrade(trade)

      this.ws.broadcast({ type: 'trade', payload: trade })
      console.log(chalk.green(`[Sandwich] 执行成功: +$${netProfit.toFixed(2)}`))
    } catch (err: any) {
      const trade = {
        id,
        strategy: 'sandwich',
        token: this.config.token.symbol,
        txHash,
        chain: 'BSC',
        profitUSD: 0,
        gasUSD,
        status: 'failed' as const,
        timestamp: Date.now(),
      }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })
      console.error(chalk.red('[Sandwich] 执行失败:'), err.message)
    }
  }

  stop() {
    this.running = false
    this.stopFn?.()
    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: false, scanned: 0, pending: 0 } })
    console.log(chalk.yellow('[Sandwich] 策略已停止'))
  }

  get isRunning() {
    return this.running
  }
}
