import { createPublicClient, http, getAddress, parseEventLogs, recoverTypedDataAddress, hashTypedData, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import type {Config} from './config';
import {fail} from './errors';
import {address,uint,hex,page} from './validation';
import walletV1 from './abi/AgentWallet.json';
import walletV2 from './abi/AgentWalletV2.json';
import walletV3 from './abi/AgentWalletV3.json';
import factoryAbi from './abi/AgentWalletFactory.json';
import agentAbi from './abi/AgentRegistry.json';
import providerAbi from './abi/ProviderRegistry.json';
import reputationAbi from './abi/ReputationRegistry.json';
import vaultAbi from './abi/DisputeVault.json';
export type WalletState={address:Address;version:1|2|3;owner:Address;agentSigner:Address;paused:boolean;factory:Address;blockNumber:bigint};
export type ValidVoucher={id:Hex;channel:string;chain_id:number;wallet:string;provider:string;token:string;nonce:string;cumulative_amount:string;payload:unknown;signature:Hex};
export interface Gateway{
 health():Promise<unknown>;
 verifyLogin(address:Address,message:string,signature:Hex):Promise<boolean>;
 wallets(owner:Address,url:URL):Promise<unknown>;
 wallet(wallet:Address):Promise<WalletState>;
 budgets(wallet:Address,provider:Address,token?:Address):Promise<unknown>;
 activity(wallet:Address,url:URL):Promise<unknown>;
 agent(id:bigint):Promise<unknown>;
 provider(provider:Address):Promise<unknown>;
 reputation(account:Address):Promise<unknown>;
 settlements(url:URL,disputes?:boolean):Promise<unknown>;
 settlement(id:Hex,dispute?:boolean):Promise<unknown>;
 authorizeEvidence(id:Hex,actor:Address):Promise<void>;
 validateVoucher(body:Record<string,unknown>,actor:Address):Promise<ValidVoucher>;
}
const ZERO='0x0000000000000000000000000000000000000000';
const walletAbis={1:walletV1 as Abi,2:walletV2 as Abi,3:walletV3 as Abi};
const typesBase=[{name:'wallet',type:'address'},{name:'provider',type:'address'}];
export class RpcGateway implements Gateway{
 private client;
 constructor(private config:Config){this.client=createPublicClient({transport:http(config.rpcUrl||'http://127.0.0.1:1',{timeout:8000,retryCount:0})});}
 private async ready(){if(!this.config.rpcUrl)fail(503,'RPC_NOT_CONFIGURED','Configure RPC_URL');if(await this.client.getChainId()!==this.config.chainId)fail(503,'CHAIN_MISMATCH','RPC chain does not match CHAIN_ID');}
 private configured(value:Address|undefined,name:string):Address{if(!value)fail(503,'CONTRACT_NOT_CONFIGURED','Configure '+name+' with a verified deployment');return value;}
 private async read(at:Address,abi:Abi,functionName:string,args:readonly unknown[]=[],blockNumber?:bigint):Promise<unknown>{return this.client.readContract({address:at,abi,functionName,args,blockNumber});}
 async health(){await this.ready();return {chainId:this.config.chainId,blockNumber:await this.client.getBlockNumber()};}
 async verifyLogin(at:Address,message:string,signature:Hex){await this.ready();return this.client.verifyMessage({address:at,message,signature});}
 async wallet(at:Address):Promise<WalletState>{
  await this.ready();const blockNumber=await this.client.getBlockNumber();
  const matches=await Promise.all(this.config.factories.map(async entry=>({entry,registered:await this.read(entry.address,factoryAbi as Abi,'isFactoryWallet',[at],blockNumber)})));
  const entry=matches.find(x=>x.registered===true)?.entry;
  if(!entry)fail(404,'UNTRUSTED_WALLET','Wallet is not recorded by a configured factory');
  const abi=walletAbis[entry.version];
  const [owner,agentSigner,paused]=await Promise.all(['owner','agentSigner','paused'].map(fn=>this.read(at,abi,fn,[],blockNumber)));
  return {address:at,version:entry.version,owner:getAddress(owner as Address),agentSigner:getAddress(agentSigner as Address),paused:paused as boolean,factory:entry.address,blockNumber};
 }
 async wallets(owner:Address,url:URL){
  await this.ready();const {limit,offset}=page(url);const blockNumber=await this.client.getBlockNumber();
  const groups=await Promise.all(this.config.factories.map(async f=>({version:f.version,factory:f.address,addresses:await this.read(f.address,factoryAbi as Abi,'walletsOf',[owner],blockNumber) as Address[]})));
  const all=groups.flatMap(g=>g.addresses.map(wallet=>({wallet,factory:g.factory,version:g.version})));
  return {items:all.slice(offset,offset+limit),total:all.length,limit,offset,blockNumber,scope:'Factory creation records for this owner; not an ownership-transfer index'};
 }
 async budgets(at:Address,provider:Address,token?:Address){
  const state=await this.wallet(at);const abi=walletAbis[state.version];const selected=state.version===1?await this.read(at,abi,'usdc',[],state.blockNumber) as Address:token;
  if(!selected)fail(400,'TOKEN_REQUIRED','token query parameter is required for multi-token wallets');
  const args=state.version===1?[provider]:[provider,selected];
  const [budget,settled,nonce]=await Promise.all(['budgets','settled','nonces'].map(fn=>this.read(at,abi,fn,args,state.blockNumber)));
  return {provider,token:selected,budget,settled,nonce,blockNumber:state.blockNumber};
 }
 private async logs(at:Address,abi:Abi,url:URL,eventName?:string){
  await this.ready();const head=await this.client.getBlockNumber();const safe=head>2n?head-2n:0n;
  const to=url.searchParams.has('toBlock')?uint(url.searchParams.get('toBlock')):safe;
  const from=url.searchParams.has('fromBlock')?uint(url.searchParams.get('fromBlock')):to>999n?to-999n:0n;
  if(to>safe||from>to||to-from>=5000n)fail(400,'INVALID_BLOCK_RANGE','Use a confirmed range of at most 5000 blocks; latest two blocks are excluded');
  const event=eventName?abi.find(x=>x.type==='event'&&x.name===eventName) as AbiEvent|undefined:undefined;
  const logs=event?await this.client.getLogs({address:at,fromBlock:from,toBlock:to,event}):await this.client.getLogs({address:at,fromBlock:from,toBlock:to});
  if(logs.length>1000)fail(413,'RANGE_TOO_DENSE','Narrow the block range');
  const decoded=parseEventLogs({abi,logs,strict:false}).filter(log=>!eventName||log.eventName===eventName);
  const {limit,offset}=page(url);
  return {items:decoded.slice(offset,offset+limit),total:decoded.length,limit,offset,fromBlock:from,toBlock:to,nextFromBlock:to+1n,confirmations:2,scope:'This block window only; no full-history index'};
 }
 async activity(at:Address,url:URL){const state=await this.wallet(at);return this.logs(at,walletAbis[state.version],url);}
 async agent(id:bigint){await this.ready();const at=this.configured(this.config.agentRegistry,'AGENT_REGISTRY_ADDRESS');const [entry,uri,metadataHash]=await Promise.all([this.read(at,agentAbi as Abi,'getAgent',[id]),this.read(at,agentAbi as Abi,'agentURI',[id]),this.read(at,agentAbi as Abi,'metadataHash',[id])]);return {id,entry,uri,metadataHash};}
 async provider(at:Address){await this.ready();const entry=await this.read(this.configured(this.config.providerRegistry,'PROVIDER_REGISTRY_ADDRESS'),providerAbi as Abi,'getProvider',[at]);return {address:at,entry};}
 async reputation(at:Address){await this.ready();const registry=this.configured(this.config.reputationRegistry,'REPUTATION_REGISTRY_ADDRESS');const [provider,agent]=await Promise.all([this.read(registry,reputationAbi as Abi,'getProviderStats',[at]),this.read(registry,reputationAbi as Abi,'getAgentStats',[at])]);return {address:at,provider,agent,score:null,scope:'Raw on-chain counters; no invented aggregate score'};}
 async settlements(url:URL,disputes=false){if(!disputes&&url.searchParams.has('wallet')){const wallet=await this.wallet(address(url.searchParams.get('wallet')));return this.logs(wallet.address,walletAbis[wallet.version],url,'Settled');}return this.logs(this.configured(this.config.disputeVault,'DISPUTE_VAULT_ADDRESS'),vaultAbi as Abi,url,disputes?'DisputeOpened':'SettlementReceived');}
 async settlement(id:Hex,dispute=false){
  await this.ready();const at=this.configured(this.config.disputeVault,'DISPUTE_VAULT_ADDRESS');const settlement=await this.read(at,vaultAbi as Abi,'getSettlement',[id]) as {wallet:Address;provider:Address};
  if(settlement.wallet.toLowerCase()===ZERO)fail(404,'SETTLEMENT_NOT_FOUND','Unknown settlement');
  if(!dispute)return {id,settlement};
  const details=await this.read(at,vaultAbi as Abi,'getDispute',[id]) as {openedAt:bigint};
  if(details.openedAt===0n)fail(404,'DISPUTE_NOT_FOUND','No dispute opened for this settlement');
  return {id,settlement,dispute:details};
 }
 async authorizeEvidence(id:Hex,actor:Address){const entry=await this.settlement(id,true) as {settlement:{wallet:Address;provider:Address};dispute:{openedAt:bigint}};if(entry.dispute.openedAt===0n)fail(404,'DISPUTE_NOT_FOUND','No dispute opened for this settlement');const owner=await this.read(entry.settlement.wallet,walletAbis[3],'owner') as Address;if(![owner.toLowerCase(),entry.settlement.provider.toLowerCase()].includes(actor.toLowerCase()))fail(403,'FORBIDDEN','Only the wallet owner or provider may access dispute evidence');}
 async validateVoucher(input:Record<string,unknown>,actor:Address):Promise<ValidVoucher>{
  const at=address(input.wallet,'wallet'),provider=address(input.provider,'provider'),signature=hex(input.signature,65);
  if(provider.toLowerCase()!==actor.toLowerCase())fail(403,'FORBIDDEN','Authenticate as the voucher provider');
  const state=await this.wallet(at);if(state.version===3)fail(501,'V3_RECEIPTS_PENDING','V3 voucher intake awaits the Phase 3 receipt checkpoint');
  const token=state.version===1?await this.read(at,walletAbis[1],'usdc',[],state.blockNumber) as Address:address(input.token,'token');
  const cumulativeAmount=uint(input.cumulativeAmount),nonce=uint(input.nonce),expiry=uint(input.expiry,64);
  if(state.paused)fail(409,'WALLET_PAUSED','Wallet is paused');
  const block=await this.client.getBlock({blockNumber:state.blockNumber});if(expiry<block.timestamp)fail(409,'VOUCHER_EXPIRED','Voucher has expired');
  const message={wallet:at,provider,...(state.version===1?{}:{token}),cumulativeAmount,nonce,expiry};
  const types={Voucher:[...typesBase,...(state.version===1?[]:[{name:'token',type:'address'}]),{name:'cumulativeAmount',type:'uint256'},{name:'nonce',type:'uint256'},{name:'expiry',type:'uint64'}]};
  const domain={name:state.version===1?'AgentPay':'AgentPayV2',version:state.version===1?'1':'2',chainId:this.config.chainId,verifyingContract:at};
  let signer:Address;try{signer=await recoverTypedDataAddress({domain,types,primaryType:'Voucher',message,signature});}catch{fail(401,'INVALID_SIGNATURE','Invalid voucher signature');}
  const validUntil=await this.read(at,walletAbis[state.version],'signerValidUntil',[signer],state.blockNumber) as bigint;
  if(validUntil<block.timestamp)fail(401,'INVALID_SIGNATURE','Signer is not authorized');
  const budget=await this.budgets(at,provider,token) as {budget:readonly[bigint,bigint];settled:bigint;nonce:bigint};
  if(nonce<=budget.nonce||cumulativeAmount<=budget.settled)fail(409,'STALE_VOUCHER','Voucher does not advance on-chain state');
  if(cumulativeAmount>budget.budget[0])fail(409,'BUDGET_EXCEEDED','Voucher exceeds provider budget');
  const delta=cumulativeAmount-budget.settled;if(budget.budget[1]>0n&&delta>budget.budget[1])fail(409,'PER_CALL_CAP_EXCEEDED','Voucher delta exceeds contract cap');
  // Simulation includes token allowlist, balance, daily limits and authorization.
  try{await this.client.simulateContract({address:at,abi:walletAbis[state.version],functionName:'settle',account:provider,args:state.version===1?[message,signature]:[message,signature,0n]});}catch{fail(409,'SETTLEMENT_SIMULATION_FAILED','Voucher cannot currently settle without swap parameters');}
  const id=hashTypedData({domain,types,primaryType:'Voucher',message});
  return {id,channel:[this.config.chainId,at,provider,token].join(':').toLowerCase(),chain_id:this.config.chainId,wallet:at.toLowerCase(),provider:provider.toLowerCase(),token:token.toLowerCase(),nonce:nonce.toString(),cumulative_amount:cumulativeAmount.toString(),payload:JSON.parse(JSON.stringify(message,(_,v)=>typeof v==='bigint'?v.toString():v)),signature};
 }
}
