import { type WalletClient, type PublicClient, serializeTransaction, keccak256 } from 'viem'
import chalk from 'chalk'

// 48 Club "Puissant" bundle submission client.
//
// Why this exists:
//   • Public mempool is often unreachable from China (GFW blocks most WSS
//     endpoints), and even when reachable it's a red ocean of MEV bots that
//     will snipe our frontrun before the victim lands.
//   • Puissant is a private-order-flow MEV endpoint operated by 48 Club
//     validators. You submit pre-signed bundles; if included, transactions
//     execute atomically in the order given, in a specific target block.
//     If NOT included (or any tx would revert), nothing lands — no gas lost.
//   • The endpoint has Asia-Pacific presence → reachable from CN without
//     any VPN/proxy.
//
// Docs: https://docs.48.club/buildonbnbchain/mev-on-bnbchain/puissant
//
// Method: `eth_sendPuissant` — JSON-RPC, params: (txs, maxTimestamp, acceptReverting)
//   txs:         string[]   — raw pre-signed RLP-encoded transactions (with 0x)
//   maxTimestamp number     — Unix seconds; bundle dropped if not included by then
//   acceptReverting string[] — tx hashes allowed to revert (empty = all must succeed)

// Public endpoint — no auth required. There's also a paid relay with higher
// priority; switch URL via config if/when we subscribe.
export const PUISSANT_URL = 'https://puissant-bsc.48.club'

// How long ahead we grant the relay to attempt inclusion. BSC block time is
// 3s; 30s = ~10 blocks of opportunity to land the bundle.
const DEFAULT_BUNDLE_TTL_SECONDS = 30

export interface PuissantTx {
  // The inputs used to construct a contract call or plain transaction.
  // We serialize + sign these client-side and submit the raw RLP hex.
  to:       `0x${string}`
  data:     `0x${string}`
  value?:   bigint
  gas:      bigint
  gasPrice: bigint
  nonce:    number
}

export interface PuissantSubmitResult {
  ok:        boolean
  bundleId?: string          // relay's tracking id for the bundle
  txHashes:  string[]        // deterministic hashes of the txs we signed
  error?:    string
}

export class PuissantClient {
  constructor(
    private walletClient: WalletClient,
    private publicClient: PublicClient,   // used only for chainId fetch
    private url: string = PUISSANT_URL,
  ) {}

  // Submit a bundle. Returns once the relay has ACK'd receipt — NOT once the
  // bundle is included. Inclusion status must be checked by watching the
  // tx hashes via publicClient. If the relay rejects synchronously (malformed
  // bundle / nonce too low / etc.) we surface the error here.
  async submitBundle(
    txs: PuissantTx[],
    opts: { ttlSeconds?: number; acceptRevertingHashes?: string[] } = {}
  ): Promise<PuissantSubmitResult> {
    const account = this.walletClient.account
    if (!account) throw new Error('PuissantClient: wallet has no account')

    // We need the chainId to sign type-2 transactions correctly.
    const chainId = await this.publicClient.getChainId()
    const signedRaw: string[] = []
    const txHashes:  string[] = []

    for (const tx of txs) {
      // Serialize as a legacy (type 0) transaction. BSC's Puissant relay
      // historically had hiccups with EIP-1559 envelopes; legacy type-0 with
      // an explicit gasPrice is universally accepted and costs the same.
      const unsigned = {
        to:       tx.to,
        data:     tx.data,
        value:    tx.value ?? 0n,
        gas:      tx.gas,
        gasPrice: tx.gasPrice,
        nonce:    tx.nonce,
        chainId,
        type:     'legacy' as const,
      }
      // walletClient.signTransaction handles raw-signing without broadcasting.
      const raw = await this.walletClient.signTransaction({
        ...unsigned,
        account,
        chain: null,
      } as any) as `0x${string}`
      signedRaw.push(raw)
      // keccak256 of the signed RLP == canonical tx hash
      txHashes.push(keccak256(raw))
    }

    const maxTimestamp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? DEFAULT_BUNDLE_TTL_SECONDS)
    const body = {
      jsonrpc: '2.0',
      id:      1,
      method:  'eth_sendPuissant',
      // [txs, maxTimestamp, acceptReverting?]
      params:  [signedRaw, maxTimestamp, opts.acceptRevertingHashes ?? []],
    }

    let resp: Response
    try {
      resp = await fetch(this.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        // 10s is plenty — the relay either ACKs fast or it's down.
        signal:  AbortSignal.timeout(10_000),
      })
    } catch (e: any) {
      return { ok: false, txHashes, error: `relay 请求失败: ${e?.message ?? e}` }
    }

    let json: any
    try {
      json = await resp.json()
    } catch (e: any) {
      return { ok: false, txHashes, error: `relay 响应非 JSON (HTTP ${resp.status})` }
    }

    if (json?.error) {
      const msg = json.error?.message ?? JSON.stringify(json.error)
      return { ok: false, txHashes, error: `relay 拒绝: ${msg}` }
    }

    // The relay's `result` is the bundle id (uuid-like string). If missing,
    // treat as success if HTTP 200 and no error — some versions return null.
    return {
      ok:       true,
      bundleId: json?.result,
      txHashes,
    }
  }
}

// Small helper — raw-serialize + compute hash WITHOUT submitting. Used in
// tests and for the `acceptRevertingHashes` mechanism if we want to mark
// specific txs as allowed-to-revert.
export function txHashOf(raw: `0x${string}`): `0x${string}` {
  return keccak256(raw)
}

// Lightweight ABI-free `encodeFunctionData` alternative is not provided here
// — callers already use viem's encodeFunctionData to prepare `data`.

// Re-exported for convenience.
export { serializeTransaction }

// Print a small summary of bundle composition for logs.
export function summarizeBundle(txs: PuissantTx[]): string {
  return txs.map((t, i) =>
    `#${i} to=${t.to.slice(0, 10)}… value=${t.value ?? 0n} gas=${t.gas} gp=${Number(t.gasPrice) / 1e9}gwei`
  ).join(' | ')
}

// Debug helper — logs bundle result with consistent formatting.
export function logBundleResult(label: string, r: PuissantSubmitResult) {
  if (r.ok) {
    console.log(chalk.green(`[Puissant] ✓ ${label} 已提交: bundle=${r.bundleId ?? '(null)'} txs=${r.txHashes.length}`))
  } else {
    console.warn(chalk.yellow(`[Puissant] ✗ ${label} 失败: ${r.error}`))
  }
}
