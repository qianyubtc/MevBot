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

// Max concurrent getTransaction calls. Free WSS endpoints rate-limit around
// 25-50 req/s; BSC mempool can deliver 200+ hashes in a single batch during
// active periods. Bursting Promise.all over all of them will get us banned.
const MAX_TX_FETCH_CONCURRENCY = 20

// Process items with bounded parallelism. Simpler than pulling in p-limit.
async function parallelMap<T>(
  items: T[], workers: number, fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      try { await fn(items[idx]) } catch {}
    }
  }))
}

// Classify RPC errors so we can give users actionable guidance instead of
// dumping raw viem stack traces.
function classifyRpcError(err: any): {
  unsupported: boolean
  filterExpired: boolean
  socketClosed: boolean
  short: string
} {
  const raw = String(err?.shortMessage ?? err?.message ?? err ?? '').toLowerCase()
  const status = err?.status ?? err?.cause?.status
  // "filter not found" means the RPC evicted our polling filter (most HTTP
  // RPCs expire idle filters after ~5min or even ~5s under memory pressure).
  // This is recoverable — we just need a fresh filter.
  const filterExpired =
    raw.includes('filter not found') ||
    raw.includes('filter id') ||
    raw.includes('invalid filter')
  // WSS socket died mid-stream — GFW/firewall/idle timeout/server restart.
  // Recoverable: tear down the dead subscription and rebuild.
  const socketClosed =
    !filterExpired && (
      raw.includes('socket has been closed') ||
      raw.includes('socket is closed') ||
      raw.includes('websocket') ||
      raw.includes('connection closed') ||
      raw.includes('connection terminated') ||
      raw.includes('econnreset') ||
      raw.includes('client network socket disconnected') ||
      raw.includes('tls connection') ||
      raw.includes('ws is not open')
    )
  const unsupported =
    !filterExpired && (
      status === 403 || status === 405 ||
      raw.includes('forbidden') ||
      raw.includes('method not found') ||
      raw.includes('method not supported') ||
      raw.includes('does not exist') ||
      raw.includes('not available')
    )
  const short = String(err?.shortMessage ?? err?.message ?? err ?? '').split('\n')[0].slice(0, 180)
  return { unsupported, filterExpired, socketClosed, short }
}

export class MempoolMonitor {
  private client: PublicClient
  private routerAddresses: string[]
  private handlers: ((swap: PendingSwap) => void)[] = []
  private running = false
  private errorCount = 0
  private lastErrorLogAt = 0
  private guidanceShown = false
  private wssGuidanceShown = false
  private socketGuidanceShown = false
  private activeUnwatch?: () => void
  private reconnectTimer?: NodeJS.Timeout
  private reconnectAttempt = 0

  constructor(client: PublicClient, routerAddresses: string[]) {
    this.client = client
    this.routerAddresses = routerAddresses.map((a) => a.toLowerCase())
  }

  onSwap(handler: (swap: PendingSwap) => void) {
    this.handlers.push(handler)
  }

  // Print actionable RPC guidance exactly once per session.
  private showRpcGuidance() {
    if (this.guidanceShown) return
    this.guidanceShown = true
    console.error(chalk.red(
      '[Mempool] ✗ 当前 RPC 不支持 mempool 订阅 (eth_newPendingTransactionFilter 返回 403)。\n' +
      '          夹子策略需要访问待处理交易池，公共 BSC RPC（dataseed / ninicoin 等）都不支持。\n' +
      '          请在「设置」页把 RPC 换成以下任一：\n' +
      '            • WSS 节点: wss://bsc-rpc.publicnode.com  或  wss://bsc.callstaticrpc.com\n' +
      '            • 付费服务: QuickNode / NodeReal / GetBlock （支持 pending tx 订阅）\n' +
      '            • 48 Club MEV: https://rpc-bsc.48.club  （专门给 MEV 机器人用）\n' +
      '          换 RPC 后重启夹子即可。'
    ))
  }

  // Print WSS-migration hint once: recurring filter expirations mean the user
  // is on an HTTP RPC that evicts filters aggressively. WSS (eth_subscribe)
  // avoids the filter mechanism entirely and is strictly better.
  private showWssGuidance() {
    if (this.wssGuidanceShown) return
    this.wssGuidanceShown = true
    console.warn(chalk.yellow(
      '[Mempool] ⚠ RPC 频繁丢弃 pending-tx filter — 这是 HTTP 轮询模式的固有问题。\n' +
      '           强烈建议切换到 WSS (eth_subscribe 不会过期):\n' +
      '             • wss://bsc-rpc.publicnode.com\n' +
      '             • wss://bsc.callstaticrpc.com\n' +
      '           已启用自动重建 filter，但延迟/漏单会增加。'
    ))
  }

