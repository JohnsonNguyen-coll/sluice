import {beforeAll,afterAll,test,expect} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {privateKeyToAccount} from 'viem/accounts';
import {createApi} from '../src/api';
import {loadConfig} from '../src/config';
import {RpcGateway,type ValidVoucher} from '../src/chain';
import type {Store,Challenge,VoucherRecord,EvidenceRecord} from '../src/store';
import {SupabaseStore} from '../src/store';
import {fail} from '../src/errors';
import {receiptData,type SignedReceipt} from '@sluice/sdk';
import {keccak256,toHex,verifyMessage,type Address,type Hex} from 'viem';
const account=privateKeyToAccount('0x'+'11'.repeat(32) as Hex);
const stranger=privateKeyToAccount('0x'+'22'.repeat(32) as Hex);
const settlement='0x'+'ab'.repeat(32);
let db:PGlite;
class TestStore implements Store{
 async health(){return true;}
 async putChallenge(c:Challenge){await db.query('insert into api_challenges(id,address,message,expires_at) values($1,$2,$3,$4)',[c.id,c.address,c.message,c.expires_at]);}
 async getChallenge(id:string){return (await db.query<Challenge>('select * from api_challenges where id=$1',[id])).rows[0]||null;}
 async consumeChallenge(id:string,hash:string){return (await db.query<{v:boolean}>('select api_issue_session($1,$2) as v',[id,hash])).rows[0].v;}
 async session(hash:string){return (await db.query<{v:string|null}>('select api_session_address($1) as v',[hash])).rows[0].v;}
 async logout(hash:string){await db.query('delete from api_sessions where token_hash=$1',[hash]);}
 async putVoucher(record:VoucherRecord){return (await db.query<{v:'created'|'duplicate'|'stale'}>('select api_accept_voucher($1::jsonb) as v',[JSON.stringify(record)])).rows[0].v;}
 async vouchers(provider:string,limit:number,offset:number){return (await db.query('select * from api_vouchers where provider=$1 order by received_at desc,id desc limit $2 offset $3',[provider,limit,offset])).rows;}
 async addEvidence(r:EvidenceRecord){await db.query('insert into api_evidence(id,settlement_id,author,content) values($1,$2,$3,$4) on conflict do nothing',[r.id,r.settlement_id,r.author,r.content]);}
 async evidence(id:string){return (await db.query('select * from api_evidence where settlement_id=$1',[id])).rows;}
 async receipt(_id:string){return null;}
 async receipts(){return [];}
}
const config=loadConfig({AUTH_ORIGIN:'http://127.0.0.1:3010'});
class TestChain extends RpcGateway{
 async verifyLogin(address:Address,message:string,signature:Hex){return verifyMessage({address,message,signature});}
 async health(){return {chainId:config.chainId,blockNumber:100n};}
 async authorizeEvidence(_id:Hex,who:Address){if(who.toLowerCase()!==account.address.toLowerCase())fail(403,'FORBIDDEN','Not a dispute party');}
 async validateVoucher(input:Record<string,unknown>,who:Address):Promise<ValidVoucher>{
  if(who.toLowerCase()!==account.address.toLowerCase())fail(403,'FORBIDDEN','Wrong provider');
  const token='0x'+'33'.repeat(20),wallet='0x'+'44'.repeat(20);
  return {id:input.id as Hex,channel:[config.chainId,wallet,who,token].join(':').toLowerCase(),chain_id:config.chainId,wallet,provider:who.toLowerCase(),token,nonce:input.nonce as string,cumulative_amount:input.amount as string,payload:input,signature:('0x'+'aa'.repeat(65)) as Hex};
 }
}
const store=new TestStore();
let api:ReturnType<typeof createApi>;
function request(path:string,method='GET',payload?:unknown,token?:string,origin?:string,ip='tests'){
 return api(new Request('http://localhost:3001'+path,{method,headers:{...(payload===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})},body:payload===undefined?undefined:JSON.stringify(payload)}),ip);
}
async function login(who=account){const ip=crypto.randomUUID();const challenge=await (await request('/auth/nonce','POST',{address:who.address},undefined,undefined,ip)).json();const signature=await who.signMessage({message:challenge.message});const response=await request('/auth/verify','POST',{id:challenge.id,signature},undefined,undefined,ip);expect(response.status).toBe(200);return {token:(await response.json()).token as string,id:challenge.id,signature};}
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');await db.exec(await Bun.file(new URL('../supabase/migrations/202610290001_backend.sql',import.meta.url)).text());await db.exec('set role service_role');api=createApi(config,store,new TestChain(config));},30000);
afterAll(async()=>{await db.close();});

