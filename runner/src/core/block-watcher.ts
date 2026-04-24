import { type PublicClient, decodeAbiParameters } from 'viem'
import chalk from 'chalk'

// Mined-block swap observation. This is the "polling" path — complement to
// mempool.ts. Designed to work through any plain HTTP RPC, so it keeps running
// on networks where WSS / mempool subscription is blocked (e.g. behind GFW).
//
// Trade-off: we see swaps AFTER they land on-chain, not before. No sandwiching
// possible — but we can still:
//   • Backrun (arb in block N+1 after a large swap in block N)
//   • Catch cross-DEX price dislocations
//   • Trigger signal-driven strategies (copy-trade, new-pool snipe)

export interface MinedSwap {
  txHash:      string
  blockNumber: bigint
  from:        string
  router:      string
  tokenIn:     string   // lowercase
  tokenOut:    string   // lowercase
  amountIn:    bigint   // BNB wei for ETH→token; token raw for token→*
  amountOutMin: bigint
  gasPrice:    bigint
  kind:        'eth_for_token' | 'token_for_eth' | 'token_for_token' | 'eth_for_exact'
}

// ── Swap function signatures (same as mempool.ts) ──────────────────────────
const SIG_ETH_FOR_TOKENS    = '0x7ff36ab5'
const SIG_TOKENS_FOR_ETH    = '0x18cbafe5'
const SIG_TOKENS_FOR_TOKENS = '0x38ed1739'
const SIG_ETH_FOR_EXACT     = '0xfb3bdb41'
const SWAP_SIGS = new Set([SIG_ETH_FOR_TOKENS, SIG_TOKENS_FOR_ETH, SIG_TOKENS_FOR_TOKENS, SIG_ETH_FOR_EXACT])

// Poll interval. BSC block time is ~3s, but there's jitter and we want to
// react within the same block. 800ms keeps RPC load reasonable while
// guaranteeing we catch a new block within ~1 block's worth of delay.
const POLL_INTERVAL_MS = 800

export class BlockWatcher {
  private client: PublicClient
  private routers: Set<string>       // lowercase router addresses we care about
  private handlers: ((swaps: MinedSwap[], blockNumber: bigint) => void)[] = []
  private running = false
  private lastBlock = 0n
  private timer?: NodeJS.Timeout
  private errorCount = 0
  private lastErrorLog = 0

  constructor(client: PublicClient, routerAddresses: string[]) {
    this.client  = client
    this.routers = new Set(routerAddresses.map((a) => a.toLowerCase()))
  }

  onBlock(fn: (swaps: MinedSwap[], blockNumber: bigint) => void) {
    this.handlers.push(fn)
  }

  async start() {
    if (this.running) return
    this.running = true
    try {
      this.lastBlock = await this.client.getBlockNumber()
      console.log(chalk.cyan(`[BlockWatcher] 开始监听区块 (起点 #${this.lastBlock})`))
    } catch (e: any) {
      console.error(chalk.red(`[BlockWatcher] 启动失败: ${e?.shortMessage ?? e?.message ?? e}`))
      this.running = false
      throw e
    }
    this.schedule()
  }

  stop() {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    console.log(chalk.yellow('[BlockWatcher] 已停止'))
  }

  private schedule() {
    if (!this.running) return
    this.timer = setTimeout(() => this.tick(), POLL_INTERVAL_MS)
  }

  private async tick() {
    if (!this.running) return
    try {
      const latest = await this.client.getBlockNumber()
      // Process blocks sequentially in case we fell behind. Cap catch-up to
      // 5 blocks to avoid a giant RPC stampede after a long pause.
      if (latest > this.lastBlock) {
        const start = this.lastBlock + 1n
        const end   = latest > this.lastBlock + 5n ? this.lastBlock + 5n : latest
        for (let n = start; n <= end && this.running; n++) {
          await this.processBlock(n)
        }
        this.lastBlock = end
      }
      this.errorCount = 0
    } catch (err: any) {
      this.errorCount++
      const now = Date.now()
      if (now - this.lastErrorLog > 15_000) {
        this.lastErrorLog = now
        const msg = String(err?.shortMessage ?? err?.message ?? err ?? '').split('\n')[0].slice(0, 160)
        console.warn(chalk.yellow(`[BlockWatcher] 拉取区块失败 (#${this.errorCount}): ${msg}`))
      }
    } finally {
      this.schedule()
    }
  }

  private async processBlock(blockNumber: bigint) {
    const block = await this.client.getBlock({ blockNumber, includeTransactions: true })
    if (!block || !block.transactions) return

    const swaps: MinedSwap[] = []
    for (const tx of block.transactions as any[]) {
      if (!tx?.to || !tx?.input || tx.input.length < 10) continue
      if (!this.routers.has(String(tx.to).toLowerCase())) continue
      const sig = String(tx.input).slice(0, 10).toLowerCase()
      if (!SWAP_SIGS.has(sig)) continue
      const parsed = parseSwap(tx, blockNumber, sig)
      if (parsed) swaps.push(parsed)
    }

    if (swaps.length > 0) {
      for (const h of this.handlers) {
        try { h(swaps, blockNumber) } catch {}
      }
    }
  }
}

// ── Decode a known swap tx. Returns null if parsing fails. ────────────────
function parseSwap(tx: any, blockNumber: bigint, sig: string): MinedSwap | null {
  try {
    const data = `0x${String(tx.input).slice(10)}` as `0x${string}`
    let tokenIn  = '0x0000000000000000000000000000000000000000'
    let tokenOut = '0x0000000000000000000000000000000000000000'
    let amountOutMin = 0n
    let kind: MinedSwap['kind']

    if (sig === SIG_ETH_FOR_TOKENS || sig === SIG_ETH_FOR_EXACT) {
      const [amt, path] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }],
        data
      ) as [bigint, readonly string[], string, bigint]
      amountOutMin = amt
      tokenIn  = String(path[0]).toLowerCase()
      tokenOut = String(path[path.length - 1]).toLowerCase()
      kind = sig === SIG_ETH_FOR_TOKENS ? 'eth_for_token' : 'eth_for_exact'

    } else if (sig === SIG_TOKENS_FOR_ETH) {
      const [, amtOutMin, path] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }],
        data
      ) as [bigint, bigint, readonly string[], string, bigint]
      amountOutMin = amtOutMin
      tokenIn  = String(path[0]).toLowerCase()
      tokenOut = String(path[path.length - 1]).toLowerCase()
      kind = 'token_for_eth'

    } else /* SIG_TOKENS_FOR_TOKENS */ {
      const [, amtOutMin, path] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }],
        data
      ) as [bigint, bigint, readonly string[], string, bigint]
      amountOutMin = amtOutMin
      tokenIn  = String(path[0]).toLowerCase()
      tokenOut = String(path[path.length - 1]).toLowerCase()
      kind = 'token_for_token'
    }

    return {
      txHash:      String(tx.hash),
      blockNumber,
      from:        String(tx.from),
      router:      String(tx.to),
      tokenIn,
      tokenOut,
      amountIn:    tx.value ?? 0n,
      amountOutMin,
      gasPrice:    tx.gasPrice ?? 0n,
      kind,
    }
  } catch {
    return null
  }
}