  // Print guidance once if WSS keeps getting closed — likely GFW / unstable
  // public endpoint. Steer the user to alternatives.
  private showSocketGuidance() {
    if (this.socketGuidanceShown) return
    this.socketGuidanceShown = true
    console.error(chalk.red(
      '[Mempool] ✗ WSS 连接反复断开 — 当前 RPC 在你的网络下不稳定（常见：公用节点被限流或网络被阻断）。\n' +
      '          建议依次尝试以下节点（在「设置」页切换后重启夹子）：\n' +
      '            • wss://bsc.callstaticrpc.com\n' +
      '            • wss://bsc-rpc.publicnode.com\n' +
      '            • wss://bsc.drpc.org\n' +
      '            • wss://bsc.blockpi.network/v1/ws/public\n' +
      '          如都连不上，说明你的出口被 ban，需要：\n' +
      '            1) 换网络/代理（机场节点通常能连 publicnode）\n' +
      '            2) 或购买付费服务（QuickNode / NodeReal / GetBlock）\n' +
      '            3) 或用 VPS 部署一台中继服务器\n' +
      '          自动重连已启用，会持续尝试恢复。'
    ))
  }

  async start() {
    this.running = true
    this.errorCount = 0
    this.guidanceShown = false
    this.wssGuidanceShown = false
    this.reconnectAttempt = 0
    console.log(chalk.cyan('[Mempool] 开始监听待处理交易...'))

    this.attachWatcher()

    return () => {
      this.running = false
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
      this.activeUnwatch?.()
      this.activeUnwatch = undefined
    }
  }

  // Create a fresh pending-tx subscription. Called on start and after any
  // recoverable error (filter expired, transient network blip).
  private attachWatcher() {
    if (!this.running) return

    try {
      this.activeUnwatch = this.client.watchPendingTransactions({
        onTransactions: async (hashes) => {
          if (!this.running) return
          // Reset reconnect counter on any live data.
          this.reconnectAttempt = 0
          // Bounded concurrency — unbounded Promise.all over 200+ hashes on
          // a free WSS endpoint gets us rate-limited within seconds.
          await parallelMap(hashes, MAX_TX_FETCH_CONCURRENCY, async (hash) => {
            if (!this.running) return
            const tx = await this.client.getTransaction({ hash })
            if (!tx || !tx.to) return
            if (!this.routerAddresses.includes(tx.to.toLowerCase())) return
            const sig = tx.input.slice(0, 10).toLowerCase()
            if (!SWAP_SIGNATURES.includes(sig)) return

            const swap = this.parseSwapTx(tx)
            if (swap) this.handlers.forEach((h) => h(swap))
          })
        },
        // viem swallows async errors from the polling loop — without this we'd
        // silently stop receiving txs when the filter expires or the node blips.
        onError: (err) => {
          this.errorCount++
          const { unsupported, filterExpired, socketClosed, short } = classifyRpcError(err)

          if (unsupported) {
            this.showRpcGuidance()
            return  // no point retrying on 403
          }

          if (socketClosed) {
            // WSS died — usually GFW/firewall closing idle socket. Rebuild.
            // Viem's auto-reconnect should have tried but clearly failed here.
            this.reconnectAttempt++
            if (this.reconnectAttempt === 3) this.showSocketGuidance()
            this.activeUnwatch?.()
            this.activeUnwatch = undefined
            const delay = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 10_000)
            const now = Date.now()
            if (now - this.lastErrorLogAt > 15_000) {
              this.lastErrorLogAt = now
              console.warn(chalk.yellow(`[Mempool] WSS 连接断开，${delay}ms 后重连 (第 ${this.reconnectAttempt} 次)`))
            }
            this.reconnectTimer = setTimeout(() => this.attachWatcher(), delay)
            return
          }

          if (filterExpired) {
            // RPC dropped our filter. Tear down the dead watcher and create a
            // new one. This is common on 48.club / free HTTP RPCs. After a few
            // recurrences we nudge the user toward WSS.
            if (this.reconnectAttempt >= 2) this.showWssGuidance()
            this.reconnectAttempt++
            this.activeUnwatch?.()
            this.activeUnwatch = undefined
            // Small backoff so we don't hammer the RPC if it's actually down.
            // 500ms → 1s → 2s → 4s capped at 5s.
            const delay = Math.min(500 * 2 ** (this.reconnectAttempt - 1), 5000)
            this.reconnectTimer = setTimeout(() => this.attachWatcher(), delay)
            return
          }

          // Unknown transient error — throttle logs to ≤1 per 30s.
          const now = Date.now()
          if (now - this.lastErrorLogAt > 30_000) {
            this.lastErrorLogAt = now
            console.error(chalk.red(
              `[Mempool] 订阅错误 (#${this.errorCount}): ${short}` +
              (this.errorCount > 5 ? ' — 错误持续，建议检查 RPC 可用性' : '')
            ))
          }
        },
      })
    } catch (e: any) {
      const { unsupported, short } = classifyRpcError(e)
      if (unsupported) this.showRpcGuidance()
      else console.error(chalk.red(`[Mempool] 订阅启动失败: ${short}`))
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
