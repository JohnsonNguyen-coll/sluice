import {getAddress,isAddress,type Address,type Hex} from 'viem';
import {fail} from './errors';
export function address(value:unknown,name='address'):Address{if(typeof value!=='string'||!isAddress(value))fail(400,'INVALID_INPUT',name+' must be an Ethereum address');return getAddress(value);}
export function hex(value:unknown,bytes?:number):Hex{if(typeof value!=='string'||!/^0x(?:[a-fA-F0-9]{2})+$/.test(value)||(bytes!==undefined&&value.length!==2+bytes*2))fail(400,'INVALID_INPUT','Invalid hex value');return value as Hex;}
export function uint(value:unknown,bits=256):bigint{if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,77})$/.test(value))fail(400,'INVALID_INPUT','Unsigned integers must be decimal strings');const n=BigInt(value);if(n>=2n**BigInt(bits))fail(400,'INVALID_INPUT','Integer out of range');return n;}
export function page(url:URL){const limit=Number(url.searchParams.get('limit')||25),offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>100000)fail(400,'INVALID_INPUT','Invalid pagination');return {limit,offset};}
export async function body(req:Request):Promise<Record<string,unknown>>{
 if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))fail(415,'JSON_REQUIRED','Use application/json');
 const reader=req.body?.getReader();if(!reader)fail(400,'INVALID_JSON','Request body required');
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();fail(413,'BODY_TOO_LARGE','Body exceeds 32 KiB');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let parsed:unknown;try{parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'INVALID_JSON','Malformed JSON');}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail(400,'INVALID_JSON','Expected a JSON object');return parsed as Record<string,unknown>;
}
