'use client';
import dynamic from 'next/dynamic';
import { useSyncExternalStore } from 'react';
const DarkVeil = dynamic(() => import('./dark-veil'), { ssr: false });
function subscribe(listener: () => void) {
 const observer=new MutationObserver(listener); observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
 const query=window.matchMedia('(prefers-color-scheme: light)');query.addEventListener('change',listener);
 return()=>{observer.disconnect();query.removeEventListener('change',listener);};
}
function getLight(){const theme=document.documentElement.dataset.theme;return theme==='light'||((!theme||theme==='system')&&window.matchMedia('(prefers-color-scheme: light)').matches);}
export function VeilBackground(){
 const light=useSyncExternalStore(subscribe,getLight,()=>false);
 return <><div className="veil-backdrop" aria-hidden="true"><DarkVeil speed={2} color={light?'#5268c7':'#8798ee'} scale={0.95} flow={0.75} warp={0.12} brightness={1.35} sheen={0.65} glow={0.7} grain={0.025} quality={0.6} dpr={1} opacity={0.9} intro={false} mouseInteraction={false} lightMode={light}/><div className="veil-shading"/></div></>;
}
