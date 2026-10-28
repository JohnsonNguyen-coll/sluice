import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=process.env.WEBSITE_TEST_URL || 'http://localhost:3000';
const manifest=JSON.parse(fs.readFileSync(new URL('../../src/web/lib/route-manifest.json',import.meta.url),'utf8'));
const fixtureAddress='0x0000000000000000000000000000000000000001';
const fixtureId='example-record';
const failures=[];const links=new Set();
const decode=value=>value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
function matchesRoute(path){return manifest.some(route=>new RegExp('^'+route.path.replace(/\[\w+\]/g,'[^/]+')+'/?$').test(path));}
for(let start=0;start<manifest.length;start+=4){
 await Promise.all(manifest.slice(start,start+4).map(async route=>{
 const path=route.path.replace('[address]',fixtureAddress).replace('[teamId]',fixtureId).replace('[id]',fixtureId);
 try{
 const response=await fetch(new URL(path,base));assert.equal(response.status,200,path+' returned '+response.status);
 const html=await response.text();const title=decode(html.match(/<title>([\s\S]*?)<\/title>/)?.[1]||'');
 assert.ok(title.includes(route.title),path+' has wrong or missing title: '+title);
 const headings=[...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map(match=>decode(match[1].replace(/<[^>]*>/g,'')));
 assert.ok(headings.some(heading=>heading.includes(route.id==='home'?'The payment layer':route.title)),path+' has no route heading');
 assert.ok(html.includes('name="description"'),path+' has no description');
 assert.ok(html.includes('id="main-content"'),path+' has no main landmark');
 if(route.area==='app'&&process.env.WEBSITE_EXPECT_MISSING_CONFIG==='1')assert.ok(html.includes('Missing config: NEXT_PUBLIC_FACTORY_ADDRESS'),path+' missing no-env config state');
 for(const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)){const href=decode(match[1]);if(href.startsWith('/')&&!href.startsWith('//')&&!href.startsWith('/_next/'))links.add(href.split(/[?#]/)[0]);}
 console.log('PASS '+path);
 }catch(error){failures.push(error.message);console.error('FAIL '+path+': '+error.message);}
 }));
}
for(const path of links){if(!matchesRoute(path))failures.push('Broken internal link target: '+path);}
const missing=await fetch(new URL('/not-a-sluice-page',base));assert.equal(missing.status,404);
// Next.js can stream a notFound() result with HTTP 200; it must include the designed fallback and noindex.
// https://nextjs.org/docs/app/api-reference/file-conventions/not-found
const invalid=await fetch(new URL('/app/wallets/not-an-address',base));const invalidHtml=await invalid.text();assert.ok([200,404].includes(invalid.status));assert.ok(invalidHtml.includes('This route ends here.')&&invalidHtml.includes('noindex'));
const clientAssets=new Set();for(const path of ['/', '/docs']){const html=await (await fetch(new URL(path,base))).text();for(const match of html.matchAll(/<script[^>]+src="([^"]+)"/g))clientAssets.add(decode(match[1]));}for(const asset of clientAssets){const source=await(await fetch(new URL(asset,base))).text();assert.ok(!/wagmi|WagmiProviderNotFoundError|ConnectKitProvider/.test(source),'Web3 code leaked into a public bundle: '+asset);}
console.log('Public bundle isolation checked across '+clientAssets.size+' JavaScript assets.');
const favicon=await fetch(new URL('/brand/favicon.svg',base));assert.equal(favicon.status,200,'Brand favicon must be served from frontend/public');
const prerender=JSON.parse(fs.readFileSync('.next/prerender-manifest.json','utf8'));
for(const route of manifest.filter(route=>route.area!=='app')){if(!prerender.routes[route.path])failures.push(route.path+' was not statically prerendered');}
console.log(manifest.length+' routes checked; '+manifest.filter(route=>route.area!=='app').length+' static public pages; '+links.size+' internal link targets.');
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}else console.log('All route, metadata, missing-config, internal-link and not-found checks passed.');
