import {
  type PublicClient,
  parseAbi,
  formatUnits,
  type Address,
  encodeFunctionData,
} from 'viem'
import chalk from 'chalk'

const FACTORY_ABI = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256 index) view returns (address)',
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
])

const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external',
])

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' as Address
const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address
const DEAD = '0x000000000000000000000000000000000000dead'
const ZERO = '0x0000000000000000000000000000000000000000'
const BASE_TOKENS = new Set([WBNB.toLowerCase(), BUSD.toLowerCase(), USDT.toLowerCase()])

// Known LP locker contracts (trust these holding LP = locked)
const LP_LOCKERS = new Set([
  '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe', // PinkLock
  '0x71b5759d73262fbb223956913ecf4ecc51057641', // Unicrypt
  '0xc765bddb93b0d1c1a88282ba0fa6b2d00e3e0c83', // DxSale
  '0x7ee058420e5937496f5a2096f04caa7721cf70cc', // Mudra
  DEAD.toLowerCase(),
  ZERO.toLowerCase(),
])

export interface ScannedToken {
  address: string
  symbol: string
  name: string
  chain: string
  liquidity: number
  volume24h: number
  score: number
  dex: string
  pairAddress: string
  price: number
  priceUSD: number
  // Safety fields
  safetyScore: number           // 0-100 (higher = safer)
  isHoneypot: boolean
  buyTax: number                // %
  sellTax: number               // %
  ownerRenounced: boolean
  lpLocked: boolean
  flags: string[]               // human-readable risk warnings
}

export interface PriceQuote {
  dex: string
  router: Address
  price: number
  priceUSD: number
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

// High-liquidity seed pairs always included
const SEED_PAIRS: Address[] = [
  '0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16',
  '0x61EB789d75A95CAa3fF50ed7E47b96c132fEc082',
  '0x74E4716E431f45807DCF19f284c7aA99F18a4fbc',
  '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0',
  '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
  '0x7EFaEf62fDdCCa950418312c6C702547502517a3',
  '0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b',
  '0xBA51D1AB95756ca4eaB8197eab5335D406F0E6e3',
  '0xbCD62661A6b1DEd703585d3aF7d7649Ef621861b',
  '0xA39Af17CE4a8eb807E076805Da1e2B8EA7D0755b',
  '0xc15fa3E22c912A276550F3E5FE3b0Deb87B55aCd',
  '0x2354ef4DF11afacb85a5C7f98B624072ECcddbB1',
  '0xf3047c77154fe608edd9e35d3e5af05da83ac8cd',
  '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
  '0x326D754c64329aD7cb35744770D56D0E1f3B3124',
  '0x0392957571F28037607C14832D16f8B653eDd472',
  '0x36b8b28D37f93372188F2aa2507b68A5CD8B2664',
  '0x3f0A9aB940df9aDE65A23A76FFC0b1Dca937a27c',
  '0x20bcc3b8a0091ddac2d0bc30f68e6cbb97de59cd',
  '0x824eb9faDFb377394430d2744fa7C42916DE3eCe',
]

export class OnChainScanner {
  constructor(
    private client: PublicClient,
    private factoryAddress: Address,
    private routerAddress: Address,
    private dexName: string,
    private bnbPriceUSD: number = 580
  ) {}

