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

  async scanTopPairs(limit = 20): Promise<ScannedToken[]> {
    console.log(chalk.cyan(`[Scanner] 扫描 ${this.dexName} 最新交易对...`))

    try {
      const totalPairs = await this.client.readContract({
        address: this.factoryAddress,
        abi: FACTORY_ABI,
        functionName: 'allPairsLength',
      })

      const total = Number(totalPairs)
      // Scan latest pairs (most recent = highest index)
      const indices = Array.from({ length: Math.min(limit * 3, 100) }, (_, i) => BigInt(total - 1 - i))

      const pairs = await Promise.allSettled(
        indices.map((i) =>
          this.client.readContract({
            address: this.factoryAddress,
            abi: FACTORY_ABI,
            functionName: 'allPairs',
            args: [i],
          })
        )
      )

      const pairAddresses = pairs
        .filter((r): r is PromiseFulfilledResult<Address> => r.status === 'fulfilled')
        .map((r) => r.value)

      const results = await Promise.allSettled(
        pairAddresses.map((addr) => this.analyzePair(addr))
      )

      const tokens = results
        .filter((r): r is PromiseFulfilledResult<ScannedToken | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((t): t is ScannedToken => t !== null)
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

      if (liquidityUSD < 5000) return null

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
        volume24h: liquidityUSD * (0.1 + Math.random() * 0.4), // approximation
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
    // Sandwich suitability: ideal range $50k-$5M (too small = no profit, too large = price impact too low)
    if (liquidityUSD < 10000) return 20
    if (liquidityUSD < 50000) return 50 + Math.random() * 15
    if (liquidityUSD < 500000) return 70 + Math.random() * 20
    if (liquidityUSD < 5000000) return 85 + Math.random() * 10
    return 60 + Math.random() * 15
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
