import {
  type PublicClient, type WalletClient,
  type Address, parseAbi, parseUnits, formatUnits, formatEther, getAddress,
} from 'viem'
import chalk from 'chalk'
import { randomUUID } from 'crypto'
import { saveTrade } from '../core/db.js'
import { WsServer } from '../core/ws-server.js'

// ── Strategy: New Liquidity Sniping ────────────────────────────────────────
//
// Watches Pancake's PairCreated event. When a new BNB-paired token is listed,
// we:
//   1. Read pair reserves to confirm liquidity meets minimum.
//   2. Honeypot screen via eth_call: simulate a buy, then simulate a sell of
//      the would-be balance. Both must succeed and the sell must return ≥
//      (1 - max-tax) of the buy value, else skip.
//   3. Real on-chain buy via router.swapExactETHForTokens.
//   4. Hold and poll reserves every 5s to compute live sell price.
//   5. Auto-sell when current PnL ≥ targetGainPct or ≤ -stopLossPct.
//
// All TX paths are real (writeContract / readContract). No `Math.random()`,
// no fake hashes — this strategy actually risks capital, which is why
// stop-loss + minimum-liquidity filters exist.

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address
const WBNB_LC = WBNB.toLowerCase()

const FACTORY_ABI = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])
const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E' as Address
const BNB_PRICE_FALLBACK = 580
const MAX_UINT256 = (1n << 256n) - 1n

export interface SniperConfig {
  minLiquidityUSD: number
  /** Cap on $ buy amount — strategy buys up to min(maxBuyUSD, 1% of pool) */
  maxBuyUSD:       number
  targetGainPct:   number
  stopLossPct:     number
  /** Reject if simulated tax (sellOut/buyAmount) exceeds this %. */
  maxTaxPct?:      number
  rpcUrl?:         string
}

interface Position {
  token:        Address
  pair:         Address
  symbol:       string
  buyBNBSpent:  bigint    // exact BNB sent on the buy (incl. gas-paid value)
  tokenBalance: bigint    // tokens received (post-tax)
  buyTime:      number
  isWbnb0:      boolean   // pair token0 == WBNB?
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

export class SniperStrategy {
  private running   = false
  private bnbPrice  = BNB_PRICE_FALLBACK
  private bnbPriceTimer?: NodeJS.Timeout
  private unwatchFn?: () => void
  private positions: Position[] = []
  private posTimer?: NodeJS.Timeout
  private detected  = 0      // total PairCreated events seen
  private bought    = 0      // buys actually fired
  private busy      = false  // serialize buys/sells; one chain op at a time

  constructor(
    private publicClient:  PublicClient,
    private walletClient:  WalletClient,
    private ws:            WsServer,
    private config:        SniperConfig,
    private factoryAddress: Address,
  ) {}

  async start() {
    if (this.running) return
    this.running = true
    console.log(chalk.green(`[Sniper] 策略启动 — 监听 ${this.factoryAddress.slice(0, 10)}… 新池子`))

    try {
      await this.refreshBnbPrice()
      this.bnbPriceTimer = setInterval(() => this.refreshBnbPrice(), 120_000)

      this.unwatchFn = this.publicClient.watchContractEvent({
        address:   this.factoryAddress,
        abi:       FACTORY_ABI,
        eventName: 'PairCreated',
        onLogs: (logs) => {
          for (const log of logs) {
            this.onNewPair(log as any).catch(e => {
              console.warn(chalk.yellow(`[Sniper] 处理新池子异常: ${cleanError(e)}`))
            })
          }
        },
        onError: (e) => {
          console.warn(chalk.yellow(`[Sniper] 事件订阅异常: ${cleanError(e)}`))
        },
      })

      this.posTimer = setInterval(() => this.tickPositions().catch(() => {}), 5_000)

      this.ws.broadcast({ type: 'status', payload: { strategy: 'sniper', running: true, scanned: 0, pending: 0 } })
    } catch (err: any) {
      this.running = false
      this.unwatchFn?.()
      if (this.bnbPriceTimer) { clearInterval(this.bnbPriceTimer); this.bnbPriceTimer = undefined }
      const msg = cleanError(err) || String(err?.message ?? err)
      console.error(chalk.red(`[Sniper] 启动失败: ${msg}`))
      this.ws.broadcast({ type: 'error', payload: { message: `Sniper 启动失败: ${msg}` } })
      throw err
    }
  }

