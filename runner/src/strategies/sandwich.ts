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
  'function allowance(address owner, address spender) view returns (uint256)',
])

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as `0x${string}`
const WBNB_LOWER = WBNB.toLowerCase()
const FEE_NUMERATOR   = 9975n
const FEE_DENOMINATOR = 10000n
const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

// Realistic gas per swap (PancakeSwap V2)
const GAS_PER_SWAP = 180_000n
const BNB_PRICE_USD = 580

export interface SandwichConfig {
  minProfitUSD: number
  maxGasGwei: number
  minLiquidityUSD: number
  executionAmountUSD: number
  priorityGasMultiplier: number   // kept for UI compat but we now use additive (+Gwei)
  slippageTolerance: number
  targetDexes: string[]
  token: {
    address: string
    symbol: string
    dex: string
    pairAddress?: string
    buyTax?: number
    sellTax?: number
  }
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

// AMM getAmountOut with 0.25% fee (PancakeSwap V2 standard)
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n
  const amountInWithFee = amountIn * FEE_NUMERATOR
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee)
}

export class SandwichStrategy {
  private running = false
  private executing = false
  private mempool: MempoolMonitor
  private stopFn?: () => void
  private scanned = 0
  private approved = false

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

    // Pre-approve: do once so we never need approve during sandwich (saves 1 block)
    await this.preApprove()

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

