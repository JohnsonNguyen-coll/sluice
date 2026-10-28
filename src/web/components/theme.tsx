'use client';
import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
function subscribe(listener:()=>void){window.addEventListener('storage',listener);window.addEventListener('sluice-theme',listener);return()=>{window.removeEventListener('storage',listener);window.removeEventListener('sluice-theme',listener);};}
function readTheme(){try{return localStorage.getItem('sluice-theme')||'system';}catch{return 'system';}}
export function ThemeToggle(){
 const theme=useSyncExternalStore(subscribe,readTheme,()=> 'system');
 const Icon=theme==='dark'?Moon:theme==='light'?Sun:Monitor;
 return <label className="theme-toggle"><Icon size={16} aria-hidden="true"/><span className="sr-only">Color theme</span><select aria-label="Color theme" value={theme} onChange={event=>{const value=event.target.value;document.documentElement.dataset.theme=value;try{localStorage.setItem('sluice-theme',value);}catch{/* The selected theme still applies to this page. */}window.dispatchEvent(new Event('sluice-theme'));}}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>;
}