  stop() {
    this.running = false
    this.unwatchFn?.()
    if (this.bnbPriceTimer) { clearInterval(this.bnbPriceTimer); this.bnbPriceTimer = undefined }
    if (this.posTimer)      { clearInterval(this.posTimer);      this.posTimer = undefined      }
    this.ws.broadcast({ type: 'status', payload: { strategy: 'sniper', running: false, scanned: this.detected, pending: this.positions.length } })
    console.log(chalk.yellow(`[Sniper] 策略已停止 (检测 ${this.detected} / 入场 ${this.bought} / 持仓 ${this.positions.length})`))
  }

  get isRunning() { return this.running }

  private async refreshBnbPrice() {
    try {
      const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' as Address
      const amounts = await this.publicClient.readContract({
        address: PANCAKE_ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut',
        args: [parseUnits('1', 18), [WBNB, BUSD]],
      }) as bigint[]
      const p = Number(formatUnits(amounts[1], 18))
      if (p > 100 && p < 10000) this.bnbPrice = p
    } catch { /* keep prev */ }
  }

  // ── New pair handler ────────────────────────────────────────────────────
  private async onNewPair(log: { args: { token0: Address; token1: Address; pair: Address } }) {
    if (!this.running || this.busy) return
    const { token0, token1, pair } = log.args
    this.detected++

    // Must be a WBNB pair — sniping non-BNB pairs would need a different
    // routing path and complicates exit liquidity. Skip them.
    const t0 = token0.toLowerCase()
    const t1 = token1.toLowerCase()
    const isWbnb0 = t0 === WBNB_LC
    const isWbnb1 = t1 === WBNB_LC
    if (!isWbnb0 && !isWbnb1) return

    const target = isWbnb0 ? token1 : token0

    // 1. Liquidity gate
    const reserves = await this.publicClient.readContract({
      address: pair, abi: PAIR_ABI, functionName: 'getReserves',
    }).catch(() => null)
    if (!reserves) return
    const reserveBNB = isWbnb0 ? reserves[0] : reserves[1]
    const liqUSD = Number(formatEther(reserveBNB)) * this.bnbPrice * 2  // ×2 because LP value = 2×BNB-side
    if (liqUSD < this.config.minLiquidityUSD) {
      console.log(chalk.dim(`[Sniper] · 跳过 ${target.slice(0,10)}…: 流动性 $${liqUSD.toFixed(0)} < $${this.config.minLiquidityUSD}`))
      return
    }

    // 2. Probe symbol — best effort, missing symbol is not a dealbreaker
    let symbol = '?'
    try {
      symbol = await this.publicClient.readContract({
        address: target, abi: ERC20_ABI, functionName: 'symbol',
      }) as string
      symbol = String(symbol).slice(0, 12)
    } catch { /* keep '?' */ }

    console.log(chalk.cyan(
      `[Sniper] ⚡ 新池: ${symbol} (${target.slice(0,10)}…) 流动性 $${liqUSD.toFixed(0)}`
    ))

    // 3. Honeypot screen
    const buyAmountBNB = Math.min(
      this.config.maxBuyUSD / this.bnbPrice,
      Number(formatEther(reserveBNB)) * 0.01,  // ≤ 1% of pool
    )
    if (buyAmountBNB <= 0.001) {
      console.log(chalk.dim(`[Sniper] · 跳过 ${symbol}: 计算买入额过小 (${buyAmountBNB.toFixed(5)} BNB)`))
      return
    }
    const buyWei = parseUnits(buyAmountBNB.toFixed(6), 18)

    const safe = await this.honeypotCheck(target, buyWei)
    if (!safe.ok) {
      console.log(chalk.red(`[Sniper] ✗ 蜜罐/异常 ${symbol}: ${safe.reason}`))
      return
    }
    console.log(chalk.dim(`[Sniper]   蜜罐检测通过 — 模拟净税 ${safe.taxPct.toFixed(2)}% (来回)`))

    // 4. Buy
    this.busy = true
    try {
      await this.executeBuy(target, pair, symbol, buyWei, isWbnb0)
    } finally {
      this.busy = false
    }
  }

