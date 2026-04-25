import {
  type PublicClient, type WalletClient,
  type Address, parseAbi, parseUnits, formatUnits, formatEther, encodeFunctionData, getAddress,
} from 'viem'
import chalk from 'chalk'
import { randomUUID } from 'crypto'
import { BlockWatcher, type MinedSwap } from '../core/block-watcher.js'
import { PuissantClient, logBundleResult, type PuissantTx } from '../core/puissant.js'
import { SANDWICH_PROXY_ABI, SANDWICH_PROXY_BYTECODE } from '../contracts/proxy.js'
import { saveConfig, loadConfig } from '../core/config.js'
import { saveTrade } from '../core/db.js'
import { WsServer } from '../core/ws-server.js'

// ── Strategy: Block-level Cross-DEX Backrun ───────────────────────────────
//
// Why this strategy exists:
//   • Classic sandwich requires public mempool access. Behind GFW or on
//     restrictive networks, mempool WSS is unreachable → sandwich can't run.
//   • Block-level observation works through any plain HTTP RPC. We see swaps
//     AFTER they mine, not before, so we can't sandwich — but we CAN arbitrage
//     the price dislocation they create across DEXes.
//
// Core loop:
//   1. BlockWatcher polls the latest block (~800ms interval, HTTP RPC).
//   2. For each swap on our target token's PancakeSwap pair, we re-check
//      reserves on both PancakeSwap and BiSwap. A big trade on one DEX
//      doesn't propagate instantly to the other, leaving a transient price
//      gap.
//   3. If the gap is profitable after fees + gas, we bundle two proxy calls:
//        frontrun(DEX_with_lower_price)  — buys token with BNB
//        backrun (DEX_with_higher_price) — sells token for BNB
//      ... and submit it via 48 Club's Puissant relay, targeting the next
//      block's top slot. Puissant guarantees atomicity: if the arb vanishes
//      before inclusion, the whole bundle is dropped with no gas loss.
//
// Safety:
//   • `acceptReverting: []` on the bundle means ANY tx that would revert
//     kills the bundle. We never pay gas on a busted arb.
//   • `executing` latch prevents concurrent bundles racing our own nonce.
//   • We cap per-block execution to 1 bundle — BSC arb competition is too
//     fast to pipeline usefully at block time.

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address

const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])

const FEE_NUM = 9975n   // PancakeSwap V2 / BiSwap V1 both use 0.25% fee
const FEE_DEN = 10000n

const GAS_DEPLOY   = 1_200_000n
// Slightly higher than sandwich — Puissant bundles are priced per-tx, and we
// want to win ordering ties in block N+1's top slot.
const GAS_FRONTRUN =  240_000n
const GAS_BACKRUN  =  200_000n

const BNB_PRICE_FALLBACK = 580

// PancakeSwap V2 AMM spot math
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n
  const amountInWithFee = amountIn * FEE_NUM
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DEN + amountInWithFee)
}

// Clean error text out of viem's verbose multi-line messages.
function cleanError(err: any): string {
  const cands = [err?.shortMessage, err?.cause?.shortMessage, err?.cause?.message, err?.message]
  for (const c of cands) {
    if (!c) continue
    const line = String(c).split('\n')[0]
      .replace(/\s*URL:.*/, '').replace(/\s*Request body:.*/, '')
      .replace(/\s*Version:.*/, '').replace(/\s*Details:.*/, '').trim()
    if (line.length > 0 && line.length < 200) return line
  }
  return '未知错误'
}

export interface BackrunConfig {
  minProfitUSD:       number
  maxGasGwei:         number
  executionAmountUSD: number
  slippageTolerance:  number
  // min dislocation between the two pools (pct) to trigger
  minSpreadPct:       number
  token: {
    address:      string
    symbol:       string
    pairAddress?: string    // primary DEX (PancakeSwap) pair address
    buyTax?:      number
    sellTax?:     number
  }
}

