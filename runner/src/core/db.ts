import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

const DB_DIR = join(homedir(), '.mevbot')
mkdirSync(DB_DIR, { recursive: true })

const db = new Database(join(DB_DIR, 'data.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    strategy TEXT NOT NULL,
    token TEXT NOT NULL,
    tx_hash TEXT,
    chain TEXT NOT NULL,
    profit_usd REAL NOT NULL,
    gas_usd REAL NOT NULL,
    status TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    value REAL NOT NULL
  );
`)

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

const insertTrade = db.prepare<TradeRecord>(`
  INSERT OR REPLACE INTO trades
  (id, strategy, token, tx_hash, chain, profit_usd, gas_usd, status, timestamp)
  VALUES (@id, @strategy, @token, @txHash, @chain, @profitUSD, @gasUSD, @status, @timestamp)
`)

const insertSnapshot = db.prepare<{ timestamp: number; value: number }>(
  'INSERT INTO pnl_snapshots (timestamp, value) VALUES (@timestamp, @value)'
)

const getTodayTrades = db.prepare<[]>(`
  SELECT * FROM trades
  WHERE timestamp > ? AND status = 'success'
  ORDER BY timestamp DESC
`)

const getAllTimeProfit = db.prepare<[]>(`
  SELECT COALESCE(SUM(profit_usd - gas_usd), 0) as total FROM trades WHERE status = 'success'
`)

const getHistory = db.prepare<[]>(`
  SELECT timestamp, value FROM pnl_snapshots
  ORDER BY timestamp ASC
  LIMIT 288
`)

export function saveTrade(trade: TradeRecord) {
  insertTrade.run(trade)
}

export function saveSnapshot(value: number) {
  insertSnapshot.run({ timestamp: Date.now(), value })
}

export function getPnLSummary() {
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayTrades = getTodayTrades.all(todayStart) as any[]
  const todayUSD = todayTrades.reduce((s, t) => s + t.profit_usd - t.gas_usd, 0)
  const { total } = getAllTimeProfit.get() as any

  const history = (getHistory.all() as any[]).map((r) => ({ t: r.timestamp, v: r.value }))
  const winCount = todayTrades.filter((t) => t.profit_usd > t.gas_usd).length
  const winRate = todayTrades.length > 0 ? (winCount / todayTrades.length) * 100 : 0

  return {
    totalUSD: total ?? 0,
    todayUSD,
    weekUSD: 0,
    totalTrades: todayTrades.length,
    winRate,
    history,
  }
}

export default db
