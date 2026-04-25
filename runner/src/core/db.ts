import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'

const DB_DIR = join(homedir(), '.mevbot')
mkdirSync(DB_DIR, { recursive: true })

const TRADES_FILE = join(DB_DIR, 'trades.json')
const SNAPSHOTS_FILE = join(DB_DIR, 'snapshots.json')

export interface TradeRecord {
  id: string
  strategy: string
  token: string
  txHash?: string
  chain: string
  profitUSD: number
  gasUSD: number
  status: 'success' | 'failed' | 'pending'
  timestamp: number
}

interface Snapshot {
  t: number
  v: number
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJSON(file: string, data: unknown) {
  writeFileSync(file, JSON.stringify(data), 'utf-8')
}

export function saveTrade(trade: TradeRecord) {
  const trades = readJSON<TradeRecord[]>(TRADES_FILE, [])
  const idx = trades.findIndex((t) => t.id === trade.id)
  if (idx >= 0) trades[idx] = trade
  else trades.unshift(trade)
  // Keep last 2000 trades
  writeJSON(TRADES_FILE, trades.slice(0, 2000))
}

export function saveSnapshot(value: number) {
  const snaps = readJSON<Snapshot[]>(SNAPSHOTS_FILE, [])
  snaps.push({ t: Date.now(), v: value })
  // Keep last 288 snapshots (24h at 5min intervals)
  writeJSON(SNAPSHOTS_FILE, snaps.slice(-288))
}

export function resetData() {
  writeJSON(TRADES_FILE, [])
  writeJSON(SNAPSHOTS_FILE, [])
}

// One-shot migration: drop "fake success" records left by older versions.
// Pre-v0.6.1 arbitrage saved status=success even when the Puissant bundle
// was relay-accepted but never mined, producing $0 success rows. Some
// concurrent-strategy runs also caused inflated cross-attributed profits to
// be saved with txHash='' (no on-chain hash because we read balance delta
// before the actual tx confirmed). We strip both patterns.
export function pruneFakeTrades(): number {
  const trades = readJSON<TradeRecord[]>(TRADES_FILE, [])
  const before = trades.length
  const cleaned = trades.filter((t) => {
    // Drop pre-fix arb $0-success rows
    if (t.strategy === 'arbitrage' && t.status === 'success' && t.profitUSD === 0) return false
    // Drop any "success" without a real on-chain hash — those couldn't have
    // been confirmed on-chain
    if (t.status === 'success' && (!t.txHash || t.txHash === '')) return false
    return true
  })
  if (cleaned.length !== before) {
    writeJSON(TRADES_FILE, cleaned)
    // Snapshots derived from those trades are also stale — wipe them so the
    // pnl chart doesn't keep showing the inflated curve.
    writeJSON(SNAPSHOTS_FILE, [])
  }
  return before - cleaned.length
}

export function getPnLSummary() {
  const trades = readJSON<TradeRecord[]>(TRADES_FILE, [])
  const snaps = readJSON<Snapshot[]>(SNAPSHOTS_FILE, [])

  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayTrades = trades.filter((t) => t.timestamp > todayStart && t.status === 'success')
  const todayUSD = todayTrades.reduce((s, t) => s + t.profitUSD - t.gasUSD, 0)

  const allSuccess = trades.filter((t) => t.status === 'success')
  const totalUSD = allSuccess.reduce((s, t) => s + t.profitUSD - t.gasUSD, 0)

  const winCount = todayTrades.filter((t) => t.profitUSD > t.gasUSD).length
  const winRate = todayTrades.length > 0 ? (winCount / todayTrades.length) * 100 : 0

  return {
    totalUSD,
    todayUSD,
    weekUSD: 0,
    totalTrades: todayTrades.length,
    winRate,
    history: snaps,
  }
}
