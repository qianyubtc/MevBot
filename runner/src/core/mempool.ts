import { type PublicClient, decodeAbiParameters } from 'viem'
import chalk from 'chalk'

export interface PendingSwap {
  txHash: string
  from: string
  to: string
  router: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint      // BNB value (for ETH→token swaps)
  amountOutMin: bigint
  deadline: bigint
  gasPrice: bigint
}

// swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)
const SIG_ETH_FOR_TOKENS    = '0x7ff36ab5'
// swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
const SIG_TOKENS_FOR_ETH    = '0x18cbafe5'
// swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
const SIG_TOKENS_FOR_TOKENS = '0x38ed1739'
// swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)
const SIG_ETH_FOR_EXACT     = '0xfb3bdb41'

const SWAP_SIGNATURES = [SIG_ETH_FOR_TOKENS, SIG_TOKENS_FOR_ETH, SIG_TOKENS_FOR_TOKENS, SIG_ETH_FOR_EXACT]

export class MempoolMonitor {
  private client: PublicClient
  private routerAddresses: string[]
  private handlers: ((swap: PendingSwap) => void)[] = []
  private running = false

  constructor(client: PublicClient, routerAddresses: string[]) {
    this.client = client
    this.routerAddresses = routerAddresses.map((a) => a.toLowerCase())
  }

  onSwap(handler: (swap: PendingSwap) => void) {
    this.handlers.push(handler)
  }

  async start() {
    this.running = true
    console.log(chalk.cyan('[Mempool] 开始监听待处理交易...'))

    try {
      const unwatch = this.client.watchPendingTransactions({
        onTransactions: async (hashes) => {
          if (!this.running) return
          // Fetch all hashes in parallel. Old code did `hashes.slice(0, 10)` in
          // a sequential loop which (a) silently dropped swaps under load and
          // (b) serialized RPC roundtrips into an artificial latency bottleneck.
          await Promise.all(hashes.map(async (hash) => {
            if (!this.running) return
            try {
              const tx = await this.client.getTransaction({ hash })
              if (!tx || !tx.to) return
              if (!this.routerAddresses.includes(tx.to.toLowerCase())) return
              const sig = tx.input.slice(0, 10).toLowerCase()
              if (!SWAP_SIGNATURES.includes(sig)) return

              const swap = this.parseSwapTx(tx)
              if (swap) this.handlers.forEach((h) => h(swap))
            } catch {}
          }))
        },
        // viem's subscription swallows async errors — without this callback a
        // dropped node connection would silently stop delivering txs forever
        // (and we'd never notice because the try/catch only wraps the sync
        // setup, not the stream). Logging lets the user spot dead mempool.
        onError: (err) => {
          console.error(chalk.red(`[Mempool] 订阅错误: ${err?.message ?? err}`))
        },
      })

      return () => {
        this.running = false
        unwatch()
      }
    } catch (e: any) {
      console.error(chalk.red(`[Mempool] 订阅失败 (${e?.message ?? e})，使用轮询模式`))
      return this.startPolling()
    }
  }

  private async startPolling() {
    while (this.running) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    return () => { this.running = false }
  }

  private parseSwapTx(tx: any): PendingSwap | null {
    try {
      const sig = tx.input.slice(0, 10).toLowerCase()
      const data = `0x${tx.input.slice(10)}` as `0x${string}`

      let tokenIn  = '0x0000000000000000000000000000000000000000'
      let tokenOut = '0x0000000000000000000000000000000000000000'
      let amountOutMin = 0n

      if (sig === SIG_ETH_FOR_TOKENS || sig === SIG_ETH_FOR_EXACT) {
        // swapExactETHForTokens / swapETHForExactTokens
        // (uint256, address[], address, uint256)
        const [_amt, path] = decodeAbiParameters(
          [{ type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }],
          data
        ) as [bigint, readonly string[], string, bigint]
        amountOutMin = _amt
        tokenIn  = (path[0] as string).toLowerCase()
        tokenOut = (path[path.length - 1] as string).toLowerCase()

      } else if (sig === SIG_TOKENS_FOR_ETH) {
        // swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[], address, uint256)
        const [_amtIn, _amtOutMin, path] = decodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }],
          data
        ) as [bigint, bigint, readonly string[], string, bigint]
        amountOutMin = _amtOutMin
        tokenIn  = (path[0] as string).toLowerCase()
        tokenOut = (path[path.length - 1] as string).toLowerCase()

      } else if (sig === SIG_TOKENS_FOR_TOKENS) {
        // swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[], address, uint256)
        const [_amtIn, _amtOutMin, path] = decodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }],
          data
        ) as [bigint, bigint, readonly string[], string, bigint]
        amountOutMin = _amtOutMin
        tokenIn  = (path[0] as string).toLowerCase()
        tokenOut = (path[path.length - 1] as string).toLowerCase()
      }

      return {
        txHash: tx.hash,
        from: tx.from,
        to: tx.to,
        router: tx.to,
        tokenIn,
        tokenOut,
        amountIn: tx.value ?? 0n,   // BNB sent (only meaningful for ETH→token swaps)
        amountOutMin,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
        gasPrice: tx.gasPrice ?? 0n,
      }
    } catch {
      return null
    }
  }

  stop() {
    this.running = false
    console.log(chalk.yellow('[Mempool] 监听已停止'))
  }
}
