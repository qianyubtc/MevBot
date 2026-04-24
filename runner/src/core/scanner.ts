import {
  type PublicClient,
  parseAbi,
  formatUnits,
  type Address,
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
])

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])

const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])

// Stablecoins and base tokens for price reference
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' as Address
const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address
const BASE_TOKENS = new Set([WBNB.toLowerCase(), BUSD.toLowerCase(), USDT.toLowerCase()])

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
}

export interface PriceQuote {
  dex: string
  router: Address
  price: number
  priceUSD: number
}

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

    // Stable fallback pairs (used only if dynamic scan fails)
    const FALLBACK_PAIRS: Address[] = [
      '0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16', // BNB/BUSD
      '0x61EB789d75A95CAa3fF50ed7E47b96c132fEc082', // BTCB/BNB
      '0x74E4716E431f45807DCF19f284c7aA99F18a4fbc', // ETH/BNB
      '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0', // CAKE/BNB
      '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE', // BNB/USDT
    ]

    try {
      // ── Dynamic scan: sample random pairs from recent 5000 ──────────────
      let pairsToScan: Address[] = []
      try {
        const totalPairs = await this.client.readContract({
          address: this.factoryAddress,
          abi: FACTORY_ABI,
          functionName: 'allPairsLength',
        })
        const total = Number(totalPairs)
        console.log(chalk.dim(`[Scanner] 工厂共有 ${total} 个交易对，随机采样中...`))

        // Sample from different "zones" of recent pairs for diversity
        const sampleSize = 120
        const searchDepth = Math.min(total, 5000)
        const indices = Array.from({ length: sampleSize }, () =>
          BigInt(total - 1 - Math.floor(Math.random() * searchDepth))
        )
        // Deduplicate indices
        const uniqueIndices = [...new Set(indices.map(String))].map(BigInt)

        const results = await Promise.allSettled(
          uniqueIndices.map((i) => this.client.readContract({
            address: this.factoryAddress,
            abi: FACTORY_ABI,
            functionName: 'allPairs',
            args: [i],
          }))
        )
        pairsToScan = results
          .filter((r): r is PromiseFulfilledResult<Address> => r.status === 'fulfilled')
          .map((r) => r.value)
      } catch (e: any) {
        console.warn(chalk.yellow('[Scanner] 动态采样失败，使用备用列表'), e.message)
        pairsToScan = FALLBACK_PAIRS
      }

      // Mix in fallback pairs (always include some reliable liquidity anchors)
      const allPairs = [...new Set([...FALLBACK_PAIRS, ...pairsToScan])]
      console.log(chalk.dim(`[Scanner] 分析 ${allPairs.length} 个交易对...`))

      // Analyze in batches to avoid overwhelming the RPC
      const BATCH = 20
      const analyzed: ScannedToken[] = []
      for (let i = 0; i < allPairs.length; i += BATCH) {
        const batch = allPairs.slice(i, i + BATCH)
        const results = await Promise.allSettled(batch.map((addr) => this.analyzePair(addr)))
        results.forEach((r) => {
          if (r.status === 'fulfilled' && r.value) analyzed.push(r.value)
        })
      }

      const tokens = analyzed
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      console.log(chalk.green(`[Scanner] 扫描完成，找到 ${tokens.length} 个优质代币`))
      return tokens
    } catch (err: any) {
      console.error(chalk.red('[Scanner] 扫描失败:'), err.message)
      return []
    }
  }

  private async analyzePair(pairAddress: Address): Promise<ScannedToken | null> {
    try {
      const [token0, token1, reserves] = await Promise.all([
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token0' }),
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'token1' }),
        this.client.readContract({ address: pairAddress, abi: PAIR_ABI, functionName: 'getReserves' }),
      ])

      // Must pair with a base token
      const isToken0Base = BASE_TOKENS.has(token0.toLowerCase())
      const isToken1Base = BASE_TOKENS.has(token1.toLowerCase())
      if (!isToken0Base && !isToken1Base) return null

      const targetToken = isToken0Base ? token1 : token0
      const baseToken = isToken0Base ? token0 : token1
      const [reserve0, reserve1] = reserves

      const targetReserve = isToken0Base ? reserve1 : reserve0
      const baseReserve = isToken0Base ? reserve0 : reserve1

      // Get token info
      const [symbol, name, decimals] = await Promise.all([
        this.client.readContract({ address: targetToken, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
        this.client.readContract({ address: targetToken, abi: ERC20_ABI, functionName: 'name' }).catch(() => 'Unknown Token'),
        this.client.readContract({ address: targetToken, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ])

      const baseDecimals = baseToken.toLowerCase() === WBNB.toLowerCase() ? 18 : 18
      const baseReserveNum = Number(formatUnits(baseReserve, baseDecimals))
      const isWbnbBase = baseToken.toLowerCase() === WBNB.toLowerCase()

      // Liquidity in USD
      const liquidityUSD = isWbnbBase
        ? baseReserveNum * this.bnbPriceUSD * 2
        : baseReserveNum * 2

      if (liquidityUSD < 1000) return null

      // Price
      const targetReserveNum = Number(formatUnits(targetReserve, Number(decimals)))
      const price = targetReserveNum > 0 ? baseReserveNum / targetReserveNum : 0
      const priceUSD = isWbnbBase ? price * this.bnbPriceUSD : price

      // Score based on liquidity (higher = more sandwichable)
      const score = this.calculateScore(liquidityUSD)

      return {
        address: targetToken,
        symbol: String(symbol),
        name: String(name),
        chain: 'BSC',
        liquidity: liquidityUSD,
        volume24h: 0, // real volume requires off-chain data API
        score,
        dex: this.dexName,
        pairAddress,
        price,
        priceUSD,
      }
    } catch {
      return null
    }
  }

  private calculateScore(liquidityUSD: number): number {
    // Sandwich suitability: ideal range $50k-$5M
    let raw: number
    if (liquidityUSD < 10000) raw = 20
    else if (liquidityUSD < 50000) raw = 55
    else if (liquidityUSD < 500000) raw = 75
    else if (liquidityUSD < 5000000) raw = 88
    else raw = 65
    return Math.round(raw * 10) / 10
  }

  // Analyze a specific token by CA — find its best pair on this DEX
  async analyzeToken(tokenAddress: Address): Promise<ScannedToken | null> {
    const bases: Address[] = [WBNB, BUSD, USDT]
    for (const base of bases) {
      try {
        const pairAddress = await this.client.readContract({
          address: this.factoryAddress,
          abi: FACTORY_ABI,
          functionName: 'getPair',
          args: [tokenAddress, base],
        }) as Address
        if (!pairAddress || pairAddress === '0x0000000000000000000000000000000000000000') continue
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
          address,
          abi: ROUTER_ABI,
          functionName: 'getAmountsOut',
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
      // Query WBNB/BUSD pair on PancakeSwap
      const amounts = await this.client.readContract({
        address: this.routerAddress,
        abi: ROUTER_ABI,
        functionName: 'getAmountsOut',
        args: [BigInt(1e18), [WBNB, BUSD]],
      })
      return Number(formatUnits(amounts[1], 18))
    } catch {
      return 580
    }
  }
}
