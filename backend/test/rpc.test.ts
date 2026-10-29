import {afterAll,test,expect} from 'bun:test';
import {createPublicClient} from 'viem';
import {ARC_PUBLIC_RPCS,loadConfig} from '../src/config';
import {publicRpcTransport} from '../src/rpc';
import {apiError} from '../src/errors';

const servers:ReturnType<typeof Bun.serve>[]=[];
function endpoint(handler:(method:string)=>unknown|Response|Promise<unknown|Response>){
 const calls:string[]=[];
 const server=Bun.serve({port:0,async fetch(req){
  const input=await req.json() as {id:number;method:string};calls.push(input.method);
  const result=await handler(input.method);
  return result instanceof Response?result:Response.json({jsonrpc:'2.0',id:input.id,result});
 }});
 servers.push(server);return {url:server.url.toString(),calls};
}
const healthy=(method:string)=>method==='eth_chainId'?'0x4cef52':'0x64';
function client(urls:string[],options:Parameters<typeof publicRpcTransport>[2]={}){
 return createPublicClient({transport:publicRpcTransport(urls,5042002,options),cacheTime:0});
}
afterAll(()=>servers.forEach(server=>server.stop(true)));

test('Arc defaults use four public RPCs; overrides are ordered, deduplicated and chain scoped',()=>{
 expect(loadConfig({}).rpcUrls).toEqual([...ARC_PUBLIC_RPCS]);
 expect(loadConfig({CHAIN_ID:'1'}).rpcUrls).toEqual([]);
 expect(loadConfig({RPC_URL:'http://localhost:1234'}).rpcUrls).toEqual(['http://localhost:1234']);
 expect(loadConfig({RPC_URLS:'https://one.test, https://two.test,https://one.test',RPC_URL:'https://ignored.test'}).rpcUrls).toEqual(['https://one.test','https://two.test']);
 expect(()=>loadConfig({RPC_URLS:'wss://invalid.test'})).toThrow('Invalid RPC URL');
});

test('Alchemy is an optional last resort after public RPCs, including duplicate overrides',()=>{
 const alchemy='https://arc-testnet.g.alchemy.com/v2/test-key';
 expect(loadConfig({ALCHEMY_RPC_URL:alchemy}).rpcUrls).toEqual([...ARC_PUBLIC_RPCS,alchemy]);
 expect(loadConfig({RPC_URLS:alchemy+',https://public.test,'+alchemy,ALCHEMY_RPC_URL:alchemy}).rpcUrls).toEqual(['https://public.test',alchemy]);
 expect(()=>loadConfig({ALCHEMY_RPC_URL:'wss://invalid.test'})).toThrow('Invalid RPC URL');
});

test('a working public RPC never calls the paid fallback',async()=>{
 const publicRpc=endpoint(healthy),paid=endpoint(healthy);
 expect(await client([publicRpc.url,paid.url]).getBlockNumber()).toBe(100n);
 expect(paid.calls).toEqual([]);
});

test('429 and 503 advance to the next RPC, cooldown skips failures and later recovers',async()=>{
 let now=1000,fail=true;
 const first=endpoint(method=>fail?new Response('',{status:429}):healthy(method));
 const second=endpoint(()=>new Response('',{status:503}));
 const third=endpoint(healthy),rpc=client([first.url,second.url,third.url],{now:()=>now});
 expect(await rpc.getBlockNumber()).toBe(100n);
 expect(first.calls).toHaveLength(1);expect(second.calls).toHaveLength(1);
 expect(await rpc.getBlockNumber()).toBe(100n);expect(first.calls).toHaveLength(1);
 fail=false;now+=30001;
 expect(await rpc.getBlockNumber()).toBe(100n);expect(first.calls).toContain('eth_blockNumber');
});

test('timeout moves to a healthy RPC within a bounded attempt',async()=>{
 const slow=endpoint(async()=>{await Bun.sleep(200);return '0x4cef52';});
 const next=endpoint(healthy);
 expect(await client([slow.url,next.url],{timeoutMs:40}).getBlockNumber()).toBe(100n);
 expect(slow.calls).toHaveLength(1);expect(next.calls).toContain('eth_blockNumber');
});

test('every fallback endpoint is checked for the expected chain before reading state',async()=>{
 const wrong=endpoint(()=>'0x1'),next=endpoint(healthy);
 expect(await client([wrong.url,next.url]).getBlockNumber()).toBe(100n);
 expect(wrong.calls).toEqual(['eth_chainId']);
 expect(next.calls).toEqual(['eth_chainId','eth_blockNumber']);
});

test('JSON-RPC rate limits during reads fail over; contract reverts stop immediately',async()=>{
 const limited=endpoint(method=>method==='eth_chainId'?healthy(method):Response.json({jsonrpc:'2.0',id:1,error:{code:-32005,message:'Rate limit exceeded'}}));
 const next=endpoint(healthy);
 expect(await client([limited.url,next.url]).getBlockNumber()).toBe(100n);
 const reverted=endpoint(method=>method==='eth_chainId'?healthy(method):Response.json({jsonrpc:'2.0',id:1,error:{code:3,message:'execution reverted',data:'0x'}}));
 const unused=endpoint(healthy);
 await expect(client([reverted.url,unused.url]).request({method:'eth_call',params:[{to:'0x0000000000000000000000000000000000000001'},'latest']})).rejects.toThrow('execution reverted');
 expect(unused.calls).toHaveLength(0);
});

test('an outage exhausts the list once, then fails fast during cooldown',async()=>{
 const first=endpoint(()=>new Response('',{status:503})),second=endpoint(()=>new Response('',{status:429}));
 const rpc=client([first.url,second.url]);
 await expect(rpc.getBlockNumber()).rejects.toThrow('All configured RPC');
 try{await rpc.getChainId();throw Error('Expected outage');}catch(error){expect(apiError(error)?.status).toBe(503);expect(apiError(error)?.code).toBe('RPC_UNAVAILABLE');}
 await expect(rpc.getBlockNumber()).rejects.toThrow('All configured RPC');
 expect(first.calls).toHaveLength(1);expect(second.calls).toHaveLength(1);
});