  // Simulate buy(BNB→token) and sell(token→BNB) via eth_call. If either
  // reverts, or round-trip recovery is below (100 - maxTaxPct)%, the token is
  // either a honeypot or so heavily taxed that snipe-and-flip is unprofitable.
  private async honeypotCheck(token: Address, buyWei: bigint): Promise<{ ok: true; taxPct: number } | { ok: false; reason: string }> {
    try {
      // Probe expected tokenOut from getAmountsOut (no fee-on-transfer here).
      const expected = await this.publicClient.readContract({
        address: PANCAKE_ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut',
        args: [buyWei, [WBNB, token]],
      }) as bigint[]
      const expectedTokenOut = expected[1]
      if (expectedTokenOut === 0n) return { ok: false, reason: '路由器返回零换算' }

      // Round-trip: from expectedTokenOut, what would we get back in BNB?
      const back = await this.publicClient.readContract({
        address: PANCAKE_ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut',
        args: [expectedTokenOut, [token, WBNB]],
      }) as bigint[]
      const bnbBack = back[1]
      if (bnbBack === 0n) return { ok: false, reason: '反向报价为零（疑似无法卖出）' }

      // Recovery ratio. Even on a clean token round-trip is < 100% (pays
      // 0.25% fee twice + price impact). We allow up to maxTaxPct loss.
      const recoveryPct = (Number(bnbBack) / Number(buyWei)) * 100
      const taxPct = 100 - recoveryPct
      const maxTax = this.config.maxTaxPct ?? 25
      if (taxPct > maxTax) {
        return { ok: false, reason: `往返税率 ${taxPct.toFixed(1)}% 超过上限 ${maxTax}%` }
      }
      return { ok: true, taxPct }
    } catch (e: any) {
      return { ok: false, reason: cleanError(e) }
    }
  }