  async scanTopPairs(limit = 24): Promise<ScannedToken[]> {
    console.log(chalk.cyan(`[Scanner] 扫描 ${this.dexName} 优质交易对...`))

    // ── Dynamic sampling via multicall ──────────────────────────────
    let dynamicPairs: Address[] = []
    try {
      const totalRaw = await withTimeout(
        this.client.readContract({ address: this.factoryAddress, abi: FACTORY_ABI, functionName: 'allPairsLength' }),
        12000
      )
      if (totalRaw != null) {
        const total = Number(totalRaw)
        const sampleSize = 80
        const searchDepth = Math.min(total, 5000)
        const indicesSet = new Set<number>()
        while (indicesSet.size < sampleSize) {
          indicesSet.add(total - 1 - Math.floor(Math.random() * searchDepth))
        }
        const results = await withTimeout(
          this.client.multicall({
            contracts: [...indicesSet].map((i) => ({
              address: this.factoryAddress, abi: FACTORY_ABI,
              functionName: 'allPairs' as const, args: [BigInt(i)] as [bigint],
            })),
            allowFailure: true,
          }), 15000
        )
        if (results) {
          dynamicPairs = results.filter(r => r.status === 'success').map(r => r.result as Address)
          console.log(chalk.dim(`[Scanner] 动态采样 ${dynamicPairs.length} 个交易对`))
        }
      } else {
        console.warn(chalk.yellow('[Scanner] allPairsLength 超时，使用预设列表'))
      }
    } catch (e: any) {
      console.warn(chalk.yellow('[Scanner] 动态采样失败:'), e.message?.slice(0, 60))
    }

    const allPairs = [...new Set([...SEED_PAIRS, ...dynamicPairs])]
    console.log(chalk.dim(`[Scanner] 分析 ${allPairs.length} 个交易对 (含合约安全检测)...`))

    // ── Analyze in batches ──────────────────────────────────────────
    const BATCH = 12  // smaller batches to avoid RPC rate limit (safety checks are heavier)
    const analyzed: ScannedToken[] = []
    for (let i = 0; i < allPairs.length; i += BATCH) {
      const batch = allPairs.slice(i, i + BATCH)
      const results = await Promise.allSettled(batch.map((addr) => this.analyzePair(addr)))
      results.forEach((r) => {
        if (r.status === 'fulfilled' && r.value) analyzed.push(r.value)
      })
    }

    // ── Sort: safety first, then combined score ──────────────────────
    const tokens = analyzed
      .filter(t => !t.isHoneypot)        // always remove confirmed honeypots
      .sort((a, b) => {
        // Safety-weighted score: safetyScore × 0.4 + activityScore × 0.6
        const scoreA = a.safetyScore * 0.4 + a.score * 0.6
        const scoreB = b.safetyScore * 0.4 + b.score * 0.6
        return scoreB - scoreA
      })
      .slice(0, limit)

    const honeypots = analyzed.filter(t => t.isHoneypot).length
    console.log(chalk.green(`[Scanner] 完成: ${tokens.length} 个优质代币 | 过滤貔貅 ${honeypots} 个`))
    return tokens
  }