  // ── Pre-approve router to spend target token (MAX) ─────────────────────
  private async preApprove() {
    const tokenAddress = this.config.token.address as `0x${string}`
    const routerAddress = this.routerAddresses[0] as `0x${string}`
    const account = this.walletClient.account!
    try {
      const allowance = await this.publicClient.readContract({
        address: tokenAddress, abi: ERC20_ABI, functionName: 'allowance',
        args: [account.address, routerAddress],
      })
      if (allowance < parseUnits('1000000', 18)) {
        console.log(chalk.dim(`[Sandwich] 预授权 ${this.config.token.symbol} 给路由器...`))
        const approveHash = await this.walletClient.writeContract({
          address: tokenAddress, abi: ERC20_ABI, functionName: 'approve',
          args: [routerAddress, MAX_UINT256], account, chain: null,
        })
        await this.publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 })
        this.approved = true
        console.log(chalk.green(`[Sandwich] ✓ 预授权完成`))
      } else {
        this.approved = true
        console.log(chalk.dim(`[Sandwich] 授权已足够，跳过`))
      }
    } catch (e: any) {
      console.warn(chalk.yellow(`[Sandwich] 预授权失败: ${cleanError(e)}`))
    }
  }

  private async evaluateSwap(swap: PendingSwap) {
    if (!this.running || this.executing) return
    this.scanned++

    const targetToken = this.config.token.address.toLowerCase()

    // ── 1. Filter: victim must be buying our exact target token ────────────
    // For ETH→Token swaps: tokenOut must be our target
    // We ignore token→ETH (selling) and token→token swaps — can't profitably sandwich those as front-buyer
    const isEthForToken = swap.amountIn > 0n && swap.tokenOut === targetToken
    if (!isEthForToken) return

    // ── 2. Victim BNB amount ───────────────────────────────────────────────
    const victimBNB = Number(formatEther(swap.amountIn))
    const MIN_VICTIM_BNB = 1.5   // victim must spend ≥ 1.5 BNB (~$870) to create impact
    if (victimBNB < MIN_VICTIM_BNB) return

    // ── 3. Gas price check ────────────────────────────────────────────────
    const victimGasPriceGwei = Number(swap.gasPrice) / 1e9
    if (victimGasPriceGwei > this.config.maxGasGwei) return

    // Front-run: victim + 1.5 Gwei | Back-run: victim gas (same priority tier)
    const FRONT_PREMIUM_GWEI = 1.5
    const frontGasWei  = swap.gasPrice + parseUnits(FRONT_PREMIUM_GWEI.toFixed(9), 9)
    const backGasWei   = swap.gasPrice

    // ── 4. Realistic gas cost: 2 swaps (frontrun + backrun), approve is pre-done
    const totalGasWei = frontGasWei * GAS_PER_SWAP + backGasWei * GAS_PER_SWAP
    const gasCostBNB = Number(formatUnits(totalGasWei, 18))
    const gasCostUSD = gasCostBNB * BNB_PRICE_USD

    // ── 5. AMM profit simulation ──────────────────────────────────────────
    let profitUSD = 0
    let frontAmountBNB: bigint
    let estimatedFrontTokenOut: bigint
    let minFrontTokenOut: bigint

    try {
      const pairAddress = this.config.token.pairAddress as `0x${string}` | undefined
      if (!pairAddress || pairAddress === '0x0000000000000000000000000000000000000000') return

      const [reserves, token0] = await Promise.all([
        this.publicClient.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves' }),
        this.publicClient.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token0' }),
      ])
      if (!this.running) return

      const isWbnbToken0 = token0.toLowerCase() === WBNB_LOWER
      const reserveBNB   = isWbnbToken0 ? reserves[0] : reserves[1]
      const reserveToken = isWbnbToken0 ? reserves[1] : reserves[0]

      // Execution amount: config max, but cap at 20% of victim (too big = more slippage than gain)
      const maxExecBNB = (this.config.executionAmountUSD ?? 50) / BNB_PRICE_USD
      const execBNB    = Math.min(maxExecBNB, victimBNB * 0.2)
      frontAmountBNB   = parseUnits(execBNB.toFixed(6), 18)

      // ── Simulate 3-step AMM ──────────────────────────────────────────────
      // Step A: We buy → price goes up
      const frontTokenOut = getAmountOut(frontAmountBNB, reserveBNB, reserveToken)
      const rBNB_A  = reserveBNB   + frontAmountBNB
      const rTok_A  = reserveToken - frontTokenOut

      // Step B: Victim buys → price goes up more
      const victimAmountWei = swap.amountIn
      const _victimTokenOut = getAmountOut(victimAmountWei, rBNB_A, rTok_A)
      const rBNB_B  = rBNB_A  + victimAmountWei
      const rTok_B  = rTok_A  - _victimTokenOut

      // Step C: We sell → capture price difference
      const backBNBOut = getAmountOut(frontTokenOut, rTok_B, rBNB_B)

      // Account for token buy/sell tax if known from scanner
      const buyTax  = (this.config.token.buyTax  ?? 0) / 100
      const sellTax = (this.config.token.sellTax ?? 0) / 100
      const effectiveTokenOut = frontTokenOut * BigInt(Math.floor((1 - buyTax)  * 10000)) / 10000n
      const effectiveBackBNB  = backBNBOut    * BigInt(Math.floor((1 - sellTax) * 10000)) / 10000n

      estimatedFrontTokenOut = effectiveTokenOut
      const grossProfitBNB = Number(formatUnits(effectiveBackBNB, 18)) - execBNB
      const grossProfitUSD = grossProfitBNB * BNB_PRICE_USD
      profitUSD = grossProfitUSD - gasCostUSD

      // Slippage protection for frontrun
      const slippage = (this.config.slippageTolerance ?? 1) / 100
      minFrontTokenOut = effectiveTokenOut * BigInt(Math.floor((1 - slippage) * 10000)) / 10000n

      console.log(chalk.dim(
        `[Sandwich] 评估 | 目标 ${this.config.token.symbol} | 受害者 ${victimBNB.toFixed(2)} BNB | ` +
        `执行 ${execBNB.toFixed(4)} BNB | 毛利 $${grossProfitUSD.toFixed(3)} | gas $${gasCostUSD.toFixed(3)} | 净利 $${profitUSD.toFixed(3)}`
      ))
    } catch (e: any) {
      console.warn(chalk.dim(`[Sandwich] 储备查询失败: ${cleanError(e)}`))
      return
    }

    // ── 6. Skip if unprofitable ────────────────────────────────────────────
    if (profitUSD < this.config.minProfitUSD) return

    console.log(chalk.cyan(
      `[Sandwich] ✓ 发现机会: ${this.config.token.symbol} 预计净利 $${profitUSD.toFixed(2)} | 受害者 ${victimBNB.toFixed(2)} BNB`
    ))

    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(), strategy: 'sandwich',
        token: this.config.token.symbol, tokenAddress: this.config.token.address,
        chain: 'BSC', profitUSD, profitNative: profitUSD / BNB_PRICE_USD,
        gasUSD: gasCostUSD, netProfit: profitUSD,
        timestamp: Date.now(),
      },
    })

    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 1 } })
    this.executing = true
    await this.executeSandwich(swap, frontAmountBNB!, minFrontTokenOut!, estimatedFrontTokenOut!, gasCostUSD, frontGasWei, backGasWei)
    this.executing = false
    if (this.running) {
      this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 0 } })
    }
  }

  private async executeSandwich(
    swap: PendingSwap,
    frontAmountBNB: bigint,
    minFrontTokenOut: bigint,
    estimatedFrontTokenOut: bigint,
    estimatedGasUSD: number,
    frontGasWei: bigint,
    backGasWei: bigint,
  ) {
    if (!this.running) return

    const id = randomUUID()
    const tokenAddress  = this.config.token.address as `0x${string}`
    const routerAddress = this.routerAddresses[0] as `0x${string}`
    const account       = this.walletClient.account!
    const deadline      = BigInt(Math.floor(Date.now() / 1000) + 120)

    let frontRunSubmitted = false

    try {
      const balanceBefore = await this.publicClient.getBalance({ address: account.address })
      if (!this.running) return

      // ── Get current nonce so we can pipeline both txs ──────────────────
      const nonce = await this.publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
      if (!this.running) return

      // ── Step 1: Front-run buy ────────────────────────────────────────────
      const frontBNBEth = Number(formatUnits(frontAmountBNB, 18)).toFixed(4)
      console.log(chalk.dim(`[Sandwich] ① 前跑买入 ${frontBNBEth} BNB → ${this.config.token.symbol}`))
      const frontRunHash = await this.walletClient.writeContract({
        address: routerAddress, abi: ROUTER_ABI, functionName: 'swapExactETHForTokens',
        args: [minFrontTokenOut, [WBNB, tokenAddress], account.address, deadline],
        value: frontAmountBNB, gasPrice: frontGasWei, nonce, account, chain: null,
      })
      frontRunSubmitted = true
      console.log(chalk.dim(`[Sandwich] ① 前跑已提交: ${frontRunHash}`))

      // ── Step 2: Back-run sell — submit immediately (no wait for frontrun!) ──
      // Use minFrontTokenOut as sell amount: if frontrun succeeds we have >= this
      // If frontrun fails, backrun also fails (no tokens), we waste only backrun gas (~$0.02)
      const sellAmount = minFrontTokenOut * 98n / 100n  // tiny buffer for rounding
      console.log(chalk.dim(`[Sandwich] ② 后跑卖出: ${this.config.token.symbol} → BNB`))
      const backRunHash = await this.walletClient.writeContract({
        address: routerAddress, abi: ROUTER_ABI, functionName: 'swapExactTokensForETH',
        args: [sellAmount, 0n, [tokenAddress, WBNB], account.address, deadline],
        gasPrice: backGasWei, nonce: nonce + 1, account, chain: null,
      })
      console.log(chalk.dim(`[Sandwich] ② 后跑已提交: ${backRunHash}`))

      // ── Wait for both concurrently ────────────────────────────────────────
      const [frontReceipt, backReceipt] = await Promise.all([
        this.publicClient.waitForTransactionReceipt({ hash: frontRunHash, timeout: 30_000 }),
        this.publicClient.waitForTransactionReceipt({ hash: backRunHash, timeout: 30_000 }),
      ])

      if (frontReceipt.status !== 'success') throw new Error('前跑买入被链上回滚')
      if (backReceipt.status !== 'success')  throw new Error('后跑卖出被链上回滚')

      // ── Real profit from balance diff ─────────────────────────────────────
      const balanceAfter = await this.publicClient.getBalance({ address: account.address })
      const diffBNB = Number(formatUnits(balanceAfter - balanceBefore, 18))
      const actualProfitUSD = diffBNB * BNB_PRICE_USD

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
        saveTrade({
          id, strategy: 'sandwich', token: this.config.token.symbol,
          txHash: '', chain: 'BSC',
          profitUSD: 0, gasUSD: estimatedGasUSD,
          status: 'failed', timestamp: Date.now(),
        })
        this.ws.broadcast({
          type: 'trade',
          payload: {
            id, strategy: 'sandwich', token: this.config.token.symbol,
            txHash: '', chain: 'BSC',
            profitUSD: 0, gasUSD: estimatedGasUSD,
            status: 'failed', timestamp: Date.now(),
          },
        })
      }
    }
  }

  get isRunning() { return this.running }
}
