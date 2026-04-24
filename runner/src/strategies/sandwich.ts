import { type PublicClient, type WalletClient, parseUnits, formatEther, formatUnits, parseAbi } from 'viem'
import { MempoolMonitor, type PendingSwap } from '../core/mempool.js'
import { saveTrade } from '../core/db.js'
import { WsServer } from '../core/ws-server.js'
import chalk from 'chalk'
import { randomUUID } from 'crypto'

const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
])

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as `0x${string}`
const FEE_NUMERATOR = 9975n   // 0.25% fee → multiply by 9975/10000
const FEE_DENOMINATOR = 10000n

export interface SandwichConfig {
  minProfitUSD: number
  maxGasGwei: number
  minLiquidityUSD: number
  executionAmountUSD: number
  priorityGasMultiplier: number
  slippageTolerance: number
  targetDexes: string[]
  token: { address: string; symbol: string; dex: string; pairAddress?: string }
}

function cleanError(err: any): string {
  const candidates = [err?.shortMessage, err?.cause?.shortMessage, err?.cause?.message, err?.message]
  for (const c of candidates) {
    if (!c) continue
    const line = String(c).split('\n')[0]
      .replace(/\s*URL:.*/, '').replace(/\s*Request body:.*/, '')
      .replace(/\s*Version:.*/, '').replace(/\s*Details:.*/, '').trim()
    if (line.length > 0 && line.length < 200) return line
  }
  return '未知错误'
}

// AMM getAmountOut with 0.25% fee (PancakeSwap V2)
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * FEE_NUMERATOR
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee)
}

export class SandwichStrategy {
  private running = false
  private executing = false
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
    if (!this.running || this.executing) return
    this.scanned++

    // ── 1. Victim swap must be large enough to move price ──────────────
    const victimBNB = Number(formatEther(swap.amountIn))
    const MIN_VICTIM_BNB = 2.0   // victim must spend ≥ 2 BNB ($1160+) to create enough impact
    if (victimBNB < MIN_VICTIM_BNB) return

    // ── 2. Gas price filter ────────────────────────────────────────────
    const gasPriceGwei = Number(swap.gasPrice) / 1e9
    if (gasPriceGwei > this.config.maxGasGwei) return

    // ── 3. Estimate gas cost (3 txs: frontrun + approve + backrun) ─────
    const priorityGwei = gasPriceGwei * (this.config.priorityGasMultiplier ?? 2)
    const gasPerTx = 250_000n // conservative estimate per tx
    const totalGasWei = parseUnits(priorityGwei.toFixed(9), 9) * gasPerTx * 3n
    const gasCostBNB = Number(formatUnits(totalGasWei, 18))
    const gasCostUSD = gasCostBNB * 580

    // ── 4. Fetch pool reserves for precise profit calculation ──────────
    let profitUSD = 0
    let frontAmountBNB: bigint
    let minFrontTokenOut: bigint

