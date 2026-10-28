/** Compatibility exports for the preserved dashboard. Web config lives in one place. */
import { siteConfig, factoryConfigured, configWarnings, explorerAddress, explorerTransaction, shortAddress } from './web/lib/site-config';
export const CHAIN_ID=siteConfig.chain.id;
export const CHAIN_NAME=siteConfig.chain.name;
export const EXPLORER_BASE=siteConfig.chain.explorer;
export const USDC_ADDRESS=siteConfig.usdc;
export const FACTORY_ADDRESS=siteConfig.writeFactory;
export const FACTORY_CONFIGURED=factoryConfigured;
export const CONFIG_WARNINGS=configWarnings;
export const buildExplorerTxUrl=explorerTransaction;
export const buildExplorerAddressUrl=explorerAddress;
export const shortenAddress=shortAddress;
