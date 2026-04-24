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

// High-liquidity PancakeSwap pairs — always scanned even when dynamic fetch fails
const SEED_PAIRS: Address[] = [
  '0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16', // WBNB/BUSD
  '0x61EB789d75A95CAa3fF50ed7E47b96c132fEc082', // BTCB/WBNB
  '0x74E4716E431f45807DCF19f284c7aA99F18a4fbc', // ETH/WBNB
  '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0', // CAKE/WBNB
  '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE', // WBNB/USDT
  '0x7EFaEf62fDdCCa950418312c6C702547502517a3', // USDT/BUSD
  '0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b', // USDC/BUSD
  '0xBA51D1AB95756ca4eaB8197eab5335D406F0E6e3', // DOT/WBNB
  '0xbCD62661A6b1DEd703585d3aF7d7649Ef621861b', // ADA/WBNB
  '0xA39Af17CE4a8eb807E076805Da1e2B8EA7D0755b', // LINK/WBNB
  '0xc15fa3E22c912A276550F3E5FE3b0Deb87B55aCd', // DOGE/WBNB
  '0x2354ef4DF11afacb85a5C7f98B624072ECcddbB1', // XRP/WBNB
  '0xf3047c77154fe608edd9e35d3e5af05da83ac8cd', // FLOKI/WBNB
  '0x1B96B92314C44b159149f7E0303511fB2Fc4774f', // USDT/WBNB (v1)
  '0x3f6b2D68980Db7371D3D0470117393c9262621ea', // PEPE/WBNB
  '0x66FDB2eCCfB58cF098eaa419e5EfDe841368e489', // TUSD/WBNB
  '0x326D754c64329aD7cb35744770D56D0E1f3B3124', // SOL/WBNB
  '0x0392957571F28037607C14832D16f8B653eDd472', // MATIC/WBNB
  '0x9d4BfA1A3AFBE79F8b0fd2CC55bcFd1cC2E6d0ef', // ATOM/WBNB
  '0xcb51C98780f8B4c1c27ca2b62ac6a0F2bAF1ca9C', // NEAR/WBNB
  '0x20bcc3b8a0091ddac2d0bc30f68e6cbb97de59cd', // SHIB/WBNB
  '0x36b8b28D37f93372188F2aa2507b68A5CD8B2664', // LTC/WBNB
  '0x3f0A9aB940df9aDE65A23A76FFC0b1Dca937a27c', // AVAX/WBNB
  '0xdd5bad8f8b360d76d12feB9d7E73Fdc4e5A7e1B', // UNI/WBNB
  '0x824eb9faDFb377394430d2744fa7C42916DE3eCe', // FIL/WBNB
]

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

// Wrap a promise with a timeout — resolves to null on timeout instead of throwing
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ])
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

    // ── Step 1: Try dynamic sampling via multicall (fast, 1-2 RPC round trips) ──
    let dynamicPairs: Address[] = []
    try {
      const totalPairsRaw = await withTimeout(
        this.client.readContract({
          address: this.factoryAddress,
          abi: FACTORY_ABI,
          functionName: 'allPairsLength',
        }),
        12000 // 12s max for allPairsLength
      )

      if (totalPairsRaw != null) {
        const total = Number(totalPairsRaw)
        console.log(chalk.dim(`[Scanner] 工厂共有 ${total} 个交易对，multicall 随机采样...`))

        const sampleSize = 80
        const searchDepth = Math.min(total, 5000)
        const indicesSet = new Set<number>()
        while (indicesSet.size < sampleSize) {
          indicesSet.add(total - 1 - Math.floor(Math.random() * searchDepth))
        }
        const indices = [...indicesSet].map(BigInt)

        // Use multicall — all 80 allPairs(i) calls in a single eth_call
        const multicallResults = await withTimeout(
          this.client.multicall({
            contracts: indices.map((i) => ({
              address: this.factoryAddress,
              abi: FACTORY_ABI,
              functionName: 'allPairs' as const,
              args: [i] as [bigint],
            })),
            allowFailure: true,
          }),
          15000 // 15s max for multicall
        )

        if (multicallResults) {
          dynamicPairs = multicallResults
            .filter((r) => r.status === 'success')
            .map((r) => r.result as Address)
          console.log(chalk.dim(`[Scanner] 动态采样获得 ${dynamicPairs.length} 个交易对`))
        }
      } else {
        console.warn(chalk.yellow('[Scanner] allPairsLength 超时，跳过动态采样'))
      }
    } catch (e: any) {
      console.warn(chalk.yellow('[Scanner] 动态采样失败:'), e.message?.slice(0, 80))
    }

    // ── Step 2: Merge seed + dynamic pairs, deduplicate ──
    const allPairs = [...new Set([...SEED_PAIRS, ...dynamicPairs])]
    console.log(chalk.dim(`[Scanner] 分析 ${allPairs.length} 个交易对...`))

    // ── Step 3: Analyze pairs in batches of 20 ──
    const BATCH = 20
    const analyzed: ScannedToken[] = []
    for (let i = 0; i < allPairs.length; i += BATCH) {
      const batch = allPairs.slice(i, i + BATCH)
      const results = await Promise.allSettled(batch.map((addr) => this.analyzePair(addr)))
      results.forEach((r) => {
        if (r.status === 'fulfilled' && r.value) analyzed.push(r.value)
      })
    }

    const tokens = analyzed.sort((a, b) => b.score - a.score).slice(0, limit)
    console.log(chalk.green(`[Scanner] 扫描完成，找到 ${tokens.length} 个优质代币`))
    return tokens
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

      const baseDecimals = 18
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

      // Score based on liquidity
      const score = this.calculateScore(liquidityUSD)

      return {
        address: targetToken,
        symbol: String(symbol),
        name: String(name),
        chain: 'BSC',
        liquidity: liquidityUSD,
        volume24h: 0,
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
