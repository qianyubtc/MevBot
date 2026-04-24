import { createPublicClient, createWalletClient, http, webSocket, type Chain, type Transport } from 'viem'
import { bsc, mainnet, arbitrum, base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

export const CHAINS: Record<string, Chain> = { BSC: bsc, ETH: mainnet, Arbitrum: arbitrum, Base: base }

export const DEX_ROUTERS: Record<string, Record<string, `0x${string}`>> = {
  BSC: {
    PancakeSwap: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    BiSwap: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
    MDEX: '0x62c1E3f9a3B16CCCEe6E24fB8aE68f0A6B3e6e79',
    BabySwap: '0x8317c460C22A9958c27b4aCD951f499a537b960d',
  },
}

export const DEX_FACTORIES: Record<string, Record<string, `0x${string}`>> = {
  BSC: {
    PancakeSwap: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    BiSwap: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
    MDEX: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
  },
}

// Pick transport based on URL scheme. Passing a wss:// URL to http() causes
// "fetch failed" because viem tries to POST to it. WSS is strongly preferred
// for sandwich strategy (eth_subscribe doesn't expire like HTTP filters).
export function buildClients(rpcUrl: string, privateKey: string, chainName: string, timeoutMs = 20000) {
  const chain = CHAINS[chainName] ?? bsc
  const isWss = /^wss?:\/\//i.test(rpcUrl)
  const transport: Transport = isWss
    ? webSocket(rpcUrl, { timeout: timeoutMs, reconnect: { attempts: 5, delay: 1000 } })
    : http(rpcUrl, { timeout: timeoutMs })

  const publicClient = createPublicClient({ chain, transport, batch: { multicall: true } })
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const walletClient = createWalletClient({ account, chain, transport })

  return { publicClient, walletClient, account, chain }
}
