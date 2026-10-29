import {fail} from './errors';
import type {Config} from './config';
import type {SignedReceipt} from '@sluice/sdk';
export type ReceiptRecord={receipt:SignedReceipt;commitment?:{root:string;proof:string[];settlementId:string;settlementNonce:string;transactionHash:string}};
export type Challenge={id:string;address:string;message:string;expires_at:string;consumed_at?:string|null};
export type VoucherRecord={id:string;channel:string;chain_id:number;wallet:string;provider:string;token:string;nonce:string;cumulative_amount:string;payload:unknown;signature:string;received_at:string};
export type EvidenceRecord={id:string;settlement_id:string;author:string;content:string;created_at:string};
export interface Store {
 health():Promise<boolean>;
 putChallenge(challenge:Challenge):Promise<void>;
 getChallenge(id:string):Promise<Challenge|null>;
 consumeChallenge(id:string,tokenHash:string):Promise<boolean>;
 session(tokenHash:string):Promise<string|null>;
 logout(tokenHash:string):Promise<void>;
 putVoucher(record:VoucherRecord):Promise<'created'|'duplicate'|'stale'>;
 vouchers(provider:string,limit:number,offset:number):Promise<unknown[]>;
 addEvidence(record:EvidenceRecord):Promise<void>;
 evidence(id:string):Promise<unknown[]>;
 receipt(id:string):Promise<ReceiptRecord|null>;
 receipts(wallet:string|undefined,provider:string|undefined,limit:number,offset:number):Promise<ReceiptRecord[]>;
}
export class SupabaseStore implements Store{
 constructor(private config:Pick<Config,'supabaseUrl'|'supabaseKey'>,private transport:typeof fetch=fetch){}
 private async request(path:string,method='GET',data?:unknown):Promise<unknown>{
  if(!this.config.supabaseUrl||!this.config.supabaseKey)fail(503,'DATABASE_NOT_CONFIGURED','Configure Supabase and apply the backend migration');
  let response:Response;
  try{response=await this.transport(this.config.supabaseUrl+'/rest/v1/'+path,{method,headers:{apikey:this.config.supabaseKey,Authorization:'Bearer '+this.config.supabaseKey,'Content-Type':'application/json',...(path.startsWith('rpc/')?{}:{Prefer:path.startsWith('api_evidence')?'return=minimal,resolution=ignore-duplicates':'return=minimal'})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(8000)});}catch{fail(503,'DATABASE_UNAVAILABLE','Supabase is unavailable');}
  if(!response.ok)fail(503,'DATABASE_UNAVAILABLE','Supabase request failed; check server configuration and migration');
  if(response.status===204)return null;const text=await response.text();return text?JSON.parse(text):null;
 }
 async health(){await this.request('api_challenges?select=id&limit=0');await this.request('api_provider_records?select=id&limit=0');return true;}
 async putChallenge(c:Challenge){await this.request('api_challenges','POST',c);}
 async getChallenge(id:string){const rows=await this.request('api_challenges?id=eq.'+encodeURIComponent(id)+'&select=*&limit=1') as Challenge[];return rows[0]||null;}
 async consumeChallenge(id:string,tokenHash:string){return await this.request('rpc/api_issue_session','POST',{p_challenge:id,p_token_hash:tokenHash}) as boolean;}
 async session(hash:string){return await this.request('rpc/api_session_address','POST',{p_token_hash:hash}) as string|null;}
 async logout(hash:string){await this.request('api_sessions?token_hash=eq.'+encodeURIComponent(hash),'DELETE');}
 async putVoucher(record:VoucherRecord){return await this.request('rpc/api_accept_voucher','POST',{p_record:record}) as 'created'|'duplicate'|'stale';}
 async vouchers(provider:string,limit:number,offset:number){return await this.request('api_vouchers?provider=eq.'+provider+'&order=received_at.desc,id.desc&limit='+limit+'&offset='+offset) as unknown[];}
 async addEvidence(record:EvidenceRecord){await this.request('api_evidence','POST',record);}
 async evidence(id:string){return await this.request('api_evidence?settlement_id=eq.'+id+'&order=created_at.asc&limit=100') as unknown[];}
 async receipt(id:string){const rows=await this.request('api_provider_records?id=eq.'+encodeURIComponent(id)+'&completed=eq.true&select=payload&limit=1') as {payload:ReceiptRecord}[];const record=rows[0]?.payload;return record?.receipt?{receipt:record.receipt,commitment:record.commitment}:null;}
 async receipts(wallet:string|undefined,provider:string|undefined,limit:number,offset:number){const rows=await this.request('api_provider_records?completed=eq.true&payload->receipt->>signature=not.is.null&select=payload&order=created_at.desc&limit='+limit+'&offset='+offset+(wallet?'&payload->voucher->>wallet=ilike.'+encodeURIComponent(wallet):'')+(provider?'&payload->voucher->>provider=ilike.'+encodeURIComponent(provider):'')) as {payload:ReceiptRecord}[];return rows.map(r=>r.payload).filter(r=>!!r.receipt).map(r=>({receipt:r.receipt,commitment:r.commitment}));}
}