test('AI analysis requires a dispute party, explicit external-processing consent and existing evidence',async()=>{
 expect((await request('/disputes/'+settlement+'/analysis')).status).toBe(401);
 const outsider=await login(stranger);
 expect((await request('/disputes/'+settlement+'/analysis','GET',undefined,outsider.token)).status).toBe(403);
 const {token}=await login();
 expect((await request('/disputes/'+settlement+'/analysis','GET',undefined,token)).status).toBe(200);
 expect((await request('/disputes/'+settlement+'/analysis','POST',{evidenceIds:[]},token)).status).toBe(400);
 expect((await request('/disputes/'+settlement+'/analysis','POST',{confirmExternalProcessing:true,evidenceIds:['unknown']},token)).status).toBe(400);
});
test('SIWE login is address bound; challenge is consumed exactly once',async()=>{
 const challenge=await (await request('/auth/nonce','POST',{address:account.address})).json();
 expect(challenge.message).toContain('127.0.0.1:3010 wants you to sign in');
 expect(challenge.message).toContain('Chain ID: 5042002');
 const wrong=await stranger.signMessage({message:challenge.message});
 expect((await request('/auth/verify','POST',{id:challenge.id,signature:wrong})).status).toBe(401);
 const signature=await account.signMessage({message:challenge.message});
 const results=await Promise.all([request('/auth/verify','POST',{id:challenge.id,signature}),request('/auth/verify','POST',{id:challenge.id,signature})]);
 expect(results.map(r=>r.status).sort()).toEqual([200,401]);
});
test('expired challenge cannot issue a session',async()=>{
 const id=crypto.randomUUID();await store.putChallenge({id,address:account.address.toLowerCase(),message:'expired',expires_at:new Date(0).toISOString()});
 expect(await store.consumeChallenge(id,'d'.repeat(64))).toBe(false);
});
test('healthcheck fails deployment readiness when storage or RPC is down',async()=>{
 const failedStore=Object.create(store) as Store;
 failedStore.health=async()=>{throw Error('database offline');};
 const response=await createApi(config,failedStore,new TestChain(config))(new Request('http://localhost:3001/health'),'tests');
 expect(response.status).toBe(503);
 expect((await response.json()).status).toBe('degraded');
});
test('a signed receipt reveals only its own settlement status',async()=>{
 const id=('0x'+'18'.repeat(32)) as Hex;
 const signed:SignedReceipt={wallet:('0x'+'44'.repeat(20)) as Address,provider:account.address,chainId:config.chainId,receipt:{voucherHash:id,requestHash:('0x'+'19'.repeat(32)) as Hex,responseHash:('0x'+'20'.repeat(32)) as Hex,status:200,timestamp:'1',token:('0x'+'33'.repeat(20)) as Address,nonce:'1',amount:'10000'},signature:'0x' as Hex};
 signed.signature=await account.signTypedData(receiptData(signed));
 let settled=false;
 const testStore=Object.create(store) as Store;
 testStore.receipt=async requested=>requested===id?{receipt:signed,...(settled?{commitment:{root:id,proof:[],settlementId:id,settlementNonce:'1',transactionHash:id}}:{})}:null;
 const endpoint=createApi(config,testStore,new TestChain(config));
 const ask=(receipt:SignedReceipt)=>endpoint(new Request('http://localhost:3001/receipt-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receipt})}),'receipt-test');
 expect((await endpoint(new Request('http://localhost:3001/receipt-status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"receipt":{}}'}),'receipt-test')).status).toBe(400);
 expect((await ask({...signed,signature:('0x'+'11'.repeat(65)) as Hex})).status).toBe(404);
 expect((await (await ask(signed)).json()).status).toBe('awaiting-settlement');
 settled=true;
 expect((await (await ask(signed)).json()).status).toBe('settled');
});
test('bearer sessions are hashed, expire, and can be revoked',async()=>{
 const {token}=await login();expect((await request('/auth/me','GET',undefined,token)).status).toBe(200);
 const rows=(await db.query<{token_hash:string}>('select token_hash from api_sessions')).rows;expect(rows.some(r=>r.token_hash===token)).toBe(false);
 await request('/auth/logout','POST',{},token);expect((await request('/auth/me','GET',undefined,token)).status).toBe(401);
 await db.query("insert into api_sessions values($1,$2,now()-interval '1 second',now())",['f'.repeat(64),account.address.toLowerCase()]);expect(await store.session('f'.repeat(64))).toBeNull();
});
test('voucher RPC atomically enforces monotonic channels and idempotence',async()=>{
 const {token}=await login();const id='0x'+'01'.repeat(32);
 expect((await request('/vouchers','POST',{id,nonce:'1',amount:'10'},token)).status).toBe(201);
 expect((await request('/vouchers','POST',{id,nonce:'1',amount:'10'},token)).status).toBe(200);
 expect((await request('/vouchers','POST',{id:'0x'+'02'.repeat(32),nonce:'1',amount:'20'},token)).status).toBe(409);
 expect((await request('/vouchers','POST',{id:'0x'+'03'.repeat(32),nonce:'2',amount:'9'},token)).status).toBe(409);
 const res=await request('/vouchers','GET',undefined,token);expect((await res.json()).items).toHaveLength(1);
 expect((await request('/vouchers')).status).toBe(401);
});
test('evidence is private, content hashed, and never submitted on chain',async()=>{
 const {token}=await login();const foreign=await login(stranger);
 expect((await request('/disputes/'+settlement+'/evidence','GET',undefined,foreign.token)).status).toBe(403);
 const content='Evidence text';const response=await request('/disputes/'+settlement+'/evidence','POST',{content},token);expect(response.status).toBe(201);
 const data=await response.json();expect(data.evidenceHash).toBe(keccak256(toHex(content)));expect(data.onChain).toBe(false);
 expect((await request('/disputes/'+settlement+'/evidence','GET',undefined,token)).status).toBe(200);
});
test('anon/authenticated cannot read backend tables or invoke privileged RPCs',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  await expect(db.query('select * from api_sessions')).rejects.toThrow('permission denied');
  await expect(db.query("select api_session_address('x')")).rejects.toThrow('permission denied');
 }
 await db.exec('set role service_role');
 const rows=(await db.query<{relrowsecurity:boolean}>("select relrowsecurity from pg_class where relname in ('api_challenges','api_sessions','api_vouchers','api_voucher_channels','api_evidence')")).rows;expect(rows).toHaveLength(5);expect(rows.every(r=>r.relrowsecurity)).toBe(true);
});
test('bad input, CORS, payload limits, auth throttling and pending receipts',async()=>{
 expect((await request('/wallets/not-an-address')).status).toBe(400);
 expect((await request('/health','GET',undefined,undefined,'https://evil.example')).status).toBe(403);
 expect((await request('/auth/nonce','POST',{address:account.address},undefined,config.authOrigin,'cors')).headers.get('access-control-allow-origin')).toBe(config.authOrigin);
 expect((await request('/auth/nonce','POST',{address:account.address,padding:'x'.repeat(33000)},undefined,undefined,'large')).status).toBe(413);
 expect((await request('/receipts/anything')).status).toBe(401);
 for(let i=0;i<20;i++)await request('/auth/me','GET',undefined,undefined,undefined,'throttle');
 expect((await request('/auth/me','GET',undefined,undefined,undefined,'throttle')).status).toBe(429);
 expect((await request('/unknown')).status).toBe(404);
});
test('unconfigured Supabase fails closed; service key only sent to configured REST URL',async()=>{
 const empty=new SupabaseStore({});await expect(empty.health()).rejects.toThrow('Configure Supabase');
 let seenUrl='',seenHeaders=new Headers();
 const transport=(async(url:RequestInfo|URL,init?:RequestInit)=>{seenUrl=String(url);seenHeaders=new Headers(init?.headers);return new Response('[]');}) as typeof fetch;
 await new SupabaseStore({supabaseUrl:'https://project.supabase.co',supabaseKey:'server-secret'},transport).health();
 expect(seenUrl).toBe('https://project.supabase.co/rest/v1/api_provider_records?select=id&limit=0');expect(seenHeaders.get('authorization')).toBe('Bearer server-secret');
});