    try {
      const pairAddress = this.config.token.pairAddress as `0x${string}` | undefined
      if (!pairAddress || pairAddress === '0x0000000000000000000000000000000000000000') {
        // No pair address — fall back to rough estimate
        const impactPct = Math.min(victimBNB / 100, 0.05) // rough: victim/pool ~1-5%
        const execBNB = (this.config.executionAmountUSD ?? 50) / 580
        profitUSD = execBNB * 580 * impactPct * 0.6
        frontAmountBNB = parseUnits(execBNB.toFixed(6), 18)
        minFrontTokenOut = 0n
      } else {
        // ── AMM math: calculate real sandwich profit ──────────────────
        const [reserves, token0] = await Promise.all([
          this.publicClient.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves' }),
          this.publicClient.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token0' }),
        ])

        const isWbnbToken0 = token0.toLowerCase() === WBNB.toLowerCase()
        const reserveBNB = isWbnbToken0 ? reserves[0] : reserves[1]
        const reserveToken = isWbnbToken0 ? reserves[1] : reserves[0]

        // Execution amount: up to config max, but capped at 30% of victim amount
        const maxExecBNB = (this.config.executionAmountUSD ?? 50) / 580
        const execBNB = Math.min(maxExecBNB, victimBNB * 0.3)
        frontAmountBNB = parseUnits(execBNB.toFixed(6), 18)
        const victimAmountWei = swap.amountIn

        // Simulate AMM state changes
        // Step A: we buy (reserveBNB, reserveToken) → spend frontAmountBNB
        const frontTokenOut = getAmountOut(frontAmountBNB, reserveBNB, reserveToken)
        const rBNB_afterFront = reserveBNB + frontAmountBNB
        const rTok_afterFront = reserveToken - frontTokenOut

        // Step B: victim buys at new price
        const victimTokenOut = getAmountOut(victimAmountWei, rBNB_afterFront, rTok_afterFront)
        const rBNB_afterVictim = rBNB_afterFront + victimAmountWei
        const rTok_afterVictim = rTok_afterFront - victimTokenOut

        // Step C: we sell our tokens
        const backBNBOut = getAmountOut(frontTokenOut, rTok_afterVictim, rBNB_afterVictim)

        const grossProfitBNB = Number(formatUnits(backBNBOut - frontAmountBNB, 18))
        const grossProfitUSD = grossProfitBNB * 580
        profitUSD = grossProfitUSD - gasCostUSD

        // Set min output with slippage tolerance for frontrun protection
        const slippage = (this.config.slippageTolerance ?? 1) / 100
        minFrontTokenOut = frontTokenOut * BigInt(Math.floor((1 - slippage) * 10000)) / 10000n

        console.log(chalk.dim(
          `[Sandwich] 评估 | 受害者 ${victimBNB.toFixed(2)} BNB | ` +
          `毛利 $${grossProfitUSD.toFixed(3)} | gas $${gasCostUSD.toFixed(3)} | 净利 $${profitUSD.toFixed(3)}`
        ))
      }
    } catch (e: any) {
      console.warn(chalk.dim(`[Sandwich] 储备查询失败: ${cleanError(e)}`))
      return
    }

    // ── 5. Skip if not profitable enough ──────────────────────────────
    if (profitUSD < this.config.minProfitUSD) return

