export class ApiError extends Error {
 constructor(public status:number,public code:string,message:string){super(message);}
}
export function fail(status:number,code:string,message:string):never{throw new ApiError(status,code,message);}
// viem wraps transport errors; preserve our safe, public dependency status.
export function apiError(error:unknown):ApiError|undefined{
 for(let depth=0;error&&typeof error==='object'&&depth<20;depth++){
  if(error instanceof ApiError)return error;
  error=(error as {cause?:unknown}).cause;
 }
 return undefined;
}
