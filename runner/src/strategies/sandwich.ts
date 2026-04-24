import { type PublicClient, type WalletClient, parseUnits, formatEther, encodeFunctionData } from 'viem'
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

const ERC20_APPROVE_ABI = [
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

export class SandwichStrategy {
  private running = false
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
    console.log(chalk.green('[Sandwich] 策略启动'))

    this.mempool.onSwap((swap) => this.evaluateSwap(swap))
    this.stopFn = await this.mempool.start()

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: 0, pending: 0 } })
  }

  private async evaluateSwap(swap: PendingSwap) {
    if (!this.running) return
    this.scanned++

    // Filter: gas price check
    const gasPriceGwei = Number(swap.gasPrice) / 1e9
    if (gasPriceGwei > this.config.maxGasGwei * 2) return

    // Estimate profit
    const estimatedProfit = this.estimateProfit(swap)
    if (estimatedProfit < this.config.minProfitUSD) return

    const bnbPrice = 580
    const gasUSD = gasPriceGwei * 0.0003 * bnbPrice // rough gas estimate

    console.log(chalk.cyan(
      `[Sandwich] 发现机会: ${this.config.token.symbol} 预估利润 $${estimatedProfit.toFixed(2)} | Victim gas: ${gasPriceGwei.toFixed(1)} Gwei`
    ))

    // Broadcast opportunity (real mempool detection)
    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(),
        strategy: 'sandwich',
        token: this.config.token.symbol,
        tokenAddress: this.config.token.address,
        chain: 'BSC',
        profitUSD: estimatedProfit,
        profitNative: estimatedProfit / bnbPrice,
        gasUSD,
        netProfit: estimatedProfit - gasUSD,
        timestamp: Date.now(),
      },
    })

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 1 } })

    // Execute on-chain sandwich
    await this.executeSandwich(swap, estimatedProfit, gasUSD)

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 0 } })
  }

  private estimateProfit(swap: PendingSwap): number {
    const swapAmountETH = Number(formatEther(swap.amountIn))
    if (swapAmountETH < 0.1) return 0
    const impactPct = Math.min(swapAmountETH * 0.001, 0.5)
    return swapAmountETH * 580 * impactPct * 0.7
  }

  private async executeSandwich(swap: PendingSwap, estimatedProfitUSD: number, gasUSD: number) {
    const id = randomUUID()
    const tokenAddress = this.config.token.address as `0x${string}`
    const routerAddress = this.routerAddresses[0] as `0x${string}`
    const account = this.walletClient.account!
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60)
    const bnbPrice = 580

    // Amount to spend on front-run buy (from config, default $200)
    const buyAmountUSD = this.config.executionAmountUSD ?? 200
    const buyAmountBNB = parseUnits((buyAmountUSD / bnbPrice).toFixed(6), 18)

    // Priority gas = victim gas * multiplier
    const victimGasGwei = Number(swap.gasPrice) / 1e9
    const priorityGasWei = parseUnits(
      (victimGasGwei * (this.config.priorityGasMultiplier ?? 2)).toFixed(9),
      9
    )

    // Track whether front-run tx was actually submitted (to decide if we log a failed trade)
    let frontRunSubmitted = false

    try {
      // ── Step 1: Front-run buy (BNB → Token) ─────────────────────────
      console.log(chalk.dim(`[Sandwich] ① 前跑买入: $${buyAmountUSD} BNB → ${this.config.token.symbol} | gas ${(victimGasGwei * (this.config.priorityGasMultiplier ?? 2)).toFixed(2)} Gwei`))
      const frontRunHash = await this.walletClient.writeContract({
        address: routerAddress,
        abi: ROUTER_ABI,
        functionName: 'swapExactETHForTokens',
        args: [
          0n,
          [WBNB, tokenAddress],
          account.address,
          deadline,
        ],
        value: buyAmountBNB,
        gasPrice: priorityGasWei,
        account,        // ← full Account object, not just address string
        chain: null,
      })
      frontRunSubmitted = true
      console.log(chalk.dim(`[Sandwich] ① 前跑已提交: ${frontRunHash}`))

      // ── Step 2: Wait for front-run confirmation ──────────────────────
      const frontReceipt = await this.publicClient.waitForTransactionReceipt({
        hash: frontRunHash,
        timeout: 30_000,
      })
      if (frontReceipt.status !== 'success') throw new Error('前跑买入被链上回滚')

      // ── Step 3: Wait briefly for victim tx to land ──────────────────
      await new Promise((r) => setTimeout(r, 200))

      // ── Step 4: Check token balance we received ──────────────────────
      const tokenBalance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_APPROVE_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      })
      if (tokenBalance === 0n) throw new Error('前跑后未收到代币，受害者交易可能未上链')

      // ── Step 5: Approve router to spend tokens ───────────────────────
      const approveHash = await this.walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [routerAddress, tokenBalance],
        gasPrice: priorityGasWei,
        account,        // ← full Account object
        chain: null,
      })
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 })

      // ── Step 6: Back-run sell (Token → BNB) ─────────────────────────
      console.log(chalk.dim(`[Sandwich] ② 后跑卖出: ${this.config.token.symbol} → BNB`))
      const backRunHash = await this.walletClient.writeContract({
        address: routerAddress,
        abi: ROUTER_ABI,
        functionName: 'swapExactTokensForETH',
        args: [
          tokenBalance,
          0n,
          [tokenAddress, WBNB],
          account.address,
          deadline,
        ],
        gasPrice: priorityGasWei,
        account,        // ← full Account object
        chain: null,
      })

      const backReceipt = await this.publicClient.waitForTransactionReceipt({
        hash: backRunHash,
        timeout: 30_000,
      })
      if (backReceipt.status !== 'success') throw new Error('后跑卖出被链上回滚')

      // ── Step 7: Record real trade ────────────────────────────────────
      const trade = {
        id,
        strategy: 'sandwich',
        token: this.config.token.symbol,
        txHash: backRunHash,
        chain: 'BSC',
        profitUSD: estimatedProfitUSD,
        gasUSD,
        status: 'success' as const,
        timestamp: Date.now(),
      }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })
      console.log(chalk.green(`[Sandwich] ✓ 夹子完成! 预估利润 $${estimatedProfitUSD.toFixed(2)} | ${backRunHash}`))

    } catch (err: any) {
      // Extract a clean error message — strip the giant viem hex dump
      const raw: string = err.shortMessage ?? err.message ?? String(err)
      const clean = raw
        .split('\n')[0]                         // first line only
        .replace(/\s*URL:.*/, '')               // drop URL: https://...
        .replace(/\s*Request body:.*/, '')      // drop Request body: {...}
        .replace(/\s*Version:.*/, '')           // drop Version: viem@x.x.x
        .trim()
        .slice(0, 120)                          // max 120 chars

      console.error(chalk.red(`[Sandwich] ✗ 执行失败: ${clean}`))

      // Only record a failed trade if the front-run was actually submitted on-chain
      if (frontRunSubmitted) {
        const trade = {
          id,
          strategy: 'sandwich',
          token: this.config.token.symbol,
          txHash: '',
          chain: 'BSC',
          profitUSD: 0,
          gasUSD,
          status: 'failed' as const,
          timestamp: Date.now(),
        }
        saveTrade(trade)
        this.ws.broadcast({ type: 'trade', payload: trade })
      }
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
