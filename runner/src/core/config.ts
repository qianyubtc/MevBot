import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'

const CONFIG_DIR = join(homedir(), '.mevbot')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

mkdirSync(CONFIG_DIR, { recursive: true })

export interface RunnerConfig {
  chain: string
  rpcUrl: string
  privateKey: string
  walletAddress: string
  telegramToken: string
  telegramChatId: string
  maxGasGwei: number
  maxSlippage: number
  maxPositionUSD: number
  dailyLossLimit: number
}

const DEFAULTS: RunnerConfig = {
  chain: 'BSC',
  rpcUrl: 'https://bsc-dataseed.binance.org',
  privateKey: '',
  walletAddress: '',
  telegramToken: '',
  telegramChatId: '',
  maxGasGwei: 5,
  maxSlippage: 0.5,
  maxPositionUSD: 500,
  dailyLossLimit: 100,
}

export function loadConfig(): RunnerConfig {
  // Priority: config.json > .env > defaults
  // Only include env vars that are actually set (avoid overriding defaults with undefined)
  const fromEnv: Partial<RunnerConfig> = {}
  if (process.env.CHAIN) fromEnv.chain = process.env.CHAIN
  if (process.env.RPC_URL) fromEnv.rpcUrl = process.env.RPC_URL
  if (process.env.PRIVATE_KEY) fromEnv.privateKey = process.env.PRIVATE_KEY

  let fromFile: Partial<RunnerConfig> = {}
  try {
    if (existsSync(CONFIG_FILE)) {
      fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    }
  } catch {}

  return { ...DEFAULTS, ...fromEnv, ...fromFile }
}

export function saveConfig(patch: Partial<RunnerConfig>): RunnerConfig {
  const current = loadConfig()
  const updated = { ...current, ...patch }
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