    console.log(chalk.cyan(
      `[Sandwich] ✓ 发现机会: ${this.config.token.symbol} 预计净利 $${profitUSD.toFixed(2)} | 受害者 ${victimBNB.toFixed(2)} BNB`
    ))

    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(), strategy: 'sandwich',
        token: this.config.token.symbol, tokenAddress: this.config.token.address,
        chain: 'BSC', profitUSD, profitNative: profitUSD / 580,
        gasUSD: gasCostUSD, netProfit: profitUSD,
        timestamp: Date.now(),
      },
    })

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 1 } })
    this.executing = true
    await this.executeSandwich(swap, frontAmountBNB!, minFrontTokenOut!, gasCostUSD, priorityGwei)
    this.executing = false
    if (this.running) {
      this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 0 } })
    }
  }

  private async executeSandwich(
    swap: PendingSwap,
    frontAmountBNB: bigint,
    minFrontTokenOut: bigint,
    estimatedGasUSD: number,
    priorityGwei: number,
  ) {
    if (!this.running) return

    const id = randomUUID()
    const tokenAddress = this.config.token.address as `0x${string}`
    const routerAddress = this.routerAddresses[0] as `0x${string}`
    const account = this.walletClient.account!
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60)
    const priorityGasWei = parseUnits(priorityGwei.toFixed(9), 9)

    let frontRunSubmitted = false

    try {
      const balanceBefore = await this.publicClient.getBalance({ address: account.address })
      if (!this.running) return

      // ── Step 1: Front-run buy ────────────────────────────────────────
      const frontBNBEth = Number(formatUnits(frontAmountBNB, 18)).toFixed(4)
      console.log(chalk.dim(`[Sandwich] ① 前跑买入 ${frontBNBEth} BNB → ${this.config.token.symbol}`))
      const frontRunHash = await this.walletClient.writeContract({
        address: routerAddress, abi: ROUTER_ABI, functionName: 'swapExactETHForTokens',
        args: [minFrontTokenOut, [WBNB, tokenAddress], account.address, deadline],
        value: frontAmountBNB, gasPrice: priorityGasWei, account, chain: null,
      })
      frontRunSubmitted = true
      console.log(chalk.dim(`[Sandwich] ① 前跑已提交: ${frontRunHash}`))

      const frontReceipt = await this.publicClient.waitForTransactionReceipt({ hash: frontRunHash, timeout: 30_000 })
      if (frontReceipt.status !== 'success') throw new Error('前跑买入交易被链上回滚')
      if (!this.running) return

      await new Promise((r) => setTimeout(r, 150))
      if (!this.running) return

      const tokenBalance = await this.publicClient.readContract({
        address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
      })
      if (tokenBalance === 0n) throw new Error('前跑后未收到代币，受害者交易可能未上链')

      // ── Step 2: Approve ──────────────────────────────────────────────
      const approveHash = await this.walletClient.writeContract({
        address: tokenAddress, abi: ERC20_ABI, functionName: 'approve',
        args: [routerAddress, tokenBalance], gasPrice: priorityGasWei, account, chain: null,
      })
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 })
      if (!this.running) return

      // ── Step 3: Back-run sell ────────────────────────────────────────
      console.log(chalk.dim(`[Sandwich] ② 后跑卖出: ${this.config.token.symbol} → BNB`))
      const backRunHash = await this.walletClient.writeContract({
        address: routerAddress, abi: ROUTER_ABI, functionName: 'swapExactTokensForETH',
        args: [tokenBalance, 0n, [tokenAddress, WBNB], account.address, deadline],
        gasPrice: priorityGasWei, account, chain: null,
      })
      const backReceipt = await this.publicClient.waitForTransactionReceipt({ hash: backRunHash, timeout: 30_000 })
      if (backReceipt.status !== 'success') throw new Error('后跑卖出交易被链上回滚')

      // ── Step 4: Real profit from balance diff ───────────────────────
      const balanceAfter = await this.publicClient.getBalance({ address: account.address })
      const diffBNB = Number(formatUnits(balanceAfter - balanceBefore, 18))
      const actualProfitUSD = diffBNB * 580

      const trade = {
        id, strategy: 'sandwich', token: this.config.token.symbol,
        txHash: backRunHash, chain: 'BSC',
        profitUSD: actualProfitUSD, gasUSD: estimatedGasUSD,
        status: 'success' as const, timestamp: Date.now(),
      }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })

      if (actualProfitUSD >= 0) {
        console.log(chalk.green(`[Sandwich] ✓ 完成! 实际利润 $${actualProfitUSD.toFixed(2)} | ${backRunHash}`))
      } else {
        console.log(chalk.yellow(`[Sandwich] 完成但亏损 $${Math.abs(actualProfitUSD).toFixed(2)} | ${backRunHash}`))
      }

    } catch (err: any) {
      const msg = cleanError(err)
      console.error(chalk.red(`[Sandwich] ✗ 失败: ${msg}`))
      if (frontRunSubmitted) {
        saveTrade({ id, strategy: 'sandwich', token: this.config.token.symbol, txHash: '', chain: 'BSC', profitUSD: 0, gasUSD: estimatedGasUSD, status: 'failed', timestamp: Date.now() })
        this.ws.broadcast({ type: 'trade', payload: { id, strategy: 'sandwich', token: this.config.token.symbol, txHash: '', chain: 'BSC', profitUSD: 0, gasUSD: estimatedGasUSD, status: 'failed', timestamp: Date.now() } })
      }
    }
  }

  get isRunning() { return this.running }
}
