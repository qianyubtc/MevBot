import { type PublicClient, type WalletClient, parseUnits, formatEther, formatUnits } from 'viem'
import { MempoolMonitor, type PendingSwap } from '../core/mempool.js'
import { saveTrade } from '../core/db.js'
import { WsServer } from '../core/ws-server.js'
import chalk from 'chalk'
import { randomUUID } from 'crypto'

const ROUTER_ABI = [
  {
    name: 'swapExactETHForTokens',
    type: 'function',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable',
  },
  {
    name: 'swapExactTokensForETH',
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
] as const

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as `0x${string}`
const BNB_PRICE = 580 // fallback; ideally fetched live

export interface SandwichConfig {
  minProfitUSD: number
  maxGasGwei: number
  minLiquidityUSD: number
  executionAmountUSD: number
  priorityGasMultiplier: number
  slippageTolerance: number
  targetDexes: string[]
  token: { address: string; symbol: string; dex: string }
}

// Parse a clean one-liner from a viem/RPC error
function cleanError(err: any): string {
  // viem errors expose shortMessage (e.g. "The contract function reverted")
  const candidates = [
    err?.shortMessage,
    err?.cause?.shortMessage,
    err?.cause?.message,
    err?.message,
  ]
  for (const c of candidates) {
    if (!c) continue
    const line = String(c)
      .split('\n')[0]
      .replace(/\s*URL:.*/, '')
      .replace(/\s*Request body:.*/, '')
      .replace(/\s*Version:.*/, '')
      .replace(/\s*Details:.*/, '')
      .trim()
    if (line.length > 0 && line.length < 200) return line
  }
  return '未知错误'
}

export class SandwichStrategy {
  private running = false
  private executing = false   // prevent overlapping sandwiches
  private mempool: MempoolMonitor
  private stopFn?: () => void
  private scanned = 0

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
    console.log(chalk.green(`[Sandwich] 策略启动 → 目标: ${this.config.token.symbol}`))
    this.mempool.onSwap((swap) => this.evaluateSwap(swap))
    this.stopFn = await this.mempool.start()
    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: 0, pending: 0 } })
  }

  stop() {
    this.running = false
    this.stopFn?.()
    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: false, scanned: 0, pending: 0 } })
    console.log(chalk.yellow('[Sandwich] 策略已停止'))
  }

  private async evaluateSwap(swap: PendingSwap) {
    if (!this.running) return
    if (this.executing) return   // skip if already in a sandwich
    this.scanned++

    const gasPriceGwei = Number(swap.gasPrice) / 1e9
    if (gasPriceGwei > this.config.maxGasGwei * 2) return

    const estimatedProfit = this.estimateProfit(swap)
    if (estimatedProfit < this.config.minProfitUSD) return

    const gasUSD = gasPriceGwei * 0.0006 * BNB_PRICE // ~600k gas for 3 txs

    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(),
        strategy: 'sandwich',
        token: this.config.token.symbol,
        tokenAddress: this.config.token.address,
        chain: 'BSC',
        profitUSD: estimatedProfit,
        profitNative: estimatedProfit / BNB_PRICE,
        gasUSD,
        netProfit: estimatedProfit - gasUSD,
        timestamp: Date.now(),
      },
    })

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 1 } })
    this.executing = true
    await this.executeSandwich(swap, gasUSD)
    this.executing = false
    if (this.running) {
      this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 0 } })
    }
  }

  private estimateProfit(swap: PendingSwap): number {
    const swapAmountETH = Number(formatEther(swap.amountIn))
    if (swapAmountETH < 0.05) return 0
    const impactPct = Math.min(swapAmountETH * 0.001, 0.5)
    return swapAmountETH * BNB_PRICE * impactPct * 0.7
  }

  private async executeSandwich(swap: PendingSwap, estimatedGasUSD: number) {
    if (!this.running) return   // guard: stop() may have been called before we got here

    const id = randomUUID()
    const tokenAddress = this.config.token.address as `0x${string}`
    const routerAddress = this.routerAddresses[0] as `0x${string}`
    const account = this.walletClient.account!
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60)

    const buyAmountBNB = parseUnits((((this.config.executionAmountUSD ?? 5) / BNB_PRICE)).toFixed(6), 18)
    const victimGasGwei = Number(swap.gasPrice) / 1e9
    const priorityGasWei = parseUnits(
      (victimGasGwei * (this.config.priorityGasMultiplier ?? 2)).toFixed(9), 9
    )

    let frontRunSubmitted = false

    try {
      // ── Snapshot balance before sandwich ────────────────────────────
      const balanceBefore = await this.publicClient.getBalance({ address: account.address })
      if (!this.running) return

      // ── Step 1: Front-run buy ────────────────────────────────────────
      console.log(chalk.dim(`[Sandwich] ① 前跑买入 $${this.config.executionAmountUSD} BNB → ${this.config.token.symbol} | gas ${(victimGasGwei * (this.config.priorityGasMultiplier ?? 2)).toFixed(2)} Gwei`))
      const frontRunHash = await this.walletClient.writeContract({
        address: routerAddress,
        abi: ROUTER_ABI,
        functionName: 'swapExactETHForTokens',
        args: [0n, [WBNB, tokenAddress], account.address, deadline],
        value: buyAmountBNB,
        gasPrice: priorityGasWei,
        account,
        chain: null,
      })
      frontRunSubmitted = true
      console.log(chalk.dim(`[Sandwich] ① 前跑已提交: ${frontRunHash}`))

      const frontReceipt = await this.publicClient.waitForTransactionReceipt({ hash: frontRunHash, timeout: 30_000 })
      if (frontReceipt.status !== 'success') throw new Error('前跑买入交易被链上回滚')
      if (!this.running) return // stop() called while waiting

      // ── Step 2: Wait for victim ──────────────────────────────────────
      await new Promise((r) => setTimeout(r, 200))
      if (!this.running) return

      // ── Step 3: Check received tokens ───────────────────────────────
      const tokenBalance = await this.publicClient.readContract({
        address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
      })
      if (tokenBalance === 0n) throw new Error('前跑后未收到代币（受害者交易可能未上链）')

      // ── Step 4: Approve ──────────────────────────────────────────────
      const approveHash = await this.walletClient.writeContract({
        address: tokenAddress, abi: ERC20_ABI, functionName: 'approve',
        args: [routerAddress, tokenBalance],
        gasPrice: priorityGasWei, account, chain: null,
      })
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 })
      if (!this.running) return

      // ── Step 5: Back-run sell ────────────────────────────────────────
      console.log(chalk.dim(`[Sandwich] ② 后跑卖出: ${this.config.token.symbol} → BNB`))
      const backRunHash = await this.walletClient.writeContract({
        address: routerAddress, abi: ROUTER_ABI, functionName: 'swapExactTokensForETH',
        args: [tokenBalance, 0n, [tokenAddress, WBNB], account.address, deadline],
        gasPrice: priorityGasWei, account, chain: null,
      })
      const backReceipt = await this.publicClient.waitForTransactionReceipt({ hash: backRunHash, timeout: 30_000 })
      if (backReceipt.status !== 'success') throw new Error('后跑卖出交易被链上回滚')

      // ── Step 6: Calculate ACTUAL profit from balance diff ───────────
      const balanceAfter = await this.publicClient.getBalance({ address: account.address })
      const diffBNB = Number(formatUnits(balanceAfter - balanceBefore, 18))
      const actualProfitUSD = diffBNB * BNB_PRICE   // negative = loss
      const actualGasUSD = Math.abs(Math.min(diffBNB, 0)) * BNB_PRICE + estimatedGasUSD

      const trade = {
        id,
        strategy: 'sandwich',
        token: this.config.token.symbol,
        txHash: backRunHash,
        chain: 'BSC',
        profitUSD: actualProfitUSD,   // real number, can be negative
        gasUSD: actualGasUSD,
        status: 'success' as const,
        timestamp: Date.now(),
      }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })

      if (actualProfitUSD >= 0) {
        console.log(chalk.green(`[Sandwich] ✓ 夹子完成! 实际利润 $${actualProfitUSD.toFixed(2)} | ${backRunHash}`))
      } else {
        console.log(chalk.yellow(`[Sandwich] ✓ 夹子完成（亏损 $${Math.abs(actualProfitUSD).toFixed(2)}）| ${backRunHash}`))
      }

    } catch (err: any) {
      const msg = cleanError(err)
      console.error(chalk.red(`[Sandwich] ✗ 执行失败: ${msg}`))

      if (frontRunSubmitted) {
        const trade = {
          id, strategy: 'sandwich', token: this.config.token.symbol,
          txHash: '', chain: 'BSC', profitUSD: 0, gasUSD: estimatedGasUSD,
          status: 'failed' as const, timestamp: Date.now(),
        }
        saveTrade(trade)
        this.ws.broadcast({ type: 'trade', payload: trade })
      }
    }
  }

  get isRunning() { return this.running }
}
