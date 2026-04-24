export type WsMessage =
  | { type: 'status'; payload: StrategyStatus }
  | { type: 'opportunity'; payload: Opportunity }
  | { type: 'trade'; payload: Trade }
  | { type: 'pnl'; payload: PnLSnapshot }
  | { type: 'tokens'; strategy: string; payload: Token[] }
  | { type: 'token_analyzed'; payload: Token }
  | { type: 'wallet_balance'; payload: { bnb: number | null; address?: string; error?: string } }
  | { type: 'reset_ok'; payload: { ok: boolean } }
  | { type: 'connected'; payload: { version: string } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'mempool_tx'; payload: { hash: string; bnb: number; usd: number } }

export interface StrategyStatus {
  strategy: string
  running: boolean
  scanned: number
  pending: number
}

export interface Opportunity {
  id: string
  strategy: string
  token: string
  tokenAddress: string
  chain: string
  profitUSD: number
  profitNative: number
  gasUSD: number
  netProfit: number
  timestamp: number
}

export interface Trade {
  id: string
  strategy: string
  token: string
  txHash: string
  chain: string
  profitUSD: number
  gasUSD: number
  status: 'success' | 'failed' | 'pending'
  timestamp: number
}

export interface PnLSnapshot {
  totalUSD: number
  todayUSD: number
  weekUSD: number
  totalTrades: number
  winRate: number
  history: { t: number; v: number }[]
}

export interface Token {
  address: string
  symbol: string
  name: string
  chain: string
  liquidity: number
  volume24h: number
  score: number
  dex: string
  pairAddress: string
  price?: number
  priceUSD?: number
  // Safety fields (from checkSafety)
  safetyScore?: number
  isHoneypot?: boolean
  buyTax?: number
  sellTax?: number
  ownerRenounced?: boolean
  lpLocked?: boolean
  flags?: string[]
}

type Handler = (msg: WsMessage) => void

class WsClient {
  private ws: WebSocket | null = null
  private handlers: Handler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url = 'ws://localhost:8765'
  connected = false

  connect() {
    try {
      this.ws = new WebSocket(this.url)
      this.ws.onopen = () => {
        this.connected = true
        this.emit({ type: 'connected', payload: { version: '1.0.0' } })
      }
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as WsMessage
          this.handlers.forEach((h) => h(msg))
        } catch {}
      }
      this.ws.onclose = () => {
        this.connected = false
        this.scheduleReconnect()
      }
      this.ws.onerror = () => {
        this.ws?.close()
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 3000)
  }

  send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  on(handler: Handler) {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler)
    }
  }

  private emit(msg: WsMessage) {
    this.handlers.forEach((h) => h(msg))
  }
}

export const wsClient = new WsClient()
