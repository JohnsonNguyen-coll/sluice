import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createSiweMessage} from 'viem/siwe';
import {verifyMessage,keccak256,toHex} from 'viem';
import type {Config} from './config';
import type {Gateway} from './chain';
import type {Store} from './store';
import {ApiError,fail} from './errors';
import {address,hex,uint,page,body} from './validation';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data,(_,v)=>typeof v==='bigint'?v.toString():v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function createApi(config:Config,store:Store,chain:Gateway,clock:()=>number=Date.now){
 const limits=new Map<string,{count:number;until:number}>();
 function rate(key:string,max:number){const now=clock();for(const[k,v]of limits)if(v.until<=now)limits.delete(k);if(limits.size>=10000&&!limits.has(key))fail(429,'RATE_LIMITED','Retry later');let r=limits.get(key);if(!r){r={count:0,until:now+60000};limits.set(key,r);}if(++r.count>max)fail(429,'RATE_LIMITED','Retry after one minute');}
 async function actor(req:Request){const token=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];if(!token)fail(401,'UNAUTHORIZED','A wallet session bearer token is required');const value=await store.session(digest(token));if(!value)fail(401,'UNAUTHORIZED','Session expired or invalid');return address(value);}
 async function route(req:Request,url:URL){
  const path=url.pathname.replace(/\/$/,'')||'/';
  if(path==='/health'&&req.method==='GET'){
   const status=await Promise.allSettled([store.health(),chain.health()]);
   const database=status[0].status==='fulfilled'?'ready':'unavailable',rpc=status[1].status==='fulfilled'?'ready':'unavailable';
   return json({service:'sluice-backend',status:database==='ready'&&rpc==='ready'?'ready':'degraded',database,rpc,capabilities:{auth:'SIWE bearer sessions',voucherIntake:'V1/V2 authorization queue; no automatic settlement',receipts:'not implemented: Phase 3 checkpoint',reads:'RPC block-window queries; no indexer'}});
  }
  if(path==='/auth/nonce'&&req.method==='POST'){
   const input=await body(req);const owner=address(input.address);const now=clock();const expires=new Date(now+300000);const nonce=randomBytes(16).toString('hex');
   const message=createSiweMessage({address:owner,chainId:config.chainId,domain:new URL(config.authOrigin).host,scheme:new URL(config.authOrigin).protocol.slice(0,-1),uri:config.authOrigin,version:'1',nonce,issuedAt:new Date(now),expirationTime:expires,statement:'Sign in to Sluice. This does not authorize a payment.'});
   const id=randomUUID();await store.putChallenge({id,address:owner.toLowerCase(),message,expires_at:expires.toISOString()});
   return json({id,nonce,message,expiresAt:expires.toISOString(),walletSupport:config.rpcUrl?'EOA and RPC-supported contract wallets':'EOA only until RPC_URL is configured'},201);
  }
  if(path==='/auth/verify'&&req.method==='POST'){
   const input=await body(req);if(typeof input.id!=='string'||! /^[a-f0-9-]{36}$/.test(input.id))fail(400,'INVALID_INPUT','Invalid challenge ID');
   const challenge=await store.getChallenge(input.id);if(!challenge||challenge.consumed_at||Date.parse(challenge.expires_at)<=clock())fail(401,'INVALID_CHALLENGE','Challenge expired or already used');
   const signature=hex(input.signature);if(signature.length>8194)fail(400,'INVALID_SIGNATURE','Signature is too large');
   const signer=address(challenge.address);let valid=false;
   try{valid=config.rpcUrl?await chain.verifyLogin(signer,challenge.message,signature):await verifyMessage({address:signer,message:challenge.message,signature});}catch(error){if(error instanceof ApiError&&error.status===503)throw error;}
   if(!valid)fail(401,'INVALID_SIGNATURE','Signature does not match the challenge');
   const token=randomBytes(32).toString('hex');if(!await store.consumeChallenge(challenge.id,digest(token)))fail(401,'INVALID_CHALLENGE','Challenge expired or already used');
   return json({token,tokenType:'Bearer',expiresIn:3600,address:signer});
  }
  if(path==='/auth/me'&&req.method==='GET')return json({address:await actor(req)});
  if(path==='/auth/logout'&&req.method==='POST'){await actor(req);await store.logout(digest(req.headers.get('authorization')!.slice(7)));return json({loggedOut:true});}
  if(path==='/wallets'&&req.method==='GET')return json(await chain.wallets(address(url.searchParams.get('owner'),'owner'),url));
  let match=path.match(/^\/wallets\/([^/]+)(?:\/(budgets|activity))?$/);
  if(match&&req.method==='GET'){const wallet=address(match[1],'wallet');if(match[2]==='budgets')return json(await chain.budgets(wallet,address(url.searchParams.get('provider'),'provider'),url.searchParams.has('token')?address(url.searchParams.get('token'),'token'):undefined));if(match[2]==='activity')return json(await chain.activity(wallet,url));return json(await chain.wallet(wallet));}
  match=path.match(/^\/agents\/([^/]+)$/);if(match&&req.method==='GET')return json(await chain.agent(uint(match[1])));
  match=path.match(/^\/providers\/([^/]+)$/);if(match&&req.method==='GET')return json(await chain.provider(address(match[1])));
  match=path.match(/^\/reputation\/([^/]+)$/);if(match&&req.method==='GET')return json(await chain.reputation(address(match[1])));
  if(path==='/vouchers'&&req.method==='POST'){
   const provider=await actor(req);const input=await body(req);const validated=await chain.validateVoucher(input,provider);
   const record={...validated,received_at:new Date(clock()).toISOString()};const status=await store.putVoucher(record);
   if(status==='stale')fail(409,'STALE_VOUCHER','Voucher does not advance the saved channel');
   return json({id:validated.id,status,settlement:'not submitted',notice:'Authorization stored only. No funds are reserved; on-chain state may change.'},status==='created'?201:200);
  }
  if(path==='/vouchers'&&req.method==='GET'){const provider=await actor(req);const {limit,offset}=page(url);return json({items:await store.vouchers(provider.toLowerCase(),limit,offset),limit,offset});}
  if(path==='/settlements'&&req.method==='GET')return json(await chain.settlements(url));
  if(path==='/disputes'&&req.method==='GET')return json(await chain.settlements(url,true));
  match=path.match(/^\/(settlements|disputes)\/(0x[a-fA-F0-9]{64})$/);if(match&&req.method==='GET')return json(await chain.settlement(hex(match[2],32),match[1]==='disputes'));
  match=path.match(/^\/disputes\/(0x[a-fA-F0-9]{64})\/evidence$/);
  if(match&&(req.method==='POST'||req.method==='GET')){
   const id=hex(match[1],32),who=await actor(req);await chain.authorizeEvidence(id,who);
   if(req.method==='GET')return json({items:await store.evidence(id.toLowerCase()),limit:100});
   const input=await body(req);if(typeof input.content!=='string'||!input.content.trim()||new TextEncoder().encode(input.content).length>16384)fail(400,'INVALID_EVIDENCE','content must be nonempty UTF-8 text of at most 16 KiB');
   const hash=keccak256(toHex(input.content));await store.addEvidence({id:hash,settlement_id:id.toLowerCase(),author:who.toLowerCase(),content:input.content,created_at:new Date(clock()).toISOString()});
   return json({evidenceHash:hash,stored:true,onChain:false,notice:'Submit this hash through the relevant contract transaction yourself.'},201);
  }
  if(/^\/receipts\/[^/]+$/.test(path)&&req.method==='GET')fail(501,'RECEIPTS_PENDING','Signed receipt storage and verification await the Phase 3 checkpoint');
  fail(404,'NOT_FOUND','Route not found');
 }
 return async function fetchApi(req:Request,ip='local'){
  let response:Response;const origin=req.headers.get('origin');
  try{
   if(origin&&origin!==config.authOrigin)fail(403,'ORIGIN_DENIED','Origin is not allowed');
   rate('all:'+ip,120);
   const url=new URL(req.url);if(url.pathname.startsWith('/auth/'))rate('auth:'+ip,20);
   if(req.method==='OPTIONS')response=new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}});
   else response=await route(req,url);
  }catch(error){
   if(error instanceof ApiError)response=json({error:{code:error.code,message:error.message}},error.status);
   else response=json({error:{code:'UPSTREAM_FAILURE',message:'The data source could not complete this request'}},502);
  }
  response.headers.set('Vary','Origin');response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');
  if(origin===config.authOrigin)response.headers.set('Access-Control-Allow-Origin',origin);
  if(response.status===429)response.headers.set('Retry-After','60');
  return response;
 };
}
