import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import deployment from '../../contract/deployments/arc-testnet.json';
export type Factory={address:Address;version:1|2|3;negotiationVault?:Address};
export const ARC_PUBLIC_RPCS = [
 'https://rpc.testnet.arc.io',
 'https://rpc.blockdaemon.testnet.arc.io',
 'https://rpc.drpc.testnet.arc.io',
 'https://rpc.quicknode.testnet.arc.io',
] as const;
export type Config={host:string;port:number;chainId:number;authOrigin:string;rpcUrls:string[];supabaseUrl?:string;supabaseKey?:string;factories:Factory[];agentRegistry?:Address;providerRegistry?:Address;reputationRegistry?:Address;disputeVault?:Address;negotiationVaults?:Address[];legacyDisputeVaults?:Address[];policyAuthorityKey?:Hex;policyAuthoritySigner?:Address};
function addr(value:string|undefined){if(!value)return undefined;if(!isAddress(value))throw Error('Invalid configured contract address');return getAddress(value);}
export function loadConfig(env:Record<string,string|undefined>=process.env):Config{
 const manifest=deployment as unknown as {v1:{contracts:{AgentWalletFactory:{address:string}}};v2:{contracts:{AgentWalletFactoryV2:{address:string}}};v3?:{contracts:Record<string,{address:string}>};history?:{v1?:{contracts:{AgentWalletFactory:{address:string}}};v2?:{contracts:{AgentWalletFactoryV2:{address:string}}};v3?:{contracts:Record<string,{address:string}>}}[]};
 const origin=new URL(env.AUTH_ORIGIN||'http://127.0.0.1:3010');
 if(!['http:','https:'].includes(origin.protocol)||origin.origin!==origin.href.replace(/\/$/,''))throw Error('AUTH_ORIGIN must be an HTTP origin');
 const chainId=Number(env.CHAIN_ID||5042002),port=Number(env.PORT||3001);
 if(!Number.isSafeInteger(chainId)||chainId<1||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid chain ID or port');
 const canonical=chainId===5042002&&(!env.FACTORY_V1_ADDRESS||env.FACTORY_V1_ADDRESS.toLowerCase()===manifest.v1.contracts.AgentWalletFactory.address.toLowerCase())&&(!env.FACTORY_V2_ADDRESS||env.FACTORY_V2_ADDRESS.toLowerCase()===manifest.v2.contracts.AgentWalletFactoryV2.address.toLowerCase());
 const factories:Factory[]=[
  {address:addr(env.FACTORY_V1_ADDRESS||manifest.v1.contracts.AgentWalletFactory.address)!,version:1},
  {address:addr(env.FACTORY_V2_ADDRESS||manifest.v2.contracts.AgentWalletFactoryV2.address)!,version:2},
 ];
 const v3=env.FACTORY_V3_ADDRESS||(canonical?manifest.v3?.contracts.AgentWalletFactoryV3?.address:undefined);
 if(v3)factories.push({address:addr(v3)!,version:3});
 const known=[manifest,...(manifest.history||[])];
 // Custom factories do not implicitly trust unrelated deployments; canonical releases retain history.
 if(canonical){for(const item of known){const entries:[string|undefined,1|2|3][]=[[item.v1?.contracts.AgentWalletFactory.address,1],[item.v2?.contracts.AgentWalletFactoryV2.address,2],[item.v3?.contracts.AgentWalletFactoryV3?.address,3]];for(const [value,version]of entries){if(value&&!factories.some(f=>f.address.toLowerCase()===value.toLowerCase()))factories.push({address:addr(value)!,version});}}}
 if(env.SUPABASE_URL){const u=new URL(env.SUPABASE_URL);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Supabase requires HTTPS or local development');if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Invalid SUPABASE_URL');}
 const override=env.RPC_URLS?.trim()||env.RPC_URL?.trim();
 const primary=override?override.split(',').map(x=>x.trim()).filter(Boolean):chainId===5042002?[...ARC_PUBLIC_RPCS]:[];
 const alchemy=env.ALCHEMY_RPC_URL?.trim();
 // Keep the paid endpoint last even if it also appears in an explicit list.
 const rpcUrls=[...new Set([...primary.filter(url=>url!==alchemy),...(alchemy?[alchemy]:[])])];
 for(const value of rpcUrls){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.hash)throw Error('Invalid RPC URL');}
 const currentVault=addr(env.DISPUTE_VAULT_ADDRESS||(canonical?manifest.v3?.contracts.DisputeVault?.address:undefined));
 const policyAuthorityKey=env.POLICY_AUTHORITY_PRIVATE_KEY?.trim() as Hex|undefined;
 if(policyAuthorityKey&&(!isHex(policyAuthorityKey)||policyAuthorityKey.length!==66))throw Error('POLICY_AUTHORITY_PRIVATE_KEY must be a 32-byte hex private key');
 const policyAuthoritySigner=policyAuthorityKey?getAddress(privateKeyToAccount(policyAuthorityKey).address):undefined;
 const negotiationVaults:Address[]=[],legacyDisputeVaults:Address[]=[];
 if(canonical){for(const release of known){const vault=release.v3?.contracts.DisputeVault as {address:string;negotiationVersion?:number}|undefined;if(!vault)continue;const address=addr(vault.address)!;if(vault.negotiationVersion===1&&!negotiationVaults.includes(address))negotiationVaults.push(address);if(address.toLowerCase()!==currentVault?.toLowerCase()&&!legacyDisputeVaults.includes(address))legacyDisputeVaults.push(address);const factory=factories.find(f=>f.address.toLowerCase()===release.v3?.contracts.AgentWalletFactoryV3?.address.toLowerCase());if(factory&&vault.negotiationVersion===1)factory.negotiationVault=address;}}
 return {host:env.HOST||'127.0.0.1',port,chainId,authOrigin:origin.origin,rpcUrls,supabaseUrl:env.SUPABASE_URL,supabaseKey:env.SUPABASE_SERVICE_ROLE_KEY,factories,agentRegistry:addr(env.AGENT_REGISTRY_ADDRESS||(canonical?manifest.v3?.contracts.AgentRegistry?.address:undefined)),providerRegistry:addr(env.PROVIDER_REGISTRY_ADDRESS||(canonical?manifest.v3?.contracts.ProviderRegistry?.address:undefined)),reputationRegistry:addr(env.REPUTATION_REGISTRY_ADDRESS||(canonical?manifest.v3?.contracts.ReputationRegistry?.address:undefined)),disputeVault:currentVault,negotiationVaults,legacyDisputeVaults,policyAuthorityKey,policyAuthoritySigner};
}
