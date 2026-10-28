import { tokenizeCode, type CodeToken } from '../lib/code-tokens';
export function SyntaxCode({code,language,highlightLines}:{code:string;language:string;highlightLines:number[]}) {
 const lines: CodeToken[][]=[[]];
 for(const token of tokenizeCode(code,language)){
  token.text.split('\n').forEach((text,index)=>{
   if(index)lines.push([]);
   if(text)lines[lines.length-1].push({text,kind:token.kind});
  });
 }
 return <code>{lines.map((line,index)=><span className={'code-line'+(highlightLines.includes(index+1)?' highlight-line':'')} key={index}>{line.map((token,tokenIndex)=>token.kind?<span className={'syntax-'+token.kind} key={tokenIndex}>{token.text}</span>:token.text)}{index<lines.length-1?'\n':''}</span>)}</code>;
}
