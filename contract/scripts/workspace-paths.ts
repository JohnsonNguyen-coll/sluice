import { fileURLToPath } from 'node:url';
export const CONTRACT_ROOT = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\','/').replace(/\/$/,'');
export const ONCHAIN_FACTS_FILE = CONTRACT_ROOT + '/config/onchain-facts.ts';
