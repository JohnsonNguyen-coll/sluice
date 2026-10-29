import {beforeAll,afterAll,test,expect} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
let db:PGlite;
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');await db.exec(await Bun.file(new URL('../supabase/migrations/202610290002_provider_receipts.sql',import.meta.url)).text());await db.exec('set role service_role');},30000);
afterAll(async()=>{await db.close();});
const hash=(digit:string)=>'0x'+digit.repeat(64);
function record(id:string,nonce:string,cumulativeAmount:string){return {id,channel:'31337:wallet:provider:token',voucher:{nonce,cumulativeAmount},receipt:null};}
async function accept(value:unknown){return (await db.query<{value:string}>("select api_provider_accept($1::jsonb,'0','0','10') as value",[JSON.stringify(value)])).rows[0].value;}
test('provider acceptance is atomic, exact-price, monotonic and idempotent',async()=>{
 const first=record(hash('a'),'1','10');expect(await accept(first)).toBe('created');
 expect(await accept(first)).toBe('duplicate');
 expect(await accept(record(hash('b'),'2','30'))).toBe('stale');
 const concurrent=await Promise.all([accept(record(hash('b'),'2','20')),accept(record(hash('c'),'2','20'))]);expect(concurrent.sort()).toEqual(['created','stale']);
});
test('completion persists a response once and confirmed commitments remain available',async()=>{
 await db.query('select api_provider_complete($1,$2::jsonb,$3::jsonb)',[hash('a'),JSON.stringify({signature:'signed'}),JSON.stringify({status:200,body:'e30=',headers:[]})]);
 await expect(db.query('select api_provider_complete($1,null,$2::jsonb)',[hash('a'),'{}'])).rejects.toThrow('already completed');
 const commitment={root:hash('d'),proof:[],settlementId:hash('e'),settlementNonce:'1',transactionHash:hash('f')};
 await db.query('select api_provider_settled($1,$2,$3::jsonb)',[[hash('a')],hash('f'),JSON.stringify({[hash('a')]:commitment})]);
 const row=(await db.query<{payload:{commitment:unknown};settled_tx:string}>('select payload,settled_tx from api_provider_records where id=$1',[hash('a')])).rows[0];expect(row.payload.commitment).toEqual(commitment);expect(row.settled_tx).toBe(hash('f'));
});
test('provider tables and mutation functions reject browser roles',async()=>{
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await expect(db.query('select * from api_provider_records')).rejects.toThrow('permission denied');await expect(db.query("select api_provider_accept('{}','0','0','1')")).rejects.toThrow('permission denied');}await db.exec('set role service_role');
});