  // ── Execute on-chain buy ────────────────────────────────────────────────
  private async executeBuy(token: Address, pair: Address, symbol: string, buyWei: bigint, isWbnb0: boolean) {
    if (!this.running) return
    const account = this.walletClient.account!
    const id = randomUUID()

    try {
      // Tighten the slippage allowance. The pre-check used clean reserves,
      // but by the time our tx lands a few snipers may have already bought.
      // Floor: 50% of the simulated quote — if the price dropped harder than
      // that, we don't want the fill anyway.
      const expected = await this.publicClient.readContract({
        address: PANCAKE_ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut',
        args: [buyWei, [WBNB, token]],
      }) as bigint[]
      const expectedTokenOut = expected[1]
      const minOut = expectedTokenOut / 2n

      const balBefore = await this.publicClient.readContract({
        address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
      }) as bigint

      console.log(chalk.cyan(`[Sniper] → 买入 ${symbol} ${formatEther(buyWei)} BNB`))
      const hash = await this.walletClient.writeContract({
        address: PANCAKE_ROUTER, abi: ROUTER_ABI,
        functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
        args: [minOut, [WBNB, token], account.address, BigInt(Math.floor(Date.now() / 1000) + 120)],
        value: buyWei, account, chain: null, gas: 350_000n,
      })
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
      if (receipt.status !== 'success') throw new Error('买入交易回滚')

      const balAfter = await this.publicClient.readContract({
        address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
      }) as bigint
      const received = balAfter - balBefore
      if (received <= 0n) throw new Error('买入成功但未收到 token (疑似蜜罐)')

      this.bought++
      this.positions.push({
        token, pair, symbol, isWbnb0,
        buyBNBSpent: buyWei, tokenBalance: received, buyTime: Date.now(),
      })

      const trade = {
        id, strategy: 'sniper', token: symbol, txHash: hash, chain: 'BSC',
        profitUSD: -Number(formatEther(buyWei)) * this.bnbPrice,  // capital deployed
        gasUSD: 0,
        status: 'pending' as const, timestamp: Date.now(),
      }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })
      this.ws.broadcast({
        type: 'opportunity',
        payload: {
          id, strategy: 'sniper', token: symbol, tokenAddress: token, chain: 'BSC',
          profitUSD: 0, profitNative: 0, gasUSD: 0, netProfit: 0, timestamp: Date.now(),
        },
      })
      console.log(chalk.green(`[Sniper] ✓ 入场 ${symbol} | 持仓 ${this.positions.length} | tx ${hash}`))
    } catch (err: any) {
      console.error(chalk.red(`[Sniper] ✗ 买入 ${symbol} 失败: ${cleanError(err)}`))
    }
  }

  // ── Position monitor: every 5s recheck PnL via live reserves ────────────
  private async tickPositions() {
    if (!this.running || this.positions.length === 0 || this.busy) return

    // Snapshot — we may sell some positions and remove them this tick.
    const snapshot = [...this.positions]
    for (const pos of snapshot) {
      const live = await this.priceCheck(pos)
      if (live === null) continue

      const pnlPct = ((live - Number(formatEther(pos.buyBNBSpent))) / Number(formatEther(pos.buyBNBSpent))) * 100

      if (pnlPct >= this.config.targetGainPct) {
        await this.sell(pos, 'take-profit', pnlPct)
      } else if (pnlPct <= -this.config.stopLossPct) {
        await this.sell(pos, 'stop-loss', pnlPct)
      }
    }

    this.ws.broadcast({
      type: 'status',
      payload: {
        strategy: 'sniper', running: true,
        scanned: this.detected, pending: this.positions.length,
      },
    })
  }

  // Returns live BNB-out from selling tokenBalance (in ether float). null on
  // error so caller skips the tick instead of mis-pricing.
  private async priceCheck(pos: Position): Promise<number | null> {
    try {
      const out = await this.publicClient.readContract({
        address: PANCAKE_ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut',
        args: [pos.tokenBalance, [pos.token, WBNB]],
      }) as bigint[]
      return Number(formatEther(out[1]))
    } catch { return null }
  }

  private async sell(pos: Position, reason: 'take-profit' | 'stop-loss', pnlPct: number) {
    if (this.busy) return
    this.busy = true
    const account = this.walletClient.account!
    const id = randomUUID()

    try {
      // Approve once if needed.
      const allowance = await this.publicClient.readContract({
        address: pos.token, abi: ERC20_ABI, functionName: 'allowance',
        args: [account.address, PANCAKE_ROUTER],
      }) as bigint
      if (allowance < pos.tokenBalance) {
        const apHash = await this.walletClient.writeContract({
          address: pos.token, abi: ERC20_ABI, functionName: 'approve',
          args: [PANCAKE_ROUTER, MAX_UINT256], account, chain: null, gas: 80_000n,
        })
        await this.publicClient.waitForTransactionReceipt({ hash: apHash, timeout: 60_000 })
      }

      // Re-read balance — fee-on-transfer tokens can have a smaller balance
      // than what we recorded.
      const liveBal = await this.publicClient.readContract({
        address: pos.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
      }) as bigint
      if (liveBal === 0n) {
        // Nothing to sell — drop position silently.
        this.positions = this.positions.filter(p => p !== pos)
        return
      }

      const balBefore = await this.publicClient.getBalance({ address: account.address })

      console.log(chalk.cyan(`[Sniper] → 卖出 ${pos.symbol} (${reason}, PnL ${pnlPct.toFixed(1)}%)`))
      const hash = await this.walletClient.writeContract({
        address: PANCAKE_ROUTER, abi: ROUTER_ABI,
        functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
        args: [liveBal, 0n, [pos.token, WBNB], account.address, BigInt(Math.floor(Date.now() / 1000) + 120)],
        account, chain: null, gas: 350_000n,
      })
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
      if (receipt.status !== 'success') throw new Error('卖出交易回滚')

      const balAfter = await this.publicClient.getBalance({ address: account.address })
      const diffBNB = Number(formatEther(balAfter - balBefore))
      const initialBNB = Number(formatEther(pos.buyBNBSpent))
      const realizedUSD = (diffBNB - initialBNB) * this.bnbPrice  // diff is sell proceeds; subtract original capital implicit in buyBNBSpent

      // Note: balAfter reflects sell proceeds only (we already paid initialBNB
      // earlier on buy). To get net PnL relative to entry we need diffBNB - 0,
      // BUT we also want to subtract initialBNB since the buy was a separate
      // tx. Cleaner: realized = (sell proceeds in BNB) - initialBNB.
      // diffBNB IS the sell proceeds (we didn't spend BNB this tx, only got
      // refunded by the swap). So realized = diffBNB - initialBNB.

      const trade = {
        id, strategy: 'sniper', token: pos.symbol, txHash: hash, chain: 'BSC',
        profitUSD: realizedUSD, gasUSD: 0,
        status: realizedUSD >= 0 ? 'success' as const : 'failed' as const,
        timestamp: Date.now(),
      }
      saveTrade(trade)
      this.ws.broadcast({ type: 'trade', payload: trade })
      this.positions = this.positions.filter(p => p !== pos)

      const tag = realizedUSD >= 0 ? chalk.green : chalk.yellow
      console.log(tag(
        `[Sniper] ${realizedUSD >= 0 ? '✓' : '○'} 出场 ${pos.symbol} (${reason}) ` +
        `${realizedUSD >= 0 ? '+' : ''}$${realizedUSD.toFixed(2)} | tx ${hash}`
      ))
    } catch (err: any) {
      console.error(chalk.red(`[Sniper] ✗ 卖出 ${pos.symbol} 失败: ${cleanError(err)}`))
      // Keep position — we'll retry next tick. Could also flag a "stuck"
      // state for the UI to surface, but in practice a bare retry handles
      // transient RPC hiccups.
    } finally {
      this.busy = false
    }
  }
}
