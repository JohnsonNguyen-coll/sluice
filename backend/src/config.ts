import { getAddress, isAddress, type Address } from 'viem';
export type Factory={address:Address;version:1|2|3};
export type Config={host:string;port:number;chainId:number;authOrigin:string;rpcUrl?:string;supabaseUrl?:string;supabaseKey?:string;factories:Factory[];agentRegistry?:Address;providerRegistry?:Address;reputationRegistry?:Address;disputeVault?:Address};
function addr(value:string|undefined){if(!value)return undefined;if(!isAddress(value))throw Error('Invalid configured contract address');return getAddress(value);}
export function loadConfig(env:Record<string,string|undefined>=process.env):Config{
 const origin=new URL(env.AUTH_ORIGIN||'http://127.0.0.1:3010');
 if(!['http:','https:'].includes(origin.protocol)||origin.origin!==origin.href.replace(/\/$/,''))throw Error('AUTH_ORIGIN must be an HTTP origin');
 const chainId=Number(env.CHAIN_ID||5042002),port=Number(env.PORT||3001);
 if(!Number.isSafeInteger(chainId)||chainId<1||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid chain ID or port');
 const factories:Factory[]=[
  {address:addr(env.FACTORY_V1_ADDRESS||'0xdae395f504be412ddfc0646b37ac1840a1462c08')!,version:1},
  {address:addr(env.FACTORY_V2_ADDRESS||'0x92f357b256f5fb6a0f7e635a29462601c1cb6547')!,version:2},
 ];
 if(env.FACTORY_V3_ADDRESS)factories.push({address:addr(env.FACTORY_V3_ADDRESS)!,version:3});
 if(env.SUPABASE_URL){const u=new URL(env.SUPABASE_URL);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Supabase requires HTTPS or local development');if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Invalid SUPABASE_URL');}
 if(env.RPC_URL&&!['http:','https:'].includes(new URL(env.RPC_URL).protocol))throw Error('Invalid RPC URL');
 return {host:env.HOST||'127.0.0.1',port,chainId,authOrigin:origin.origin,rpcUrl:env.RPC_URL,supabaseUrl:env.SUPABASE_URL,supabaseKey:env.SUPABASE_SERVICE_ROLE_KEY,factories,agentRegistry:addr(env.AGENT_REGISTRY_ADDRESS),providerRegistry:addr(env.PROVIDER_REGISTRY_ADDRESS),reputationRegistry:addr(env.REPUTATION_REGISTRY_ADDRESS),disputeVault:addr(env.DISPUTE_VAULT_ADDRESS)};
}
