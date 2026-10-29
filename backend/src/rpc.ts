import {createTransport, http, type Transport, type EIP1193RequestFn} from 'viem';
import {ApiError} from './errors';

// Preserve deterministic contract/input errors instead of trying every provider.
function permanent(error:unknown):boolean {
 if(!error||typeof error!=='object')return false;
 const value=error as {code?:number;message?:string;cause?:unknown};
 if([3,-32600,-32602,4001].includes(value.code!))return true;
 if(/execution reverted|execution revert|insufficient funds/i.test(value.message||''))return true;
 return permanent(value.cause);
}

export function publicRpcTransport(urls:readonly string[],chainId:number,options:{timeoutMs?:number;cooldownMs?:number;now?:()=>number}={}):Transport {
 const now=options.now||Date.now;
 return (parameters)=>{
  const endpoints=urls.map(url=>({
   transport:http(url,{timeout:options.timeoutMs??4000,retryCount:0})(parameters),
   retryAfter:0,verifiedUntil:0,
  }));
  return createTransport({
   key:'public-rpc-failover',name:'Public RPC failover',type:'custom',retryCount:0,
   request:(async (args)=>{
    if(!endpoints.length)throw new ApiError(503,'RPC_NOT_CONFIGURED','Configure RPC_URLS for this chain');
    let lastError:unknown;
    // Each endpoint is attempted at most once; cooling endpoints are skipped.
    for(const endpoint of endpoints){
     if(endpoint.retryAfter>now())continue;
     try {
      let actualChain:unknown;
      if(args.method==='eth_chainId'||endpoint.verifiedUntil<=now()){
       actualChain=await endpoint.transport.request({method:'eth_chainId'});
       if(BigInt(actualChain as string)!==BigInt(chainId))throw new ApiError(503,'CHAIN_MISMATCH','RPC chain does not match CHAIN_ID');
       endpoint.verifiedUntil=now()+30_000;
      }
      return args.method==='eth_chainId'?actualChain:await endpoint.transport.request(args);
     }catch(error){
      if(permanent(error))throw error;
      endpoint.retryAfter=now()+(options.cooldownMs??30_000);
      endpoint.verifiedUntil=0;
      lastError=error;
     }
    }
    if(lastError instanceof ApiError)throw lastError;
    throw new ApiError(503,'RPC_UNAVAILABLE','All configured RPC endpoints are unavailable or cooling down; retry later');
   }) as EIP1193RequestFn,
  });
 };
}