  private async analyzePair(pairAddress: Address): Promise<ScannedToken | null> {
    try {
      const [token0, token1, reserves] = await Promise.all([
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token0' }),
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token1' }),
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves' }),
      ])

      const isToken0Base = BASE_TOKENS.has(token0.toLowerCase())
      const isToken1Base = BASE_TOKENS.has(token1.toLowerCase())
      if (!isToken0Base && !isToken1Base) return null

      const targetToken = isToken0Base ? token1 : token0
      const baseToken  = isToken0Base ? token0 : token1
      const baseReserve   = isToken0Base ? reserves[0] : reserves[1]
      const targetReserve = isToken0Base ? reserves[1] : reserves[0]

      const [symbol, name, decimals] = await Promise.all([
        this.client.readContract({ address: targetToken, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        this.client.readContract({ address: targetToken, abi: ERC20_ABI, functionName: 'name'   }).catch(() => 'Unknown'),
        this.client.readContract({ address: targetToken, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ])

      const isWBNB = baseToken.toLowerCase() === WBNB.toLowerCase()
      const baseReserveNum   = Number(formatUnits(baseReserve, 18))
      const targetReserveNum = Number(formatUnits(targetReserve, Number(decimals)))
      const liquidityUSD     = isWBNB ? baseReserveNum * this.bnbPriceUSD * 2 : baseReserveNum * 2
      if (liquidityUSD < 5000) return null

      const price    = targetReserveNum > 0 ? baseReserveNum / targetReserveNum : 0
      const priceUSD = isWBNB ? price * this.bnbPriceUSD : price

      // ── Activity score from blockTimestampLast ───────────────────────
      // More recent lastSwap time = more active
      const lastSwapTs  = Number(reserves[2])
      const nowTs       = Math.floor(Date.now() / 1000)
      const minutesAgo  = (nowTs - lastSwapTs) / 60
      const activityScore = minutesAgo < 5   ? 100
                          : minutesAgo < 30  ? 85
                          : minutesAgo < 120 ? 65
                          : minutesAgo < 480 ? 40
                          : 15

      // ── Estimate 24h volume from reserve turnover ────────────────────
      // Rough heuristic: activity level × liquidity × turnover factor
      const turnoverFactor = minutesAgo < 30 ? 0.15 : minutesAgo < 480 ? 0.05 : 0.01
      const volume24h = liquidityUSD * turnoverFactor

      // ── Safety checks (run in parallel, non-blocking) ────────────────
      const [safety] = await Promise.all([
        withTimeout(this.checkSafety(targetToken, pairAddress, targetReserve), 8000)
          .catch(() => null),
      ])

      const safetyResult = safety ?? {
        isHoneypot: false, buyTax: 0, sellTax: 0,
        ownerRenounced: false, lpLocked: false,
        safetyScore: 50, flags: ['检测超时'],
      }

      // ── Combined activity score ──────────────────────────────────────
      const liquidityScore = liquidityUSD < 50000  ? 55
                           : liquidityUSD < 500000 ? 75
                           : liquidityUSD < 5000000 ? 88
                           : 65
      const score = Math.round((liquidityScore * 0.5 + activityScore * 0.5) * 10) / 10

      return {
        address: targetToken,
        symbol: String(symbol),
        name:   String(name),
        chain:  'BSC',
        liquidity: liquidityUSD,
        volume24h,
        score,
        dex:         this.dexName,
        pairAddress,
        price,
        priceUSD,
        ...safetyResult,
      }
    } catch {
      return null
    }
  }

  // ── Contract safety analysis ─────────────────────────────────────────
  private async checkSafety(
    tokenAddress: Address,
    pairAddress:  Address,
    tokenReserve: bigint,
  ): Promise<{
    isHoneypot: boolean
    buyTax: number
    sellTax: number
    ownerRenounced: boolean
    lpLocked: boolean
    safetyScore: number
    flags: string[]
  }> {
    const flags: string[] = []
    let isHoneypot   = false
    let buyTax       = 0
    let sellTax      = 0
    let ownerRenounced = false
    let lpLocked     = false

    // ── 1. Honeypot & tax check via simulation ──────────────────────────
    try {
      const testBNB = BigInt(1e16) // 0.01 BNB test amount

      // Simulate buy: how many tokens do we expect?
      const buyAmounts = await this.client.readContract({
        address: this.routerAddress, abi: ROUTER_ABI,
        functionName: 'getAmountsOut',
        args: [testBNB, [WBNB, tokenAddress]],
      })
      const expectedTokens = buyAmounts[1]
      if (expectedTokens === 0n) {
        flags.push('买入模拟失败')
        isHoneypot = true
      } else {
        // Calculate buy tax: compare received vs theoretical
        // Theoretical = (tokenReserve × testBNB) / bnbReserve  (simplified)
        // We use router output as actual; router itself applies AMM math,
        // any extra shortfall = buy tax
        // Simulate sell: can we sell those tokens back?
        try {
          const sellAmounts = await this.client.readContract({
            address: this.routerAddress, abi: ROUTER_ABI,
            functionName: 'getAmountsOut',
            args: [expectedTokens, [tokenAddress, WBNB]],
          })
          const bnbBack = sellAmounts[1]

          // Tax estimate: (input - output) / input
          const totalTax = Number(testBNB - bnbBack) / Number(testBNB)
          // Assume roughly equal buy/sell split
          buyTax  = Math.max(0, Math.round(totalTax * 50))
          sellTax = Math.max(0, Math.round(totalTax * 50))

          if (totalTax > 0.5) {
            flags.push(`高税率 ${(totalTax * 100).toFixed(0)}%`)
            if (totalTax > 0.9) isHoneypot = true
          } else if (totalTax > 0.1) {
            flags.push(`存在税率 ${(totalTax * 100).toFixed(0)}%`)
          }
        } catch {
          // Sell path simulation failed = strong honeypot signal
          flags.push('卖出模拟失败 (疑似貔貅)')
          isHoneypot = true
        }

        // Try deeper sell simulation using eth_call with actual swap calldata
        if (!isHoneypot) {
          try {
            const DUMMY_RECIPIENT = '0x0000000000000000000000000000000000000001' as Address
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 60)
            const callData = encodeFunctionData({
              abi: ROUTER_ABI,
              functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
              args: [expectedTokens, 0n, [tokenAddress, WBNB], DUMMY_RECIPIENT, deadline],
            })
            // eth_call with token contract as sender to bypass approval check
            await this.client.call({
              to:   this.routerAddress,
              data: callData,
              account: pairAddress as Address, // use pair as fake sender (holds tokens)
            })
          } catch (callErr: any) {
            const msg = String(callErr?.message ?? '').toLowerCase()
            // "transfer amount exceeds" or "not enough" can be OK (approval issue in simulation)
            // But "execution reverted" with no clear reason = suspect
            if (msg.includes('pancake: k') || msg.includes('insufficient output') || msg.includes('transfer_failed')) {
              flags.push('合约阻止卖出')
              isHoneypot = true
            }
          }
        }
      }
    } catch {
      flags.push('税率检测失败')
    }

    // ── 2. Owner check ──────────────────────────────────────────────────
    try {
      let owner: string | null = null
      try {
        owner = await this.client.readContract({
          address: tokenAddress, abi: ERC20_ABI, functionName: 'owner',
        }) as string
      } catch {
        try {
          owner = await this.client.readContract({
            address: tokenAddress, abi: ERC20_ABI, functionName: 'getOwner',
          }) as string
        } catch { /* no owner function = good */ }
      }

      if (!owner || owner.toLowerCase() === ZERO || owner.toLowerCase() === DEAD) {
        ownerRenounced = true
      } else {
        flags.push('合约有所有者 (未放弃权限)')
      }
    } catch {
      ownerRenounced = true  // can't call owner() = likely no owner
    }

    // ── 3. LP lock check ───────────────────────────────────────────────
    try {
      const [lpTotal, lpDead, lpZero] = await Promise.all([
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'totalSupply' }),
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'balanceOf', args: [DEAD as Address] }).catch(() => 0n),
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'balanceOf', args: [ZERO as Address] }).catch(() => 0n),
      ])

