import {assistantConfig,analyzeDispute} from './dispute-assistant';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createSiweMessage} from 'viem/siwe';
import {verifyMessage,keccak256,toHex,type Address} from 'viem';
import type {Config} from './config';
import type {Gateway} from './chain';
import type {Store} from './store';
import {apiError,fail} from './errors';
import {verifyReceipt,receiptHash,computeReputation,type ReputationInput} from '@sluice/sdk';
import {SupabaseCatalogStore,shortText,httpsUrl,type CatalogStore,type ApiListing} from './catalog';
import deployment from '../../contract/deployments/arc-testnet.json';
import {parseUnits} from 'viem';
import {address,hex,uint,page,body} from './validation';
import type {HostedApi} from './managed-host';
import {PolicyAuthority} from './policy-authority';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data,(_,v)=>typeof v==='bigint'?v.toString():v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function createApi(config:Config,store:Store,chain:Gateway,clock:()=>number=Date.now,catalog:CatalogStore=new SupabaseCatalogStore(config),hosted?:HostedApi){
 const limits=new Map<string,{count:number;until:number}>();
 const policy=config.policyAuthorityKey?new PolicyAuthority(config):undefined;
 function rate(key:string,max:number){const now=clock();for(const[k,v]of limits)if(v.until<=now)limits.delete(k);if(limits.size>=10000&&!limits.has(key))fail(429,'RATE_LIMITED','Retry later');let r=limits.get(key);if(!r){r={count:0,until:now+60000};limits.set(key,r);}if(++r.count>max)fail(429,'RATE_LIMITED','Retry after one minute');}
 async function actor(req:Request){const token=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];if(!token)fail(401,'UNAUTHORIZED','A wallet session bearer token is required');const value=await store.session(digest(token));if(!value)fail(401,'UNAUTHORIZED','Session expired or invalid');return address(value);}
 async function authorizeEvidence(id:ReturnType<typeof hex>,who:Address){try{await chain.authorizeEvidence(id,who);}catch(error){if(!hosted||apiError(error)?.status!==403)throw error;const entry=await chain.settlement(id,true) as {settlement:{provider:Address}};if(!await hosted.ownsProvider(who,entry.settlement.provider))throw error;}}
 async function route(req:Request,url:URL){
  const path=url.pathname.replace(/\/$/,'')||'/';
  if(path==='/policy/authorize'&&req.method==='POST'){
   if(!policy)fail(503,'POLICY_AUTHORITY_UNAVAILABLE','The policy authority is not configured');
   return json(await policy.authorize(await body(req)),201);
  }
  if(path==='/managed-services/config'&&req.method==='GET')return json(hosted?.capabilities()||{available:false,templates:[],notice:'Hosted APIs are not configured'});
  if(path==='/managed-services'&&(req.method==='GET'||req.method==='POST')){const who=await actor(req);if(!hosted)fail(503,'MANAGED_NOT_CONFIGURED','Hosted APIs are not configured');return req.method==='GET'?json(await hosted.list(who)):json(await hosted.create(who,await body(req)),201);}
  const hostedPath=path.match(/^\/hosted\/([a-f0-9-]{36})$/);if(hostedPath){if(!hosted)fail(503,'MANAGED_NOT_CONFIGURED','Hosted APIs are not configured');return hosted.serve(hostedPath[1],req);}
  const x402Path=path.match(/^\/x402\/([a-f0-9-]{36})$/);if(x402Path){if(!hosted)fail(503,'MANAGED_NOT_CONFIGURED','Hosted APIs are not configured');return hosted.serveX402(x402Path[1],req);}
  const managedPath=path.match(/^\/managed-services\/([a-f0-9-]{36})\/(activate|pause|receipts|test|connection)$/);if(managedPath){const who=await actor(req);if(!hosted)fail(503,'MANAGED_NOT_CONFIGURED','Hosted APIs are not configured');if(req.method==='POST'&&managedPath[2]==='test'){rate('gateway-test:'+who,5);return json(await hosted.testConnection(who,managedPath[1],await body(req)));}if(req.method==='POST'&&managedPath[2]==='connection')return json(await hosted.updateConnection(who,managedPath[1],await body(req)));if(req.method==='POST'&&managedPath[2]==='activate')return json(await hosted.activate(who,managedPath[1]));if(req.method==='POST'&&managedPath[2]==='pause')return json(await hosted.pause(who,managedPath[1]));if(req.method==='GET'&&managedPath[2]==='receipts')return json(await hosted.receiptList(who,managedPath[1]));}
  const managedDispute=path.match(/^\/disputes\/(0x[a-fA-F0-9]{64})\/managed-provider$/);if(managedDispute&&(req.method==='GET'||req.method==='POST')){const who=await actor(req);if(!hosted)fail(503,'MANAGED_NOT_CONFIGURED','Hosted APIs are not configured');const id=hex(managedDispute[1],32);return json(req.method==='GET'?await hosted.disputeService(who,id):await hosted.disputeAction(who,id,await body(req)));}
  if(path==='/config'&&req.method==='GET')return json({chainId:config.chainId,factories:config.factories,negotiationVaults:config.negotiationVaults||[],legacyDisputeVaults:config.legacyDisputeVaults||[],contracts:{agentRegistry:config.agentRegistry,providerRegistry:config.providerRegistry,reputationRegistry:config.reputationRegistry,disputeVault:config.disputeVault}});
  if(path==='/health'&&req.method==='GET'){
   const status=await Promise.allSettled([store.health(),chain.health()]);
   const database=status[0].status==='fulfilled'?'ready':'unavailable',rpc=status[1].status==='fulfilled'?'ready':'unavailable';
   return json({service:'sluice-backend',status:database==='ready'&&rpc==='ready'?'ready':'degraded',database,rpc,capabilities:{auth:'SIWE bearer sessions',voucherIntake:'V1/V2/V3 authorization queue; settlement is provider-controlled',x402:'v2 batch-settlement on managed API routes',receipts:'Signed V3 receipt reads; provider persistence migration required',reads:'RPC block-window queries; no indexer'}});
  }
  if(path==='/auth/nonce'&&req.method==='POST'){
   const input=await body(req);const owner=address(input.address);const now=clock();const expires=new Date(now+300000);const nonce=randomBytes(16).toString('hex');
   const message=createSiweMessage({address:owner,chainId:config.chainId,domain:new URL(config.authOrigin).host,scheme:new URL(config.authOrigin).protocol.slice(0,-1),uri:config.authOrigin,version:'1',nonce,issuedAt:new Date(now),expirationTime:expires,statement:'Sign in to Sluice. This does not authorize a payment.'});
   const id=randomUUID();await store.putChallenge({id,address:owner.toLowerCase(),message,expires_at:expires.toISOString()});
   return json({id,nonce,message,expiresAt:expires.toISOString(),walletSupport:config.rpcUrls.length?'EOA and RPC-supported contract wallets':'EOA only until RPC_URL is configured'},201);
  }
  if(path==='/auth/verify'&&req.method==='POST'){
   const input=await body(req);if(typeof input.id!=='string'||! /^[a-f0-9-]{36}$/.test(input.id))fail(400,'INVALID_INPUT','Invalid challenge ID');
   const challenge=await store.getChallenge(input.id);if(!challenge||challenge.consumed_at||Date.parse(challenge.expires_at)<=clock())fail(401,'INVALID_CHALLENGE','Challenge expired or already used');
   const signature=hex(input.signature);if(signature.length>8194)fail(400,'INVALID_SIGNATURE','Signature is too large');
   const signer=address(challenge.address);let valid=false;
   try{valid=config.rpcUrls.length?await chain.verifyLogin(signer,challenge.message,signature):await verifyMessage({address:signer,message:challenge.message,signature});}catch(error){const dependency=apiError(error);if(dependency?.status===503)throw dependency;}
   if(!valid)fail(401,'INVALID_SIGNATURE','Signature does not match the challenge');
   const token=randomBytes(32).toString('hex');if(!await store.consumeChallenge(challenge.id,digest(token)))fail(401,'INVALID_CHALLENGE','Challenge expired or already used');
   return json({token,tokenType:'Bearer',expiresIn:3600,address:signer});
  }
  if(path==='/auth/me'&&req.method==='GET')return json({address:await actor(req)});
  if(path==='/auth/logout'&&req.method==='POST'){await actor(req);await store.logout(digest(req.headers.get('authorization')!.slice(7)));return json({loggedOut:true});}
  async function enrichListing(item:ApiListing){
   try {const status=await chain.provider(address(item.provider)) as {entry:{active:boolean;disputeWindow:number;metadataHash:string}};
    return {...item,token:deployment.v1.contracts.AgentWalletFactory.constructorArgs.usdc,decimals:6,providerStatus:status.entry.active?'active':'inactive',disputeWindow:Number(status.entry.disputeWindow),registryMetadataHash:status.entry.metadataHash,priceSource:'provider-declared; the live API quote is authoritative'};
   }catch{return {...item,token:deployment.v1.contracts.AgentWalletFactory.constructorArgs.usdc,decimals:6,providerStatus:'unavailable',disputeWindow:null,priceSource:'provider-declared; the live API quote is authoritative'};}
  }
  if(path==='/directory'&&req.method==='GET'){
   const {limit:requested,offset}=page(url),limit=Math.min(requested,20),q=(url.searchParams.get('q')||'').trim(),category=url.searchParams.get('category')||'';
   if(q.length>80||/[^\p{L}\p{N} .'-]/u.test(q))fail(400,'INVALID_SEARCH','Search uses letters, numbers, spaces, dots, apostrophes and hyphens, up to 80 characters');
   if(category&&!['Data','AI','Search','Tools','Other'].includes(category))fail(400,'INVALID_CATEGORY','Unknown category');
   const items=await catalog.list(config.chainId,limit,offset,{q,category});return json({items:await Promise.all(items.map(enrichListing)),limit,offset,hasMore:items.length===limit});
  }
  if(path==='/directory/mine'&&req.method==='GET'){const who=await actor(req),{limit:requested,offset}=page(url),limit=Math.min(requested,20);const items=await catalog.list(config.chainId,limit,offset,{provider:who});return json({items:await Promise.all(items.map(enrichListing)),limit,offset,hasMore:items.length===limit});}
  if(path==='/directory'&&req.method==='POST'){
   const who=await actor(req),input=await body(req),slug=shortText(input.slug,'Listing URL name',48);if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug))fail(400,'INVALID_SLUG','Use lowercase letters, numbers and hyphens for the listing URL name');
   if(typeof input.published!=='boolean')fail(400,'INVALID_INPUT','Choose whether to publish this listing');
   if(input.published){const registered=await chain.provider(who) as {entry:{active:boolean}};if(!registered.entry.active)fail(403,'PROVIDER_INACTIVE','Register and activate your provider before publishing');}
   const category=shortText(input.category,'Category',20);if(!['Data','AI','Search','Tools','Other'].includes(category))fail(400,'INVALID_CATEGORY','Unknown category');
   if(input.method!=='GET'&&input.method!=='POST')fail(400,'INVALID_METHOD','Only GET and POST APIs are supported');
   const price=shortText(input.priceUsdc,'Price in USDC',20);if(!/^\d{1,9}(\.\d{1,6})?$/.test(price)||parseUnits(price,6)<=0n)fail(400,'INVALID_PRICE','Price must be positive USDC with at most six decimal places');
   const value:ApiListing={chain_id:config.chainId,provider:who.toLowerCase(),slug,name:shortText(input.name,'API name',80),description:shortText(input.description,'Description',1000),category,endpoint:httpsUrl(input.endpoint,'API endpoint'),method:input.method,docs_url:httpsUrl(input.docsUrl||'','Documentation URL',true),price:parseUnits(price,6).toString(),published:input.published,updated_at:new Date(clock()).toISOString()};await catalog.saveListing(value);return json({listing:await enrichListing(value)},201);
  }
  const listingPath=path.match(/^\/directory\/(0x[a-fA-F0-9]{40})\/([a-z0-9][a-z0-9-]{0,47})$/);if(listingPath&&req.method==='GET'){const value=await catalog.listing(config.chainId,address(listingPath[1]),listingPath[2]);if(!value)fail(404,'LISTING_NOT_FOUND','This API is not published');return json({listing:await enrichListing(value)});}
  const profilePath=path.match(/^\/wallets\/(0x[a-fA-F0-9]{40})\/profile$/);
  if(profilePath&&(req.method==='GET'||req.method==='POST')){
   const who=await actor(req),wallet=address(profilePath[1]),state=await chain.wallet(wallet);if(state.owner.toLowerCase()!==who.toLowerCase())fail(403,'FORBIDDEN','Only the current wallet owner can access its private agent profile');
   if(req.method==='POST'){const input=await body(req);const value={chain_id:config.chainId,wallet:wallet.toLowerCase(),owner:who.toLowerCase(),name:shortText(input.name,'Agent name',80),purpose:shortText(input.purpose||'','Purpose',500,true),updated_at:new Date(clock()).toISOString()};await catalog.saveAgent(value);return json({profile:value});}
   const saved=await catalog.agent(config.chainId,wallet);const records=await store.receipts(wallet.toLowerCase(),undefined,5,0);let lastPayment=null;
   for(const record of records){const receipt=record.receipt;if(receipt.chainId===config.chainId&&receipt.wallet.toLowerCase()===wallet.toLowerCase()&&Number(receipt.receipt.timestamp)<=Math.floor(clock()/1000)+60&&await verifyReceipt(receipt)){lastPayment={timestamp:receipt.receipt.timestamp,provider:receipt.provider,amount:receipt.receipt.amount,token:receipt.receipt.token,settled:!!record.commitment};break;}}
   return json({profile:saved?.owner.toLowerCase()===who.toLowerCase()?saved:null,lastPayment,agentRuntimeStatus:'unknown',notice:'A provider-signed receipt is payment activity, not proof that an AI agent is currently running.'});
  }
  const arbitrationPath=path.match(/^\/wallets\/(0x[a-fA-F0-9]{40})\/arbitration$/);if(arbitrationPath&&req.method==='GET')return json(await chain.arbitrationTerms(address(arbitrationPath[1]),address(url.searchParams.get('provider'),'provider'),address(url.searchParams.get('token'),'token')));
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
  const analysisPath=path.match(/^\/disputes\/(0x[a-fA-F0-9]{64})\/analysis$/);
  if(analysisPath&&(req.method==='GET'||req.method==='POST')){const id=hex(analysisPath[1],32),who=await actor(req);await authorizeEvidence(id,who);if(req.method==='GET')return json(assistantConfig());rate('ai:'+who.toLowerCase(),3);const input=await body(req);if(input.confirmExternalProcessing!==true)fail(400,'CONSENT_REQUIRED','Confirm sending the selected private evidence to the configured model provider');if(!Array.isArray(input.evidenceIds)||input.evidenceIds.length>20||input.evidenceIds.some(id=>typeof id!=='string'))fail(400,'INVALID_EVIDENCE','Select at most 20 evidence IDs');const ids=new Set(input.evidenceIds as string[]);const evidence=(await store.evidence(id.toLowerCase()) as {id:string}[]).filter(record=>ids.has(record.id));if(!evidence.length||evidence.length!==ids.size)fail(400,'INVALID_EVIDENCE','Select existing evidence records');return json(await analyzeDispute({settlement:await chain.settlement(id,true),evidence}));}
  match=path.match(/^\/disputes\/(0x[a-fA-F0-9]{64})\/evidence$/);
  if(match&&(req.method==='POST'||req.method==='GET')){
   const id=hex(match[1],32),who=await actor(req);await authorizeEvidence(id,who);
   if(req.method==='GET')return json({items:await store.evidence(id.toLowerCase()),limit:100});
   const input=await body(req);if(typeof input.content!=='string'||!input.content.trim()||new TextEncoder().encode(input.content).length>16384)fail(400,'INVALID_EVIDENCE','content must be nonempty UTF-8 text of at most 16 KiB');
   const hash=keccak256(toHex(input.content));await store.addEvidence({id:hash,settlement_id:id.toLowerCase(),author:who.toLowerCase(),content:input.content,created_at:new Date(clock()).toISOString()});
   return json({evidenceHash:hash,stored:true,onChain:false,notice:'Submit this hash through the relevant contract transaction yourself.'},201);
  }
  if(path==='/receipts'&&req.method==='GET'){
   const who=await actor(req),{limit,offset}=page(url),selected=url.searchParams.get('wallet');let wallet:string|undefined,provider:string|undefined=who;
   if(url.searchParams.has('provider')){const requested=address(url.searchParams.get('provider'));if(requested.toLowerCase()!==who.toLowerCase()&&(!hosted||!await hosted.ownsProvider(who,requested)))fail(403,'FORBIDDEN','Only the provider or its hosted API owner can access these receipts');provider=requested;}
   if(selected){wallet=address(selected);const state=await chain.wallet(wallet as Address);if(state.owner.toLowerCase()===who.toLowerCase())provider=undefined;}
   const records=await store.receipts(wallet,provider,limit,offset),items=[];
   for(const record of records){if(record.receipt.chainId===config.chainId&&(!wallet||record.receipt.wallet.toLowerCase()===wallet.toLowerCase())&&(!provider||record.receipt.provider.toLowerCase()===provider.toLowerCase())&&await verifyReceipt(record.receipt))items.push({...record,verified:true});}
   return json({items,limit,offset});
  }
  if(/^\/receipts\/[^/]+$/.test(path)&&req.method==='GET'){
   const who=await actor(req),id=hex(path.split('/')[2],32),record=await store.receipt(id);
   if(!record)fail(404,'RECEIPT_NOT_FOUND','No stored signed receipt');
   const wallet=await chain.wallet(record.receipt.wallet);
   if(![wallet.owner.toLowerCase(),record.receipt.provider.toLowerCase()].includes(who.toLowerCase())&&(!hosted||!await hosted.ownsProvider(who,record.receipt.provider)))fail(403,'FORBIDDEN','Only the wallet owner or provider may read this receipt');
   if(record.receipt.chainId!==config.chainId||record.receipt.receipt.voucherHash!==id||!await verifyReceipt(record.receipt))fail(502,'INVALID_STORED_RECEIPT','Stored receipt failed verification');
   return json({...record,receiptHash:receiptHash(record.receipt),verified:true});
  }
  fail(404,'NOT_FOUND','Route not found');
 }
 return async function fetchApi(req:Request,ip='local'){
  let response:Response;const origin=req.headers.get('origin');
  try{
   if(origin&&origin!==config.authOrigin)fail(403,'ORIGIN_DENIED','Origin is not allowed');
   rate('all:'+ip,120);
   const url=new URL(req.url);if(url.pathname.startsWith('/auth/'))rate('auth:'+ip,20);
   if(req.method==='OPTIONS')response=new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, X-AgentPay-Voucher, X-AgentPay-Version, X-Sluice-Policy, PAYMENT-SIGNATURE','Access-Control-Max-Age':'600'}});
   else response=await route(req,url);
  }catch(error){
   const known=apiError(error);
   if(known)response=json({error:{code:known.code,message:known.message}},known.status);
   else response=json({error:{code:'UPSTREAM_FAILURE',message:'The data source could not complete this request'}},502);
  }
  response.headers.set('Vary','Origin');response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Access-Control-Expose-Headers','X-AgentPay-Quote, X-AgentPay-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  if(origin===config.authOrigin)response.headers.set('Access-Control-Allow-Origin',origin);
  if(response.status===429)response.headers.set('Retry-After','60');
  return response;
 };
}