// Router + factory pair. Both DEXes we'll scan for cross-arb opportunities.
// Hardcoded for BSC; at V1 we only do Pancake ⇄ BiSwap because those cover
// >95% of BSC token liquidity by pair count.
const DEXES = [
  {
    name:    'PancakeSwap',
    router:  '0x10ED43C718714eb63d5aA57B78B54704E256024E' as Address,
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as Address,
  },
  {
    name:    'BiSwap',
    router:  '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8' as Address,
    factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE' as Address,
  },
] as const

type DexKey = typeof DEXES[number]['name']

interface PoolState {
  name:         DexKey
  router:       Address
  pair:         Address
  reserveBNB:   bigint
  reserveToken: bigint
}

export class BackrunStrategy {
  private running    = false
  private executing  = false
  private scanned    = 0
  private proxyAddress: Address | null = null
  private bnbPrice   = BNB_PRICE_FALLBACK
  private bnbPriceTimer?: NodeJS.Timeout
  private watcher:   BlockWatcher
  private puissant:  PuissantClient
  // Per-DEX pair address for the configured token. Looked up once at start.
  private pairs:     Record<DexKey, Address | null> = { PancakeSwap: null, BiSwap: null }
  // Debounce: only one bundle per block. Prevents racing bundles in the same
  // target block, which would conflict on nonce.
  private lastExecutedBlock = 0n

  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private ws:           WsServer,
    private config:       BackrunConfig,
  ) {
    const allRouters = DEXES.map(d => d.router)
    this.watcher  = new BlockWatcher(publicClient, allRouters)
    this.puissant = new PuissantClient(walletClient, publicClient)
  }

  async start() {
    if (this.running) return
    this.running = true
    console.log(chalk.green(`[Backrun] 策略启动 → 目标: ${this.config.token.symbol}`))

    try {
      await this.refreshBnbPrice()
      this.bnbPriceTimer = setInterval(() => this.refreshBnbPrice(), 120_000)

      // 1. Make sure the proxy exists (reused across sandwich + backrun).
      await this.ensureProxy()

      // 2. Resolve pair addresses on both DEXes. A token must be listed on
      //    BOTH to be arb-able. If only one has liquidity, strategy stays
      //    idle — the only profitable arbs require two sides.
      await this.resolvePairs()
      if (!this.pairs.PancakeSwap || !this.pairs.BiSwap) {
        const missing = !this.pairs.PancakeSwap ? 'PancakeSwap' : 'BiSwap'
        throw new Error(
          `目标 Token 在 ${missing} 上没有 WBNB 交易对 — 跨 DEX 套利需要两边都有池子。` +
          `换一个在多个 DEX 上都有流动性的 token (如 CAKE / USDT / BUSD)。`
        )
      }
      console.log(chalk.dim(`[Backrun] 已锁定交易对: Pancake=${this.pairs.PancakeSwap} | BiSwap=${this.pairs.BiSwap}`))

      // 3. Start block polling.
      this.watcher.onBlock((swaps, bn) => this.onBlock(swaps, bn))
      await this.watcher.start()

      this.ws.broadcast({ type: 'status', payload: { strategy: 'backrun', running: true, scanned: 0, pending: 0 } })
    } catch (err: any) {
      this.running = false
      this.watcher.stop()
      if (this.bnbPriceTimer) { clearInterval(this.bnbPriceTimer); this.bnbPriceTimer = undefined }
      this.ws.broadcast({ type: 'status', payload: { strategy: 'backrun', running: false, scanned: 0, pending: 0 } })
      const msg = cleanError(err) || String(err?.message ?? err)
      console.error(chalk.red(`[Backrun] 启动失败: ${msg}`))
      this.ws.broadcast({ type: 'error', payload: { message: `Backrun 启动失败: ${msg}` } })
      throw err
    }
  }

  stop() {
    this.running = false
    this.watcher.stop()
    if (this.bnbPriceTimer) { clearInterval(this.bnbPriceTimer); this.bnbPriceTimer = undefined }
    this.ws.broadcast({ type: 'status', payload: { strategy: 'backrun', running: false, scanned: 0, pending: 0 } })
    console.log(chalk.yellow('[Backrun] 策略已停止'))
  }

  get isRunning() { return this.running }

  // ── Proxy deployment (shared with sandwich) ────────────────────────────
  private async ensureProxy() {
    const account = this.walletClient.account!
    const cfg     = loadConfig()

    if (cfg.sandwichProxyAddress) {
      const code = await this.publicClient.getBytecode({ address: cfg.sandwichProxyAddress as Address })
      if (code && code !== '0x') {
        this.proxyAddress = cfg.sandwichProxyAddress as Address
        console.log(chalk.dim(`[Backrun] 复用代理合约: ${this.proxyAddress}`))
        return
      }
    }

    const balance = await this.publicClient.getBalance({ address: account.address })
    if (balance < parseUnits('0.005', 18)) {
      throw new Error(`部署代理合约需至少 0.005 BNB (当前 ${formatUnits(balance, 18)} BNB)`)
    }

    console.log(chalk.cyan('[Backrun] 部署代理合约...'))
    const hash = await this.walletClient.deployContract({
      abi:      SANDWICH_PROXY_ABI,
      bytecode: SANDWICH_PROXY_BYTECODE as `0x${string}`,
      account, chain: null, gas: GAS_DEPLOY,
    })
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (!receipt.contractAddress || receipt.status !== 'success') {
      throw new Error('代理合约部署失败')
    }
    this.proxyAddress = getAddress(receipt.contractAddress)
    saveConfig({ ...cfg, sandwichProxyAddress: this.proxyAddress })
    console.log(chalk.green(`[Backrun] ✓ 代理合约已部署: ${this.proxyAddress}`))
  }

  // ── Pair discovery ──────────────────────────────────────────────────────
  // Prefer the user-provided pair for PancakeSwap (from scanner); look up
  // BiSwap via factory. Writes into this.pairs.
  private async resolvePairs() {
    const token = getAddress(this.config.token.address as `0x${string}`)

    // PancakeSwap — use the scanner-provided pair if it's valid.
    if (this.config.token.pairAddress &&
        this.config.token.pairAddress !== '0x0000000000000000000000000000000000000000') {
      this.pairs.PancakeSwap = getAddress(this.config.token.pairAddress as `0x${string}`)
    } else {
      this.pairs.PancakeSwap = await this.lookupPair(DEXES[0].factory, token)
    }
    this.pairs.BiSwap = await this.lookupPair(DEXES[1].factory, token)
  }

  private async lookupPair(factory: Address, token: Address): Promise<Address | null> {
    try {
      const pair = await this.publicClient.readContract({
        address: factory, abi: FACTORY_ABI, functionName: 'getPair', args: [token, WBNB],
      }) as Address
      if (!pair || pair === '0x0000000000000000000000000000000000000000') return null
      return pair
    } catch { return null }
  }

  // ── Live BNB price for profit math ─────────────────────────────────────
  private async refreshBnbPrice() {
    try {
      const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' as Address
      const ROUTER_ABI = parseAbi([
        'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
      ])
      const amounts = await this.publicClient.readContract({
        address: DEXES[0].router, abi: ROUTER_ABI, functionName: 'getAmountsOut',
        args: [parseUnits('1', 18), [WBNB, BUSD]],
      }) as bigint[]
      const p = Number(formatUnits(amounts[1], 18))
      if (p > 100 && p < 10000) this.bnbPrice = p
    } catch { /* keep previous */ }
  }

  // ── Fired on every block containing router-touching swaps ─────────────
  private async onBlock(swaps: MinedSwap[], blockNumber: bigint) {
    if (!this.running || this.executing) return
    if (blockNumber <= this.lastExecutedBlock) return
    this.scanned++

    const targetLc = this.config.token.address.toLowerCase()
    // We only react to swaps that touched OUR target token.
    const relevant = swaps.filter(s =>
      s.tokenIn.toLowerCase() === targetLc || s.tokenOut.toLowerCase() === targetLc
    )
    if (relevant.length === 0) {
      this.ws.broadcast({
        type: 'status',
        payload: { strategy: 'backrun', running: true, scanned: this.scanned, pending: 0 },
      })
      return
    }

    // Surface to UI for visibility (similar to sandwich's mempool_tx stream).
    for (const s of relevant) {
      const sizeBNB = Number(formatEther(s.amountIn))
      this.ws.broadcast({
        type:    'mempool_tx',
        payload: {
          hash: s.txHash, bnb: sizeBNB, usd: Math.round(sizeBNB * this.bnbPrice),
        },
      })
    }

    this.executing = true
    try {
      await this.evaluateArb(blockNumber)
    } finally {
      this.executing = false
      this.ws.broadcast({
        type: 'status',
        payload: { strategy: 'backrun', running: true, scanned: this.scanned, pending: 0 },
      })
    }
  }

  // Fetch reserves for both pools and see if a cross-DEX arb exists now.
  private async evaluateArb(blockNumber: bigint) {
    if (!this.pairs.PancakeSwap || !this.pairs.BiSwap) return

    const [poolA, poolB] = await Promise.all([
      this.loadPool('PancakeSwap', this.pairs.PancakeSwap, DEXES[0].router),
      this.loadPool('BiSwap',      this.pairs.BiSwap,      DEXES[1].router),
    ])
    if (!poolA || !poolB) return

    // Price = BNB per token. Higher price means token is worth more BNB on
    // that pool. We buy on the CHEAPER pool and sell on the MORE EXPENSIVE.
    const priceA = Number(poolA.reserveBNB) / Number(poolA.reserveToken)
    const priceB = Number(poolB.reserveBNB) / Number(poolB.reserveToken)
    const minP   = Math.min(priceA, priceB)
    const maxP   = Math.max(priceA, priceB)
    const spreadPct = ((maxP - minP) / minP) * 100

    // Skip visible noise — below this, any "arb" is lost to fees.
    if (spreadPct < this.config.minSpreadPct) return

    const buySide  = priceA < priceB ? poolA : poolB
    const sellSide = priceA < priceB ? poolB : poolA

    // Size the trade. Capped at the user's USD budget; further capped at
    // 0.5% of the smaller pool's BNB reserve to keep price-impact sane.
    const budgetBNB = this.config.executionAmountUSD / this.bnbPrice
    const maxByImpactBNB = Number(formatEther(buySide.reserveBNB)) * 0.005
    const sizeBNB = Math.min(budgetBNB, maxByImpactBNB)
    if (sizeBNB <= 0.001) return   // too little to bother

    const amountIn = parseUnits(sizeBNB.toFixed(6), 18)

    // Simulate the round-trip across both pools.
    const buyTax  = (this.config.token.buyTax  ?? 0) / 100
    const sellTax = (this.config.token.sellTax ?? 0) / 100

    // Leg 1: buy token on `buySide`
    const tokenOutRaw = getAmountOut(amountIn, buySide.reserveBNB, buySide.reserveToken)
    const tokenOutEff = tokenOutRaw * BigInt(Math.floor((1 - buyTax) * 10000)) / 10000n
    if (tokenOutEff === 0n) return

    // Leg 2: sell the tokens on `sellSide` (uses pre-update reserves — this
    // is an upper bound because some other arber might land before us).
    const bnbOutRaw   = getAmountOut(tokenOutEff, sellSide.reserveToken, sellSide.reserveBNB)
    const bnbOutEff   = bnbOutRaw * BigInt(Math.floor((1 - sellTax) * 10000)) / 10000n

    const profitBNB = Number(formatEther(bnbOutEff)) - sizeBNB

    // Gas cost — two txs via Puissant. BSC typical gasPrice is 1-3 gwei.
    // Respect user's `maxGasGwei` slider — was hardcoded at 5 before.
    const gasPriceWei = parseUnits(String(Math.max(this.config.maxGasGwei, 1)), 9)
    const gasCostBNB  = Number(formatEther((GAS_FRONTRUN + GAS_BACKRUN) * gasPriceWei))
    const gasCostUSD  = gasCostBNB * this.bnbPrice
    const netProfitUSD = profitBNB * this.bnbPrice - gasCostUSD

    console.log(chalk.dim(
      `[Backrun] 评估 | 价差 ${spreadPct.toFixed(3)}% | ` +
      `买@${buySide.name} 卖@${sellSide.name} | 规模 ${sizeBNB.toFixed(4)} BNB | ` +
      `毛利 $${(profitBNB * this.bnbPrice).toFixed(3)} | gas $${gasCostUSD.toFixed(3)} | 净利 $${netProfitUSD.toFixed(3)}`
    ))

    if (netProfitUSD < this.config.minProfitUSD) return

    // Slippage floor
    const slip = this.config.slippageTolerance / 100
    const minFrontOut = tokenOutEff * BigInt(Math.floor((1 - slip)     * 10000)) / 10000n
    const minBackOut  = bnbOutEff   * BigInt(Math.floor((1 - slip * 2) * 10000)) / 10000n

    this.ws.broadcast({
      type: 'opportunity',
      payload: {
        id: randomUUID(), strategy: 'backrun',
        token: this.config.token.symbol, tokenAddress: this.config.token.address,
        chain: 'BSC',
        profitUSD:    netProfitUSD,
        profitNative: netProfitUSD / this.bnbPrice,
        gasUSD:       gasCostUSD,
        netProfit:    netProfitUSD,
        timestamp:    Date.now(),
      },
    })

    this.lastExecutedBlock = blockNumber
    await this.executeBundle({
      buyRouter:    buySide.router,
      sellRouter:   sellSide.router,
      amountIn,
      minFrontOut,
      minBackOut,
      gasPriceWei,
      estimatedGasUSD: gasCostUSD,
    })
  }

  private async loadPool(
    name: DexKey, pair: Address, router: Address,
  ): Promise<PoolState | null> {
    try {
      const [reserves, token0] = await Promise.all([
        this.publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' }),
        this.publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' }),
      ])
      const isWbnb0 = String(token0).toLowerCase() === WBNB.toLowerCase()
      const reserveBNB   = isWbnb0 ? reserves[0] : reserves[1]
      const reserveToken = isWbnb0 ? reserves[1] : reserves[0]
      if (reserveBNB === 0n || reserveToken === 0n) return null
      return { name, router, pair, reserveBNB, reserveToken }
    } catch { return null }
  }

  // ── Construct + submit the 2-tx bundle via Puissant ─────────────────────
  private async executeBundle(args: {
    buyRouter:       Address
    sellRouter:      Address
    amountIn:        bigint
    minFrontOut:     bigint
    minBackOut:      bigint
    gasPriceWei:     bigint
    estimatedGasUSD: number
  }) {
    if (!this.running || !this.proxyAddress) return

    const id       = randomUUID()
    const account  = this.walletClient.account!
    const tokenAdr = getAddress(this.config.token.address as `0x${string}`)
    const proxy    = this.proxyAddress

    try {
      const balanceBefore = await this.publicClient.getBalance({ address: account.address })
      const nonce = await this.publicClient.getTransactionCount({
        address: account.address, blockTag: 'pending',
      })

      // Leg 1: frontrun(router, token, wbnb, minOut) — buys via `buyRouter`
      const frontData = encodeFunctionData({
        abi: SANDWICH_PROXY_ABI,
        functionName: 'frontrun',
        args: [args.buyRouter, tokenAdr, WBNB, args.minFrontOut],
      })
      const frontTx: PuissantTx = {
        to:       proxy,
        data:     frontData,
        value:    args.amountIn,
        gas:      GAS_FRONTRUN,
        gasPrice: args.gasPriceWei,
        nonce,
      }

      // Leg 2: backrun(router, token, wbnb, minBNBOut) — sells via `sellRouter`
      const backData = encodeFunctionData({
        abi: SANDWICH_PROXY_ABI,
        functionName: 'backrun',
        args: [args.sellRouter, tokenAdr, WBNB, args.minBackOut],
      })
      const backTx: PuissantTx = {
        to:       proxy,
        data:     backData,
        value:    0n,
        gas:      GAS_BACKRUN,
        gasPrice: args.gasPriceWei,
        nonce:    nonce + 1,
      }

      console.log(chalk.cyan(
        `[Backrun] → 提交 bundle: buy@${args.buyRouter.slice(0,10)} sell@${args.sellRouter.slice(0,10)}, 规模 ${formatEther(args.amountIn)} BNB`
      ))

      // acceptReverting: [] — relay drops bundle if either tx would revert.
      // This is our built-in "no free money = no gas loss" guarantee.
      const result = await this.puissant.submitBundle([frontTx, backTx], {
        ttlSeconds: 30,
        acceptRevertingHashes: [],
      })
      logBundleResult(`Backrun bundle #${id.slice(0, 6)}`, result)

      if (!result.ok) {
        this.recordFailed(id, result.error ?? 'relay 未返回详细错误', args.estimatedGasUSD)
        return
      }

      // Wait for inclusion — up to ~45s (bundle TTL + safety margin).
      // We observe the backrun tx hash; if it mines successfully the whole
      // bundle landed. If it never mines (bundle dropped), treat as miss.
      const [frontHash, backHash] = result.txHashes as [`0x${string}`, `0x${string}`]
      try {
        const backR = await this.publicClient.waitForTransactionReceipt({
          hash: backHash, timeout: 45_000,
        })
        if (backR.status !== 'success') {
          this.recordFailed(id, '后跑交易链上回滚', args.estimatedGasUSD)
          return
        }
        await this.recordSuccess(id, frontHash, backHash, balanceBefore, args.estimatedGasUSD)
      } catch (e: any) {
        // Timeout = bundle wasn't included. Not an error — arb competition
        // is fierce; we'll try again on the next qualifying block.
        console.log(chalk.dim(`[Backrun] bundle 未被打包 (可能被抢 / 过期)`))
        this.recordMissed(id, args.estimatedGasUSD)
      }

    } catch (err: any) {
      const msg = cleanError(err)
      console.error(chalk.red(`[Backrun] ✗ 执行失败: ${msg}`))
      this.recordFailed(id, msg, args.estimatedGasUSD)
    }
  }

  private async recordSuccess(
    id: string, frontHash: string, backHash: string,
    balanceBefore: bigint, estimatedGasUSD: number,
  ) {
    const account   = this.walletClient.account!
    const balanceAfter = await this.publicClient.getBalance({ address: account.address })
    const diffBNB   = Number(formatUnits(balanceAfter - balanceBefore, 18))
    const actualProfit = diffBNB * this.bnbPrice

    const trade = {
      id, strategy: 'backrun', token: this.config.token.symbol,
      txHash: backHash, chain: 'BSC',
      profitUSD: actualProfit, gasUSD: estimatedGasUSD,
      status: 'success' as const, timestamp: Date.now(),
    }
    saveTrade(trade)
    this.ws.broadcast({ type: 'trade', payload: trade })
    if (actualProfit >= 0) {
      console.log(chalk.green(`[Backrun] ✓ 完成! 净利 $${actualProfit.toFixed(2)} | ${backHash}`))
    } else {
      console.log(chalk.yellow(`[Backrun] 完成但亏损 $${Math.abs(actualProfit).toFixed(2)} | ${backHash}`))
    }
  }

  private recordFailed(id: string, reason: string, estimatedGasUSD: number) {
    const trade = {
      id, strategy: 'backrun', token: this.config.token.symbol,
      txHash: '', chain: 'BSC',
      profitUSD: 0, gasUSD: estimatedGasUSD,
      status: 'failed' as const, timestamp: Date.now(),
    }
    saveTrade(trade)
    this.ws.broadcast({ type: 'trade', payload: trade })
    console.warn(chalk.yellow(`[Backrun] 失败记录: ${reason}`))
  }

  // "Missed" = bundle submitted, relay OK, never mined (other bot won).
  // Distinguished from failed because NO GAS WAS SPENT.
  private recordMissed(id: string, _estimatedGasUSD: number) {
    const trade = {
      id, strategy: 'backrun', token: this.config.token.symbol,
      txHash: '', chain: 'BSC',
      profitUSD: 0, gasUSD: 0,
      status: 'failed' as const, timestamp: Date.now(),
    }
    saveTrade(trade)
    this.ws.broadcast({ type: 'trade', payload: trade })
  }
}