      const lockedLP = lpDead + lpZero
      const lockedPct = lpTotal > 0n ? Number(lockedLP * 100n / lpTotal) : 0

      if (lockedPct >= 90) {
        lpLocked = true
      } else if (lockedPct >= 50) {
        lpLocked = true
        flags.push(`LP 部分销毁 ${lockedPct}%`)
      } else {
        flags.push(`LP 未锁定 (销毁 ${lockedPct}%)`)
      }
    } catch {
      flags.push('LP 锁定状态未知')
    }

    // ── 4. Calculate safety score ───────────────────────────────────────
    let safetyScore = 100
    if (isHoneypot)          safetyScore -= 80
    if (!ownerRenounced)     safetyScore -= 15
    if (!lpLocked)           safetyScore -= 20
    if (sellTax > 10)        safetyScore -= 15
    if (sellTax > 20)        safetyScore -= 20
    if (flags.some(f => f.includes('税率') && !f.includes('存在'))) safetyScore -= 10
    safetyScore = Math.max(0, Math.min(100, safetyScore))

    return { isHoneypot, buyTax, sellTax, ownerRenounced, lpLocked, safetyScore, flags }
  }

  async analyzeToken(tokenAddress: Address): Promise<ScannedToken | null> {
    const bases: Address[] = [WBNB, BUSD, USDT]
    for (const base of bases) {
      try {
        const pairAddress = await this.client.readContract({
          address: this.factoryAddress, abi: FACTORY_ABI,
          functionName: 'getPair', args: [tokenAddress, base],
        }) as Address
        if (!pairAddress || pairAddress === ZERO) continue
        const result = await this.analyzePair(pairAddress)
        if (result) return result
      } catch {}
    }
    return null
  }

  async getMultiDexPrices(
    tokenAddress: Address,
    routers: { name: string; address: Address }[],
    amountIn: bigint = BigInt(1e18)
  ): Promise<PriceQuote[]> {
    const results = await Promise.allSettled(
      routers.map(async ({ name, address }) => {
        const amounts = await this.client.readContract({
          address, abi: ROUTER_ABI, functionName: 'getAmountsOut',
          args: [amountIn, [WBNB, tokenAddress]],
        })
        const price = Number(formatUnits(amounts[1], 18))
        return { dex: name, router: address, price, priceUSD: price * this.bnbPriceUSD }
      })
    )
    return results
      .filter((r): r is PromiseFulfilledResult<PriceQuote> => r.status === 'fulfilled')
      .map((r) => r.value)
  }

  async getBNBPrice(): Promise<number> {
    try {
      const amounts = await this.client.readContract({
        address: this.routerAddress, abi: ROUTER_ABI,
        functionName: 'getAmountsOut', args: [BigInt(1e18), [WBNB, BUSD]],
      })
      return Number(formatUnits(amounts[1], 18))
    } catch {
      return 580
    }
  }
}
