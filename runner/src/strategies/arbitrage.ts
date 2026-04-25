import {
  type PublicClient, type WalletClient,
  type Address, parseAbi, parseUnits, formatUnits, formatEther, encodeFunctionData, getAddress,
} from 'viem'
import chalk from 'chalk'
import { randomUUID } from 'crypto'
import { BlockWatcher } from '../core/block-watcher.js'
import { PuissantClient, logBundleResult, type PuissantTx } from '../core/puissant.js'
import { SANDWICH_PROXY_ABI, SANDWICH_PROXY_BYTECODE } from '../contracts/proxy.js'
import { saveConfig, loadConfig } from '../core/config.js'
import { saveTrade } from '../core/db.js'
import { WsServer } from '../core/ws-server.js'

// ── Strategy: Multi-Token Cross-DEX Arbitrage ──────────────────────────────
//
// Difference from Backrun:
//   • Backrun watches ONE user-picked token, reacts to swaps that touch it.
//   • Arbitrage watches a WHITELIST of high-liquidity tokens every block,
//     scoring every (token × dex-pair) for spread, then executing the best.
//
// Same Puissant-bundle execution path as Backrun (proxy.frontrun on cheap DEX
// → proxy.backrun on rich DEX, atomic bundle, `acceptReverting: []` so we
// never pay gas on a broken arb).

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address

const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])

// Pancake V3 quoter (QuoterV2-style). `quoteExactInputSingle` is technically
// non-view because it executes the swap then reverts to bubble up the result,
// but eth_call handles that pattern fine — viem's readContract works.
const V3_QUOTER       = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address
const V3_FEE_TIERS    = [100, 500, 2500, 10000] as const  // 0.01% / 0.05% / 0.25% / 1%
const V3_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

const FEE_NUM = 9975n
const FEE_DEN = 10000n

const GAS_DEPLOY   = 1_200_000n
const GAS_FRONTRUN =   240_000n
const GAS_BACKRUN  =   200_000n

const BNB_PRICE_FALLBACK = 580

