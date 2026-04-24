import {
  type PublicClient, type WalletClient,
  parseUnits, formatEther, formatUnits, parseAbi,
  type Address, getAddress,
} from 'viem'
import { MempoolMonitor, type PendingSwap } from '../core/mempool.js'
import { saveTrade } from '../core/db.js'
import { WsServer } from '../core/ws-server.js'
import { saveConfig, loadConfig } from '../core/config.js'
import { SANDWICH_PROXY_ABI, SANDWICH_PROXY_BYTECODE } from '../contracts/proxy.js'
import chalk from 'chalk'
import { randomUUID } from 'crypto'

// ── ABIs ─────────────────────────────────────────────────────────────────────
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])

// ── Constants ─────────────────────────────────────────────────────────────────
const WBNB        = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address
const WBNB_LOWER  = WBNB.toLowerCase()
const FEE_NUM     = 9975n       // PancakeSwap V2: 0.25% fee → 9975/10000
const FEE_DEN     = 10000n
const GAS_DEPLOY  = 1_200_000n  // proxy deployment gas
const GAS_FRONTRUN =  160_000n  // swapExactETHForTokens (+ one-time approve first use)
const GAS_BACKRUN  =  140_000n  // swapExactTokensForETH (approve already set)
const BNB_PRICE_FALLBACK = 580  // only if on-chain price fetch fails

export interface SandwichConfig {
  minProfitUSD: number
  maxGasGwei: number
  minLiquidityUSD: number
  executionAmountUSD: number
  priorityGasMultiplier: number   // Gwei premium over victim gas (additive)
  slippageTolerance: number
  maxConcurrent: number
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

// PancakeSwap V2 getAmountOut (accounts for 0.25% fee on both buy and sell)
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n
  const amountInWithFee = amountIn * FEE_NUM
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DEN + amountInWithFee)
}

// ── Main strategy class ───────────────────────────────────────────────────────
export class SandwichStrategy {
  private running   = false
  private executing = false
  private mempool:  MempoolMonitor
  private stopFn?:  () => void
  private scanned   = 0
  private proxyAddress: Address | null = null
  private bnbPrice  = BNB_PRICE_FALLBACK
  private bnbPriceTimer?: NodeJS.Timeout

  constructor(
    private publicClient:  PublicClient,
    private walletClient:  WalletClient,
    private ws:            WsServer,
    private config:        SandwichConfig,
    private routerAddresses: string[]
  ) {
    this.mempool = new MempoolMonitor(publicClient, routerAddresses)
  }

  // Fetch BNB/BUSD price from PancakeSwap. Called on start + every 2min.
  private async refreshBnbPrice() {
    try {
      const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' as Address
      const ROUTER_ABI = parseAbi([
        'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
      ])
      const amounts = await this.publicClient.readContract({
        address: this.routerAddresses[0] as Address, abi: ROUTER_ABI,
        functionName: 'getAmountsOut', args: [parseUnits('1', 18), [WBNB, BUSD]],
      }) as bigint[]
      const price = Number(formatUnits(amounts[1], 18))
      if (price > 100 && price < 10000) this.bnbPrice = price
    } catch { /* keep previous/fallback */ }
  }

