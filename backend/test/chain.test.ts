import {test,expect,afterAll} from 'bun:test';
import {privateKeyToAccount} from 'viem/accounts';
import {decodeFunctionData,encodeFunctionResult,type Abi,type Hex,type Address} from 'viem';
import {RpcGateway} from '../src/chain';
import {loadConfig} from '../src/config';
import v1 from '../src/abi/AgentWallet.json';
import v2 from '../src/abi/AgentWalletV2.json';
import factory from '../src/abi/AgentWalletFactory.json';
const agent=privateKeyToAccount(('0x'+'11'.repeat(32)) as Hex);
const owner=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);
const provider=privateKeyToAccount(('0x'+'33'.repeat(32)) as Hex);
const wallet1=('0x'+'44'.repeat(20)) as Address,wallet2=('0x'+'55'.repeat(20)) as Address;
const factory1=('0x'+'66'.repeat(20)) as Address,factory2=('0x'+'77'.repeat(20)) as Address;
const token=('0x'+'88'.repeat(20)) as Address;
let chainId=5042002,paused=false,lastNonce=0n;
const timestamp=BigInt(Math.floor(Date.now()/1000));
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const request=await req.json() as {id:number;method:string;params:unknown[]};
 try{
 let result:unknown;
 if(request.method==='eth_chainId')result='0x'+chainId.toString(16);
 else if(request.method==='eth_blockNumber')result='0x64';
 else if(request.method==='eth_getLogs')result=[];
 else if(request.method==='eth_getBlockByNumber')result={number:'0x64',timestamp:'0x'+timestamp.toString(16),hash:'0x'+'aa'.repeat(32),parentHash:'0x'+'bb'.repeat(32),nonce:'0x0000000000000000',sha3Uncles:'0x'+'00'.repeat(32),logsBloom:'0x'+'00'.repeat(256),transactionsRoot:'0x'+'00'.repeat(32),stateRoot:'0x'+'00'.repeat(32),receiptsRoot:'0x'+'00'.repeat(32),miner:owner.address,difficulty:'0x0',totalDifficulty:'0x0',extraData:'0x',size:'0x0',gasLimit:'0x100000',gasUsed:'0x0',transactions:[],uncles:[]};
 else if(request.method==='eth_call'){
  const call=request.params[0] as {to:Address;data:Hex};const to=call.to.toLowerCase();
  const abi=(to===factory1||to===factory2?factory:to===wallet1?v1:v2) as Abi;
  const decoded=decodeFunctionData({abi,data:call.data});const fn=decoded.functionName;
  const values:Record<string,unknown>={factory:to===wallet1?factory1:factory2,isFactoryWallet:decoded.args?.[0]===(to===factory1?wallet1:wallet2),owner:owner.address,agentSigner:agent.address,paused,usdc:token,signerValidUntil:decoded.args?.[0]===agent.address?2n**256n-1n:0n,budgets:[1000n,100n],settled:0n,nonces:lastNonce,walletsOf:[to===factory1?wallet1:wallet2]};
  result=fn==='settle'?'0x':encodeFunctionResult({abi,functionName:fn,result:values[fn]});
 }else throw Error('Unexpected method '+request.method);
 return Response.json({jsonrpc:'2.0',id:request.id,result});
 }catch{ return Response.json({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Mock RPC rejected request'}});}
}});
const config=loadConfig({RPC_URL:server.url.toString(),FACTORY_V1_ADDRESS:factory1,FACTORY_V2_ADDRESS:factory2});
const gateway=new RpcGateway(config);
afterAll(()=>server.stop(true));
const baseTypes=[{name:'wallet',type:'address'},{name:'provider',type:'address'}];
async function signed(version:1|2,wrongDomain=false){
 const wallet=version===1?wallet1:wallet2;
 const fields=[...baseTypes,...(version===1?[]:[{name:'token',type:'address'}]),{name:'cumulativeAmount',type:'uint256'},{name:'nonce',type:'uint256'},{name:'expiry',type:'uint64'}];
 const message={wallet,provider:provider.address,...(version===1?{}:{token}),cumulativeAmount:10n,nonce:1n,expiry:timestamp+600n};
 const signature=await agent.signTypedData({domain:{name:version===1?'AgentPay':'AgentPayV2',version:version===1?'1':'2',chainId:wrongDomain?1:5042002,verifyingContract:wallet},types:{Voucher:fields},primaryType:'Voucher',message});
 return {wallet,provider:provider.address,token,cumulativeAmount:'10',nonce:'1',expiry:String(timestamp+600n),signature};
}
test('RPC-backed wallet and budget reads preserve amounts as bigint',async()=>{
 const state=await gateway.wallet(wallet2);expect(state.owner).toBe(owner.address);expect(state.version).toBe(2);
 const budget=await gateway.budgets(wallet2,provider.address,token) as {budget:bigint[]};expect(budget.budget).toEqual([1000n,100n]);
 const wallets=await gateway.wallets(owner.address,new URL('http://api/wallets?limit=1')) as {items:unknown[];total:number};expect(wallets.items).toHaveLength(1);expect(wallets.total).toBe(2);
});
test('voucher validation uses distinct V1/V2 domains and enforces provider identity',async()=>{
 for(const version of [1,2] as const){const data=await signed(version);const validated=await gateway.validateVoucher(data,provider.address);expect(validated.nonce).toBe('1');expect(validated.id).toMatch(/^0x[a-f0-9]{64}$/);
 await expect(gateway.validateVoucher(await signed(version,true),provider.address)).rejects.toThrow('Signer is not authorized');
 await expect(gateway.validateVoucher(data,owner.address)).rejects.toThrow('Authenticate as the voucher provider');}
});
test('paused wallets and stale chain nonces fail before saving',async()=>{
 const data=await signed(2);paused=true;await expect(gateway.validateVoucher(data,provider.address)).rejects.toThrow('Wallet is paused');paused=false;
 lastNonce=1n;await expect(gateway.validateVoucher(data,provider.address)).rejects.toThrow('does not advance');lastNonce=0n;
});
test('chain mismatch, missing config, and oversized log windows fail closed',async()=>{
 await expect(gateway.agent(1n)).rejects.toThrow('AGENT_REGISTRY_ADDRESS');
 await expect(gateway.activity(wallet1,new URL('http://api?fromBlock=0&toBlock=99999'))).rejects.toThrow('confirmed range');
 await expect(new RpcGateway(loadConfig({CHAIN_ID:'31337'})).health()).rejects.toThrow('RPC_URL');
 chainId=1;await expect(gateway.wallet(wallet1)).rejects.toThrow('does not match');chainId=5042002;
});
