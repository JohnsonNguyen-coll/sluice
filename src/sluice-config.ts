/**
 * Sluice dashboard configuration.
 * All chain and contract values are read from environment variables with safe defaults.
 * The dashboard renders in read-only mode when VITE_FACTORY_ADDRESS is not set.
 */

import { getUsdc, requireChain } from '@/onchain-facts'

// Arc Testnet is the default chain (chain ID 5042002)
const ARC_TESTNET_CHAIN_ID = 5042002

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? ARC_TESTNET_CHAIN_ID)

function resolveChain() {
  try {
    return requireChain(CHAIN_ID)
  } catch {
    return requireChain(ARC_TESTNET_CHAIN_ID)
  }
}

const chain = resolveChain()

export const CHAIN_NAME     = chain.name
export const EXPLORER_BASE  = chain.explorerBase
export const USDC_ADDRESS   = getUsdc(CHAIN_ID)?.address ?? getUsdc(ARC_TESTNET_CHAIN_ID)?.address ?? ''
export const FACTORY_ADDRESS = import.meta.env.VITE_FACTORY_ADDRESS as string | undefined

/** True when the factory address is present and looks like a valid hex address. */
export const FACTORY_CONFIGURED =
  typeof FACTORY_ADDRESS === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(FACTORY_ADDRESS)

/** Config warnings shown to the user. Populated when required env vars are missing. */
export const CONFIG_WARNINGS: string[] = []

if (!FACTORY_CONFIGURED) {
  CONFIG_WARNINGS.push('VITE_FACTORY_ADDRESS')
}
if (!USDC_ADDRESS) {
  CONFIG_WARNINGS.push('USDC_ADDRESS (chain not supported)')
}

export function buildExplorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE}/tx/${txHash}`
}

export function buildExplorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`
}

export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
