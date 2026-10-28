import deployment from '../../../deployments/arc-testnet.json';
export const siteConfig = {
 name: 'Sluice', protocol: 'AgentPay', description: 'Payment infrastructure for AI agents on Arc.',
 url: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
 chain: { id: deployment.chainId, name: deployment.network, explorer: 'https://explorer.testnet.arc.io', rpc: process.env.NEXT_PUBLIC_RPC_URL || 'https://rpc.testnet.arc.io', testnet: true },
 deployments: [
  { name: 'AgentWalletFactory', version: 'V1', address: deployment.v1.contracts.AgentWalletFactory.address },
  { name: 'AgentWalletFactoryV2', version: 'V2', address: deployment.v2.contracts.AgentWalletFactoryV2.address },
 ],
 usdc: deployment.v1.contracts.AgentWalletFactory.constructorArgs.usdc,
 writeFactory: process.env.NEXT_PUBLIC_FACTORY_ADDRESS || '',
} as const;
export const factoryConfigured = /^0x[0-9a-fA-F]{40}$/.test(siteConfig.writeFactory);
export const configWarnings = factoryConfigured ? [] : ['NEXT_PUBLIC_FACTORY_ADDRESS'];
export const explorerAddress = (address: string) => siteConfig.chain.explorer + '/address/' + address;
export const explorerTransaction = (hash: string) => siteConfig.chain.explorer + '/tx/' + hash;
export const shortAddress = (address: string) => address.length > 12 ? address.slice(0,6) + '…' + address.slice(-4) : address;