// Default token whitelist — all high-liquidity BSC majors. User can override
// via the config in the UI. These all have liquid Pancake AND BiSwap pools.
export const DEFAULT_TOKEN_WHITELIST: { address: Address; symbol: string }[] = [
  { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE' },
  { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT' },
  { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD' },
  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH'  },
  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB' },
  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC' },
  { address: '0xfb6115445Bff7b52FeB98650C87f44907E58f802', symbol: 'AAVE' },
  { address: '0xCC42724C6683B7E57334c4E856f4c9965ED682bD', symbol: 'MATIC'},
]

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

// Synthetic "pool" for V3 — we don't have constant-product reserves, just a
// quoter we can ping. We carry the implied price (BNB per token) and the fee
// tier we found liquidity at. Cannot be used as a leg in proxy execution
// because the proxy targets V2 routers; included for **detection** so users
// see when V3 has a better price than the V2 spread we're trading on.
interface V3Quote {
  name:        'PancakeV3'
  fee:         number          // pool fee in hundredths of a bp (100 = 0.01%)
  priceBNBPerToken: number     // price implied by quoter at our trade size
}

interface TokenPairs {
  symbol:  string
  address: Address
  pancake: Address | null
  biswap:  Address | null
}

export interface ArbitrageConfig {
  minProfitUSD:       number
  maxGasGwei:         number
  executionAmountUSD: number
  slippageTolerance:  number
  minSpreadPct:       number
  // Optional override of the default whitelist (UI-supplied).
  tokens?: { address: string; symbol: string }[]
  rpcUrl?: string
}

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n
  const amountInWithFee = amountIn * FEE_NUM
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DEN + amountInWithFee)
}

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

export class ArbitrageStrategy {
  private running    = false
  private executing  = false
  private scanned    = 0
  private proxyAddress: Address | null = null
  private bnbPrice   = BNB_PRICE_FALLBACK
  private bnbPriceTimer?: NodeJS.Timeout
  private watcher:   BlockWatcher
  private puissant:  PuissantClient
  private tokenPairs: TokenPairs[] = []
  private lastExecutedBlock = 0n

  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private ws:           WsServer,
    private config:       ArbitrageConfig,
  ) {
    // We don't need to filter by router — we evaluate the whole whitelist
    // every block regardless of what swaps appeared. Pass empty router list.
    this.watcher  = new BlockWatcher(publicClient, [])
    this.puissant = new PuissantClient(walletClient, publicClient)
  }

  async start() {
    if (this.running) return
    this.running = true
    const tokenList = (this.config.tokens?.length ? this.config.tokens : DEFAULT_TOKEN_WHITELIST)
      .map(t => ({ address: getAddress(t.address as `0x${string}`), symbol: t.symbol }))

    console.log(chalk.green(`[Arbitrage] 策略启动 → 监控 ${tokenList.length} 个 token 跨 DEX 价差`))

    try {
      await this.refreshBnbPrice()
      this.bnbPriceTimer = setInterval(() => this.refreshBnbPrice(), 120_000)

      await this.ensureProxy()

      // Resolve every token's pair on both DEXes once. Tokens missing from
      // either DEX are silently dropped — no point scanning them.
      console.log(chalk.dim(`[Arbitrage] 解析交易对 ...`))
      for (const t of tokenList) {
        const [pancake, biswap] = await Promise.all([
          this.lookupPair(DEXES[0].factory, t.address),
          this.lookupPair(DEXES[1].factory, t.address),
        ])
        if (pancake && biswap) {
          this.tokenPairs.push({ symbol: t.symbol, address: t.address, pancake, biswap })
        } else {
          console.log(chalk.dim(`  · ${t.symbol} 跳过 (${!pancake ? '无 Pancake 池' : '无 BiSwap 池'})`))
        }
      }
      if (this.tokenPairs.length === 0) {
        throw new Error('白名单内没有任何 token 同时存在于 Pancake + BiSwap，无法套利')
      }
      console.log(chalk.dim(`[Arbitrage] 已锁定 ${this.tokenPairs.length} 个跨 DEX 对: ${this.tokenPairs.map(t => t.symbol).join(', ')}`))

      this.watcher.onBlock((_swaps, bn) => this.onBlock(bn))
      await this.watcher.start()

      this.ws.broadcast({ type: 'status', payload: { strategy: 'arbitrage', running: true, scanned: 0, pending: 0 } })
    } catch (err: any) {
      this.running = false
      this.watcher.stop()
      if (this.bnbPriceTimer) { clearInterval(this.bnbPriceTimer); this.bnbPriceTimer = undefined }
      this.ws.broadcast({ type: 'status', payload: { strategy: 'arbitrage', running: false, scanned: 0, pending: 0 } })
      const msg = cleanError(err) || String(err?.message ?? err)
      console.error(chalk.red(`[Arbitrage] 启动失败: ${msg}`))
      this.ws.broadcast({ type: 'error', payload: { message: `Arbitrage 启动失败: ${msg}` } })
      throw err
    }
  }

  stop() {
    this.running = false
    this.watcher.stop()
    if (this.bnbPriceTimer) { clearInterval(this.bnbPriceTimer); this.bnbPriceTimer = undefined }
    this.ws.broadcast({ type: 'status', payload: { strategy: 'arbitrage', running: false, scanned: 0, pending: 0 } })
    console.log(chalk.yellow('[Arbitrage] 策略已停止'))
  }

  get isRunning() { return this.running }

  // ── Proxy deployment (shared with sandwich/backrun) ─────────────────────
  private async ensureProxy() {
    const account = this.walletClient.account!
    const cfg     = loadConfig()

    if (cfg.sandwichProxyAddress) {
      const code = await this.publicClient.getBytecode({ address: cfg.sandwichProxyAddress as Address })
      if (code && code !== '0x') {
        this.proxyAddress = cfg.sandwichProxyAddress as Address
        console.log(chalk.dim(`[Arbitrage] 复用代理合约: ${this.proxyAddress}`))
        return
      }
    }

    const balance = await this.publicClient.getBalance({ address: account.address })
    if (balance < parseUnits('0.005', 18)) {
      throw new Error(`部署代理合约需至少 0.005 BNB (当前 ${formatUnits(balance, 18)} BNB)`)
    }

    console.log(chalk.cyan('[Arbitrage] 部署代理合约 ...'))
    const hash = await this.walletClient.deployContract({
      abi: SANDWICH_PROXY_ABI, bytecode: SANDWICH_PROXY_BYTECODE as `0x${string}`,
      account, chain: null, gas: GAS_DEPLOY,
    })
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (!receipt.contractAddress || receipt.status !== 'success') {
      throw new Error('代理合约部署失败')
    }
    this.proxyAddress = getAddress(receipt.contractAddress)
    saveConfig({ ...cfg, sandwichProxyAddress: this.proxyAddress })
    console.log(chalk.green(`[Arbitrage] ✓ 代理合约已部署: ${this.proxyAddress}`))
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
    } catch { /* keep prev */ }
  }

  // Every block: rank all tokens by spread, pick the most profitable, execute.
  // We only execute one bundle per block (nonce contention with ourselves).
  private async onBlock(blockNumber: bigint) {
    if (!this.running || this.executing) return
    if (blockNumber <= this.lastExecutedBlock) return
    this.scanned++

    this.executing = true
    try {
      // Score every token. Picking the best instead of the first profitable
      // one increases capital efficiency at the cost of one extra block of
      // RPC reads per token — fine on a private RPC.
      let best: { token: TokenPairs; buy: PoolState; sell: PoolState; spread: number; netUSD: number } | null = null
      for (const tp of this.tokenPairs) {
        const ev = await this.evaluateToken(tp)
        if (!ev) continue

        // Surface V3-only opportunities (non-executable in this version) so
        // the UI can show users where the real price action is. We tag them
        // with `executable: false` and netProfit: 0 to signal monitor-only.
        if (ev.v3Hint && ev.netUSD < this.config.minProfitUSD &&
            ev.v3Hint.spreadVsBestV2Pct >= this.config.minSpreadPct * 2) {
          this.ws.broadcast({
            type: 'opportunity',
            payload: {
              id: randomUUID(), strategy: 'arbitrage',
              token: `${tp.symbol} [V3@${(ev.v3Hint.fee / 10000).toFixed(2)}%]`,
              tokenAddress: tp.address, chain: 'BSC',
              profitUSD: 0, profitNative: 0, gasUSD: 0, netProfit: 0,
              timestamp: Date.now(), executable: false,
              note: `V3 vs V2 价差 ${ev.v3Hint.spreadVsBestV2Pct.toFixed(2)}% — 当前版本未集成 V3 执行`,
            },
          })
        }

        // V2-V2 executable scoring
        if (ev.netUSD > 0 && (!best || ev.netUSD > best.netUSD)) {
          best = { token: tp, buy: ev.buy, sell: ev.sell, spread: ev.spread, netUSD: ev.netUSD }
        }
      }

      if (best && best.netUSD >= this.config.minProfitUSD) {
        console.log(chalk.cyan(
          `[Arbitrage] ✓ 最佳机会: ${best.token.symbol} | 价差 ${best.spread.toFixed(3)}% | ` +
          `买@${best.buy.name} 卖@${best.sell.name} | 净利 $${best.netUSD.toFixed(2)}`
        ))
        this.lastExecutedBlock = blockNumber
        await this.executeArb(best.token, best.buy, best.sell, best.netUSD)
      }
    } finally {
      this.executing = false
      this.ws.broadcast({
        type: 'status',
        payload: { strategy: 'arbitrage', running: true, scanned: this.scanned, pending: 0 },
      })
    }
  }

  // Returns null if pool data unavailable, spread below threshold, or sized
  // trade unprofitable. Returns full plan if it's a real opportunity.
  // Also detects V3 cross-DEX spreads (read-only; not executed because the
  // proxy targets V2 routers).
  private async evaluateToken(tp: TokenPairs): Promise<{
    buy: PoolState; sell: PoolState; spread: number; netUSD: number;
    amountIn: bigint; minFrontOut: bigint; minBackOut: bigint;
    v3Hint?: { fee: number; priceBNBPerToken: number; spreadVsBestV2Pct: number };
  } | null> {
    if (!tp.pancake || !tp.biswap) return null

    const [poolA, poolB] = await Promise.all([
      this.loadPool('PancakeSwap', tp.pancake, DEXES[0].router),
      this.loadPool('BiSwap',      tp.biswap,  DEXES[1].router),
    ])
    if (!poolA || !poolB) return null

    const priceA = Number(poolA.reserveBNB) / Number(poolA.reserveToken)
    const priceB = Number(poolB.reserveBNB) / Number(poolB.reserveToken)
    const minP   = Math.min(priceA, priceB)
    const maxP   = Math.max(priceA, priceB)
    const spread = ((maxP - minP) / minP) * 100

    // Size the would-be trade.
    const buy  = priceA < priceB ? poolA : poolB
    const sell = priceA < priceB ? poolB : poolA
    const budgetBNB = this.config.executionAmountUSD / this.bnbPrice
    const maxByImpactBNB = Number(formatEther(buy.reserveBNB)) * 0.005
    const sizeBNB = Math.min(budgetBNB, maxByImpactBNB)
    if (sizeBNB <= 0.001) return null
    const amountIn = parseUnits(sizeBNB.toFixed(6), 18)

    // Probe V3 in parallel with the V2 calc, only if either V2 looks
    // interesting at all OR we want a sanity check. We do it unconditionally
    // here so the UI gets a complete cross-DEX picture; cost is one
    // multicall per token per block, which is cheap.
    const v3 = await this.loadV3Quote(tp.address, amountIn, 'buy').catch(() => null)
    let v3Hint: { fee: number; priceBNBPerToken: number; spreadVsBestV2Pct: number } | undefined
    if (v3) {
      const bestV2 = Math.min(priceA, priceB)
      const spreadV3 = Math.abs(v3.priceBNBPerToken - bestV2) / Math.min(v3.priceBNBPerToken, bestV2) * 100
      v3Hint = { fee: v3.fee, priceBNBPerToken: v3.priceBNBPerToken, spreadVsBestV2Pct: spreadV3 }
    }

    if (spread < this.config.minSpreadPct) {
      // No V2/V2 spread — but if V3 vs best V2 is meaningfully different we
      // still surface it so the UI can show the user where price is moving.
      if (v3Hint && v3Hint.spreadVsBestV2Pct >= this.config.minSpreadPct * 2) {
        return {
          buy, sell, spread: v3Hint.spreadVsBestV2Pct,
          netUSD: 0,                  // not executable, no claim of profit
          amountIn, minFrontOut: 0n, minBackOut: 0n, v3Hint,
        }
      }
      return null
    }

    const tokenOut = getAmountOut(amountIn,   buy.reserveBNB,  buy.reserveToken)
    if (tokenOut === 0n) return null
    const bnbOut   = getAmountOut(tokenOut, sell.reserveToken, sell.reserveBNB)

    const profitBNB = Number(formatEther(bnbOut)) - sizeBNB

    // Respect user's slider — clamping to a floor of 1 Gwei so we don't
    // submit a tx that gets ignored. Previously this was hardcoded at 5
    // which silently overrode anything the user set on the page.
    const gasPriceWei = parseUnits(String(Math.max(this.config.maxGasGwei, 1)), 9)
    const gasCostBNB  = Number(formatEther((GAS_FRONTRUN + GAS_BACKRUN) * gasPriceWei))
    const gasCostUSD  = gasCostBNB * this.bnbPrice
    const netUSD = profitBNB * this.bnbPrice - gasCostUSD

    const slip = this.config.slippageTolerance / 100
    const minFrontOut = tokenOut * BigInt(Math.floor((1 - slip)     * 10000)) / 10000n
    const minBackOut  = bnbOut   * BigInt(Math.floor((1 - slip * 2) * 10000)) / 10000n

    return { buy, sell, spread, netUSD, amountIn, minFrontOut, minBackOut, v3Hint }
  }

  // Probe Pancake V3 for the best price across all fee tiers. We try each
  // tier in parallel and pick the highest amountOut. Tiers without an
  // initialised pool revert; we silently filter those.
  //
  // sqrtPriceLimitX96=0 means "no price limit" — quoter returns the natural
  // result given current liquidity. The quoter's amountOut already accounts
  // for the pool fee, so the implied price is the after-fee execution price.
  private async loadV3Quote(token: Address, sizeBNB: bigint, direction: 'buy' | 'sell'): Promise<V3Quote | null> {
    // For the BUY side: in=WBNB, out=token, sizeBNB is BNB amount.
    // For the SELL side: in=token, out=WBNB. We don't currently call this for
    // sell — kept symmetric in case we expand. For our "best price" purpose,
    // buy-side is sufficient since price discovery is the same in both.
    const tokenIn  = direction === 'buy' ? WBNB  : token
    const tokenOut = direction === 'buy' ? token : WBNB

    const probes = await Promise.allSettled(
      V3_FEE_TIERS.map(fee => this.publicClient.readContract({
        address: V3_QUOTER, abi: V3_QUOTER_ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn: sizeBNB, fee, sqrtPriceLimitX96: 0n }],
      }) as Promise<readonly [bigint, bigint, number, bigint]>)
    )
    let best: V3Quote | null = null
    for (let i = 0; i < probes.length; i++) {
      const r = probes[i]
      if (r.status !== 'fulfilled') continue
      const amountOut = r.value[0]
      if (amountOut === 0n) continue
      // Implied price (BNB per token) at our trade size.
      const price = direction === 'buy'
        ? Number(formatEther(sizeBNB)) / Number(formatUnits(amountOut, 18))
        : Number(formatEther(amountOut)) / Number(formatUnits(sizeBNB, 18))
      if (!Number.isFinite(price) || price <= 0) continue
      if (!best || price < best.priceBNBPerToken) {
        // For the buy direction, lower BNB-per-token = better price.
        best = { name: 'PancakeV3', fee: V3_FEE_TIERS[i], priceBNBPerToken: price }
      }
    }
    return best
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

  // Re-evaluate at execution time and submit the bundle. We re-run the
  // simulator inline because reserves can drift in the milliseconds between
  // ranking and execution; using stale numbers would let us submit a bundle
  // that the relay then drops as unprofitable.
  private async executeArb(
    tp: TokenPairs, _buy: PoolState, _sell: PoolState, _expectedUSD: number
  ) {
    if (!this.running || !this.proxyAddress) return
    const ev = await this.evaluateToken(tp)
    if (!ev) return

    const id      = randomUUID()
    const account = this.walletClient.account!
    const proxy   = this.proxyAddress
    const tokenAd = tp.address

    try {
      const balanceBefore = await this.publicClient.getBalance({ address: account.address })
      const nonce = await this.publicClient.getTransactionCount({
        address: account.address, blockTag: 'pending',
      })

      const gasPriceWei = parseUnits(String(Math.max(this.config.maxGasGwei, 1)), 9)

      const frontData = encodeFunctionData({
        abi: SANDWICH_PROXY_ABI, functionName: 'frontrun',
        args: [ev.buy.router, tokenAd, WBNB, ev.minFrontOut],
      })
      const frontTx: PuissantTx = {
        to: proxy, data: frontData, value: ev.amountIn,
        gas: GAS_FRONTRUN, gasPrice: gasPriceWei, nonce,
      }

      const backData = encodeFunctionData({
        abi: SANDWICH_PROXY_ABI, functionName: 'backrun',
        args: [ev.sell.router, tokenAd, WBNB, ev.minBackOut],
      })
      const backTx: PuissantTx = {
        to: proxy, data: backData, value: 0n,
        gas: GAS_BACKRUN, gasPrice: gasPriceWei, nonce: nonce + 1,
      }

      console.log(chalk.cyan(
        `[Arbitrage] → 提交 bundle: ${tp.symbol} buy@${ev.buy.name} sell@${ev.sell.name}, 规模 ${formatEther(ev.amountIn)} BNB`
      ))

      this.ws.broadcast({
        type: 'opportunity',
        payload: {
          id, strategy: 'arbitrage',
          token: tp.symbol, tokenAddress: tp.address,
          chain: 'BSC',
          profitUSD: ev.netUSD, profitNative: ev.netUSD / this.bnbPrice,
          gasUSD: 0, netProfit: ev.netUSD, timestamp: Date.now(),
        },
      })

      const result = await this.puissant.submitBundle([frontTx, backTx], {
        ttlSeconds: 30, acceptRevertingHashes: [],
      })
      logBundleResult(`Arbitrage bundle #${id.slice(0, 6)}`, result)

      if (!result.ok) {
        this.recordFailed(id, tp.symbol, result.error ?? 'relay 未返回详细错误')
        return
      }

      // ── CRITICAL: relay-accept ≠ on-chain inclusion ────────────────────────
      // Puissant returns ok=true once the bundle is queued for distribution
      // to validators. The bundle still needs to actually be included in a
      // block — many get dropped (lost the gas race, validator picked someone
      // else's bundle, etc.). We MUST wait for receipt before declaring
      // success, otherwise:
      //   1. dropped bundles record as "$0 success" (clutter / fake stats),
      //   2. balance-delta during the wait window picks up profits from
      //      OTHER concurrent strategies on the same wallet and falsely
      //      attributes them to arbitrage ("phantom earnings" bug).
      const [frontHash, backHash] = (result.txHashes ?? []) as [`0x${string}`?, `0x${string}`?]
      if (!backHash) {
        this.recordMissed(id, tp.symbol, 'relay 未返回 tx hash')
        return
      }
      try {
        const backR = await this.publicClient.waitForTransactionReceipt({
          hash: backHash, timeout: 45_000,
        })
        if (backR.status !== 'success') {
          this.recordFailed(id, tp.symbol, '后跑链上回滚')
          return
        }
      } catch {
        // Timeout — bundle was relay-accepted but never mined. Not a real
        // trade. No gas spent (acceptReverting: []), so log as missed.
        console.log(chalk.dim(`[Arbitrage] bundle 未被打包 (输给竞争 / 已过期) ${tp.symbol}`))
        this.recordMissed(id, tp.symbol, '未被打包')
        return
      }

      const balanceAfter = await this.publicClient.getBalance({ address: account.address })
      const diffBNB      = Number(formatEther(balanceAfter - balanceBefore))
      const actualUSD    = diffBNB * this.bnbPrice

      // Sanity guard: if the balance literally didn't move we shouldn't
      // record a "success $0" — something else is off (race with another
      // strategy clearing the delta, RPC stale read, etc.).
      if (Math.abs(diffBNB) < 1e-9) {
        this.recordMissed(id, tp.symbol, '余额无变化')
        return
      }

      const trade = {
        id, strategy: 'arbitrage', token: tp.symbol,
        txHash: backHash, chain: 'BSC',
        profitUSD: actualUSD, gasUSD: 0,
        status: actualUSD > 0 ? 'success' as const : 'failed' as const,
        timestamp: Date.now(),
      }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })

      if (actualUSD > 0) {
        console.log(chalk.green(`[Arbitrage] ✓ 套利完成 ${tp.symbol} +$${actualUSD.toFixed(2)} | ${backHash}`))
      } else {
        console.log(chalk.yellow(`[Arbitrage] 套利亏损 ${tp.symbol} $${actualUSD.toFixed(2)} | ${backHash}`))
      }
    } catch (err: any) {
      this.recordFailed(id, tp.symbol, cleanError(err))
    }
  }

  private recordFailed(id: string, symbol: string, reason: string) {
    console.error(chalk.red(`[Arbitrage] ✗ 失败: ${reason}`))
    const trade = {
      id, strategy: 'arbitrage', token: symbol, txHash: '',
      chain: 'BSC', profitUSD: 0, gasUSD: 0,
      status: 'failed' as const, timestamp: Date.now(),
    }
    saveTrade(trade)
    this.ws.broadcast({ type: 'trade', payload: trade })
  }

  // Bundle was relay-accepted but never mined (lost gas race / TTL expired).
  // No gas spent — we don't record a trade at all, just log it for stats.
  // Saving as "failed" would inflate the failure count with non-events.
  private recordMissed(_id: string, symbol: string, reason: string) {
    console.log(chalk.dim(`[Arbitrage] 略过 ${symbol}: ${reason}`))
  }
}
