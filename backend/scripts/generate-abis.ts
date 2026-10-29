import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dir,'../..');
await mkdir(resolve(root,'backend/src/abi'),{recursive:true});
const names=['AgentWallet','AgentWalletV2','AgentWalletV3','AgentWalletFactory','AgentRegistry','ProviderRegistry','ReputationRegistry','DisputeVault'];
const getters=new Set(['owner','agentSigner','paused','factory','feeBps','settleWindow','domainSeparator','budgets','settled','nonces','signerValidUntil','usdc','relayers','dailyLimit','dailyLimitUsdE6','dailySpend','dailySpendUsdE6','currentDay','tokenRates','isAllowedToken','isFactoryWallet','walletsOf','getAgent','agentURI','metadataHash','getProvider','getProviderStats','getAgentStats','getSettlement','getDispute']);
for(const name of names){
 const artifact=await Bun.file(resolve(root,'contract/out',name+'.sol',name+'.json')).json();
 const abi=artifact.abi.filter((entry:{type:string;name?:string})=>entry.type==='event'||(entry.type==='function'&&(getters.has(entry.name||'')||(['AgentWallet','AgentWalletV2'].includes(name)&&entry.name==='settle'))));
 await Bun.write(resolve(root,'backend/src/abi',name+'.json'),JSON.stringify(abi));
}
console.log('Backend ABIs regenerated from Foundry artifacts.');
