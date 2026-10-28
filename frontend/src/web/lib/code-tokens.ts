export type CodeToken = { text: string; kind?: 'comment' | 'string' | 'keyword' | 'type' | 'number' | 'function' | 'operator' };
const supported = /^(solidity|typescript|javascript|ts|js|json|bash|shell|sh)$/i;
const keywords = new Set('struct contract interface library function event error modifier mapping public private external internal view pure payable returns return if else for while new emit revert require import from export const let var async await throw try catch true false null undefined as type enum constructor immutable override virtual memory storage calldata indexed pragma solidity address'.split(' '));
const types = /^(?:u?int(?:[0-9]+)?|bytes(?:[0-9]+)?|bool|string|number|boolean|void|Promise|Record|Array|Voucher|Address)$/;
// Match complete strings/comments before identifiers so their content stays intact.
const pattern = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|=>|[{}()[\];,.=:<>+*/!?&|%-]/g;
export function tokenizeCode(code: string, language: string): CodeToken[] {
 if (!supported.test(language)) return [{text:code}];
 const result: CodeToken[] = [];
 let offset = 0;
 for (const match of code.matchAll(pattern)) {
  const index = match.index;
  if (index > offset) result.push({text:code.slice(offset,index)});
  const text = match[0];
  let kind: CodeToken['kind'];
  if (text.startsWith('//') || text.startsWith('/*')) kind='comment';
  else if (/^["'\x60]/.test(text)) kind='string';
  else if (types.test(text)) kind='type';
  else if (keywords.has(text)) kind='keyword';
  else if (/^\d/.test(text)) kind='number';
  else if (/^[A-Za-z_$]/.test(text) && /^\s*\(/.test(code.slice(index+text.length))) kind='function';
  else if (/^[{}()[\];,.=:<>+*/!?&|%-]/.test(text)) kind='operator';
  result.push({text,kind}); offset=index+text.length;
 }
 if (offset<code.length) result.push({text:code.slice(offset)});
 return result;
}