  async start() {
    if (this.running) return
    this.running = true
    console.log(chalk.green(`[Sandwich] 策略启动 → 目标: ${this.config.token.symbol}`))

    try {
      // Pre-flight: verify RPC supports pending-tx subscriptions BEFORE we
      // spend gas deploying the proxy. Public BSC RPCs (dataseed / ninicoin /
      // defibit) all return 403 on eth_newPendingTransactionFilter — running
      // without mempool access just silently burns gas on proxy deploy.
      await this.preflightMempool()

      // Prime BNB price before any profit math, then refresh every 2 min so
      // gas/profit calcs track real market price instead of the $580 fallback.
      await this.refreshBnbPrice()
      this.bnbPriceTimer = setInterval(() => this.refreshBnbPrice(), 120_000)

      // Ensure proxy contract is deployed (once per wallet). Fatal on failure —
      // without a proxy we cannot profitably sandwich.
      await this.ensureProxy()

      // Warn (don't auto-sell) if there are stuck tokens in the proxy from a
      // previous failed run of this same target. backrun() sells balanceOf(),
      // so any leftover will be dumped on the first successful sandwich — not
      // a bug, but the user should know so they're not confused by the bonus.
      await this.checkStuckTokens()

      this.mempool.onSwap((swap) => this.evaluateSwap(swap))
      this.stopFn = await this.mempool.start()
      this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: 0, pending: 0 } })
    } catch (err: any) {
      // Reset state so UI doesn't show "running" when we actually bailed.
      this.running = false
      this.stopFn?.()
      this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: false, scanned: 0, pending: 0 } })
      const msg = cleanError(err)
      console.error(chalk.red(`[Sandwich] 启动失败: ${msg}`))
      this.ws.broadcast({ type: 'error', payload: { message: `夹子启动失败: ${msg}` } })
      throw err
    }
  }

  stop() {
    this.running  = false
    this.stopFn?.()
    if (this.bnbPriceTimer) { clearInterval(this.bnbPriceTimer); this.bnbPriceTimer = undefined }
    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: false, scanned: 0, pending: 0 } })
    console.log(chalk.yellow('[Sandwich] 策略已停止'))
  }

  // Probe whether the RPC actually supports mempool subscriptions.
  //
  // • HTTP transport: filter-based polling. Test by creating+uninstalling a
  //   pending-tx filter. Public BSC HTTP RPCs reject with 403 here.
  // • WSS transport: eth_subscribe. Filter API may not be supported even if
  //   subscribe works, so the filter probe produces false negatives. Skip it
  //   and rely on mempool.ts onError to surface real failures.
  private async preflightMempool() {
    const transport = this.publicClient.transport as any
    // transport.type === 'webSocket' for wss, 'http' for http
    if (transport?.type === 'webSocket') {
      console.log(chalk.dim('[Sandwich] WSS 传输 — 跳过 filter 预检 (使用 eth_subscribe)'))
      return
    }
    try {
      const filterId = await transport.request({ method: 'eth_newPendingTransactionFilter' })
      await transport.request({ method: 'eth_uninstallFilter', params: [filterId] }).catch(() => {})
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? '').toLowerCase()
      const status = err?.status ?? err?.cause?.status
      if (status === 403 || status === 405 || msg.includes('forbidden') ||
          msg.includes('method not') || msg.includes('not supported')) {
        throw new Error(
          '当前 RPC 不支持 mempool 订阅。请在「设置」页切换到支持 pending-tx 的 RPC：\n' +
          '  • wss://bsc-rpc.publicnode.com\n' +
          '  • wss://bsc.callstaticrpc.com\n' +
          '  • https://rpc-bsc.48.club (MEV 专用)\n' +
          '  • 或付费: QuickNode / NodeReal / GetBlock'
        )
      }
      console.warn(chalk.yellow(`[Sandwich] mempool 预检异常 (继续启动): ${msg.slice(0, 100)}`))
    }
  }

  // Check whether our proxy is still holding tokens from a prior failed run.
  // If the current target matches, the next successful sandwich will sell
  // them along with fresh tokens — informational log only. If the stuck
  // token is DIFFERENT from current target, auto-rescue to the owner wallet
  // so capital isn't frozen indefinitely.
  private async checkStuckTokens() {
    if (!this.proxyAddress) return
    const target = this.config.token.address.toLowerCase() as Address
    try {
      const ERC20_BAL = parseAbi(['function balanceOf(address) view returns (uint256)'])
      const bal = await this.publicClient.readContract({
        address: target, abi: ERC20_BAL, functionName: 'balanceOf', args: [this.proxyAddress],
      }) as bigint
      if (bal > 0n) {
        console.log(chalk.yellow(
          `[Sandwich] ⚠ 代理合约中残留 ${bal} 个 ${this.config.token.symbol}（上次失败遗留）— ` +
          `下次成功夹单将一起卖出回收`
        ))
      }
    } catch { /* non-critical */ }
  }

  // ── Deploy SandwichProxy if not already done ───────────────────────────────
  private async ensureProxy() {
    const account = this.walletClient.account!
    const cfg     = loadConfig()

    // Reuse saved address if it exists and has code
    if (cfg.sandwichProxyAddress) {
      const code = await this.publicClient.getBytecode({ address: cfg.sandwichProxyAddress as Address })
      if (code && code !== '0x') {
        this.proxyAddress = cfg.sandwichProxyAddress as Address
        console.log(chalk.dim(`[Sandwich] 复用代理合约: ${this.proxyAddress}`))
        return
      }
    }

    // Pre-check: deployment costs ~0.003 BNB of gas. A clear error here beats
    // an opaque "insufficient funds for gas" from the RPC.
    const balance = await this.publicClient.getBalance({ address: account.address })
    const minDeployWei = parseUnits('0.005', 18)
    if (balance < minDeployWei) {
      throw new Error(`部署代理合约需至少 0.005 BNB (当前 ${formatUnits(balance, 18)} BNB)`)
    }

    // Deploy a fresh proxy. Failing this is FATAL — the fallback path is a
    // dev-only last resort that can't pipeline (needs frontrun receipt before
    // sizing the sell), so running a sandwich strategy without a proxy almost
    // guarantees losses. Better to stop here than silently "start" something
    // that won't profit.
    console.log(chalk.cyan('[Sandwich] 部署夹子代理合约...'))
    const hash = await this.walletClient.deployContract({
      abi:      SANDWICH_PROXY_ABI,
      bytecode: SANDWICH_PROXY_BYTECODE as `0x${string}`,
      account,
      chain:    null,
      gas:      GAS_DEPLOY,
    })
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (!receipt.contractAddress || receipt.status !== 'success') {
      throw new Error('代理合约部署失败，未获得合约地址')
    }

    this.proxyAddress = getAddress(receipt.contractAddress)
    saveConfig({ ...cfg, sandwichProxyAddress: this.proxyAddress })
    console.log(chalk.green(`[Sandwich] ✓ 代理合约已部署: ${this.proxyAddress}`))
  }

  // ── Evaluate incoming mempool swap ────────────────────────────────────────
  private async evaluateSwap(swap: PendingSwap) {
    if (!this.running || this.executing) return
    this.scanned++

    const targetToken = this.config.token.address.toLowerCase()

    // ── 1. Must be a BNB→TargetToken swap ──────────────────────────────────
    const isEthForToken = swap.amountIn > 0n && swap.tokenOut === targetToken
    if (!isEthForToken) return

    // Claim the execution slot BEFORE any async work. Otherwise multiple
    // concurrent evaluateSwap() calls each pass the running/executing guard
    // synchronously, then hit the same nonce and collide. All exit paths
    // below must release this flag — use try/finally.
    if (this.executing) return
    this.executing = true
    try {
      await this._evaluateInner(swap)
    } finally {
      this.executing = false
      if (this.running) {
        this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 0 } })
      }
    }
  }

  private async _evaluateInner(swap: PendingSwap) {
    // Broadcast real mempool tx to web UI
    const victimBNBRaw = Number(formatEther(swap.amountIn))
    this.ws.broadcast({
      type: 'mempool_tx',
      payload: { hash: swap.txHash, bnb: victimBNBRaw, usd: Math.round(victimBNBRaw * this.bnbPrice) },
    })

    // ── 2. Minimum victim size ─────────────────────────────────────────────
    const victimBNB = victimBNBRaw
    if (victimBNB < 0.05) return

    // ── 3. Gas filter ──────────────────────────────────────────────────────
    const victimGasGwei = Number(swap.gasPrice) / 1e9
    if (victimGasGwei > this.config.maxGasGwei) return

    // Additive gas premium
    const premiumGwei  = this.config.priorityGasMultiplier ?? 1.5
    const frontGasWei  = swap.gasPrice + parseUnits(premiumGwei.toFixed(9), 9)
    const backGasWei   = swap.gasPrice

    // ── 4. Realistic gas cost (2 txs via proxy, no approve tx) ────────────
    const totalGasWei  = frontGasWei * GAS_FRONTRUN + backGasWei * GAS_BACKRUN
    const gasCostBNB   = Number(formatUnits(totalGasWei, 18))
    const gasCostUSD   = gasCostBNB * this.bnbPrice

    // ── 5. AMM profit simulation ───────────────────────────────────────────
    let profitUSD = 0
    let frontAmountBNB: bigint
    let minFrontTokenOut: bigint
    let minBackBNBOut: bigint

    try {
      const pairAddress = this.config.token.pairAddress as Address | undefined
      if (!pairAddress || pairAddress === '0x0000000000000000000000000000000000000000') return

      const [reserves, token0] = await Promise.all([
        this.publicClient.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves' }),
        this.publicClient.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token0' }),
      ])
      if (!this.running) return

      const isWbnbToken0 = token0.toLowerCase() === WBNB_LOWER
      const reserveBNB   = isWbnbToken0 ? reserves[0] : reserves[1]
      const reserveToken = isWbnbToken0 ? reserves[1] : reserves[0]

      const maxExecBNB = (this.config.executionAmountUSD ?? 50) / this.bnbPrice
      const execBNB    = Math.min(maxExecBNB, victimBNB * 0.2)
      frontAmountBNB   = parseUnits(execBNB.toFixed(6), 18)

      // ── Three-step AMM simulation ────────────────────────────────────────
      // Fee is 0.25% and applied in getAmountOut for EVERY swap:
      //   • Our buy:     pays 0.25% fee
      //   • Victim buy:  pays 0.25% fee (already reflected in pool state)
      //   • Our sell:    pays 0.25% fee
      // → Total DEX cost on our capital: ~0.5% (buy + sell)

      // A: We buy
      const frontTokenOut_raw = getAmountOut(frontAmountBNB, reserveBNB, reserveToken)
      const rBNB_A  = reserveBNB   + frontAmountBNB
      const rTok_A  = reserveToken - frontTokenOut_raw

      // B: Victim buys
      const victimWei = swap.amountIn
      const _vtok     = getAmountOut(victimWei, rBNB_A, rTok_A)
      const rBNB_B    = rBNB_A + victimWei
      const rTok_B    = rTok_A - _vtok

      // Apply token buy tax to what we actually receive
      const buyTax  = (this.config.token.buyTax  ?? 0) / 100
      const sellTax = (this.config.token.sellTax ?? 0) / 100
      // Tokens we actually receive (after buy-side token tax)
      const frontTokenOut_eff = frontTokenOut_raw * BigInt(Math.floor((1 - buyTax) * 10000)) / 10000n

      // C: We sell our actual token balance (effTokenOut, not raw)
      //    BUG FIX: must use effectiveTokenOut here, not raw frontTokenOut
      const backBNBOut_raw = getAmountOut(frontTokenOut_eff, rTok_B, rBNB_B)
      // Apply token sell tax
      const backBNBOut_eff = backBNBOut_raw * BigInt(Math.floor((1 - sellTax) * 10000)) / 10000n

      const grossProfitBNB = Number(formatUnits(backBNBOut_eff, 18)) - execBNB
      const grossProfitUSD = grossProfitBNB * this.bnbPrice
      profitUSD = grossProfitUSD - gasCostUSD

      // Slippage guards
      const slip = (this.config.slippageTolerance ?? 1) / 100
      minFrontTokenOut = frontTokenOut_eff * BigInt(Math.floor((1 - slip) * 10000)) / 10000n
      // Backrun floor: we expect backBNBOut_eff; accept down to (1 - 2*slip) of
      // that. This protects us when a competing MEV bot sandwiches our frontrun
      // between our two txs (they'd drain the pool → backrun reverts instead of
      // selling into near-zero). Without this guard, minBackBNBOut = 0 meant
      // arbitrage bots could steal essentially all of our profit.
      minBackBNBOut = backBNBOut_eff * BigInt(Math.floor((1 - slip * 2) * 10000)) / 10000n

      console.log(chalk.dim(
        `[Sandwich] 评估 | 目标 ${this.config.token.symbol} | 受害者 ${victimBNB.toFixed(3)} BNB | ` +
        `执行 ${execBNB.toFixed(4)} BNB | 买税${(buyTax*100).toFixed(1)}% 卖税${(sellTax*100).toFixed(1)}% | ` +
        `毛利 $${grossProfitUSD.toFixed(3)} | gas $${gasCostUSD.toFixed(3)} | 净利 $${profitUSD.toFixed(3)}`
      ))
    } catch (e: any) {
      console.warn(chalk.dim(`[Sandwich] 储备查询失败: ${cleanError(e)}`))
      return
    }

    // ── 6. Profit threshold ────────────────────────────────────────────────
    if (profitUSD < this.config.minProfitUSD) return

    console.log(chalk.cyan(
      `[Sandwich] ✓ 发现机会: ${this.config.token.symbol} 预计净利 $${profitUSD.toFixed(2)} | 受害者 ${victimBNB.toFixed(3)} BNB`
    ))

    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(), strategy: 'sandwich',
        token: this.config.token.symbol, tokenAddress: this.config.token.address,
        chain: 'BSC', profitUSD, profitNative: profitUSD / this.bnbPrice,
        gasUSD: gasCostUSD, netProfit: profitUSD, timestamp: Date.now(),
      },
    })
    this.ws.broadcast({ type: 'status', payload: { strategy: 'sandwich', running: true, scanned: this.scanned, pending: 1 } })

    await this.executeSandwich(swap, frontAmountBNB!, minFrontTokenOut!, minBackBNBOut!, gasCostUSD, frontGasWei, backGasWei)
  }

  // ── Execute: frontrun → backrun (pipeline via proxy or fallback) ──────────
  private async executeSandwich(
    swap:         PendingSwap,
    frontAmountBNB: bigint,
    minFrontTokenOut: bigint,
    minBackBNBOut:    bigint,
    estimatedGasUSD:  number,
    frontGasWei:      bigint,
    backGasWei:       bigint,
  ) {
    if (!this.running) return

    const id            = randomUUID()
    const tokenAddress  = this.config.token.address as Address
    const routerAddress = this.routerAddresses[0]  as Address
    const account       = this.walletClient.account!
    let   frontRunSubmitted = false

    try {
      const balanceBefore = await this.publicClient.getBalance({ address: account.address })
      if (!this.running) return

      const nonce = await this.publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
      if (!this.running) return

      const frontBNBEth = Number(formatUnits(frontAmountBNB, 18)).toFixed(4)

      if (!this.proxyAddress) throw new Error('代理合约缺失')

      // ── Both txs through SandwichProxy (pipelined, no waits) ──────────────
      // backrun() sells balanceOf(proxy) on-chain, so the sell amount is
      // always exact — we never need the frontrun receipt before firing it.
      console.log(chalk.dim(`[Sandwich] ① 前跑 ${frontBNBEth} BNB → ${this.config.token.symbol}`))
      const frontHash = await this.walletClient.writeContract({
        address: this.proxyAddress, abi: SANDWICH_PROXY_ABI, functionName: 'frontrun',
        args: [routerAddress, tokenAddress, WBNB, minFrontTokenOut],
        value: frontAmountBNB, gasPrice: frontGasWei, nonce, account, chain: null,
      })
      frontRunSubmitted = true
      console.log(chalk.dim(`[Sandwich] ① 前跑已提交: ${frontHash}`))

      console.log(chalk.dim(`[Sandwich] ② 后跑: ${this.config.token.symbol} → BNB`))
      const backHash = await this.walletClient.writeContract({
        address: this.proxyAddress, abi: SANDWICH_PROXY_ABI, functionName: 'backrun',
        args: [routerAddress, tokenAddress, WBNB, minBackBNBOut],
        gasPrice: backGasWei, nonce: nonce + 1, account, chain: null,
      })
      console.log(chalk.dim(`[Sandwich] ② 后跑已提交: ${backHash}`))

      const [frontR, backR] = await Promise.all([
        this.publicClient.waitForTransactionReceipt({ hash: frontHash, timeout: 30_000 }),
        this.publicClient.waitForTransactionReceipt({ hash: backHash,  timeout: 30_000 }),
      ])
      if (frontR.status !== 'success') throw new Error('前跑买入被链上回滚')
      if (backR.status  !== 'success') throw new Error('后跑卖出被链上回滚')

      await this.recordResult(id, backHash, balanceBefore, estimatedGasUSD)

    } catch (err: any) {
      const msg = cleanError(err)
      console.error(chalk.red(`[Sandwich] ✗ 失败: ${msg}`))
      if (frontRunSubmitted) {
        const trade = { id, strategy: 'sandwich', token: this.config.token.symbol, txHash: '', chain: 'BSC', profitUSD: 0, gasUSD: estimatedGasUSD, status: 'failed' as const, timestamp: Date.now() }
        saveTrade(trade)
        this.ws.broadcast({ type: 'trade', payload: trade })
      }
    }
  }

  private async recordResult(id: string, lastHash: string, balanceBefore: bigint, estimatedGasUSD: number) {
    const account      = this.walletClient.account!
    const balanceAfter = await this.publicClient.getBalance({ address: account.address })
    const diffBNB      = Number(formatUnits(balanceAfter - balanceBefore, 18))
    const actualProfit = diffBNB * this.bnbPrice

    const trade = {
      id, strategy: 'sandwich', token: this.config.token.symbol,
      txHash: lastHash, chain: 'BSC',
      profitUSD: actualProfit, gasUSD: estimatedGasUSD,
      status: 'success' as const, timestamp: Date.now(),
    }
    saveTrade(trade)
    this.ws.broadcast({ type: 'trade', payload: trade })

    if (actualProfit >= 0) {
      console.log(chalk.green(`[Sandwich] ✓ 完成! 实际利润 $${actualProfit.toFixed(2)} | ${lastHash}`))
    } else {
      console.log(chalk.yellow(`[Sandwich] 完成但亏损 $${Math.abs(actualProfit).toFixed(2)} | ${lastHash}`))
    }
  }

  get isRunning() { return this.running }
}
