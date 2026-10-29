'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { Brand } from './ui';
import { AppNavigation, Breadcrumbs } from './navigation';
import { CommandPalette } from './command-palette';
import { ThemeToggle } from './theme';
import { WalletControl } from './wallet-control';
import { routeHref } from '../lib/routes';
import {ApiSessionProvider} from './api-session';
export function AppShell({ children }: { children: ReactNode }) {
 const [menuOpen,setMenuOpen]=useState(false);
 const MenuIcon=menuOpen?X:Menu;
 return <ApiSessionProvider><div className="workspace workspace-topnav">
  <header className="workspace-header"><div className="workspace-singlebar">
   <Brand/>
   <div className="workspace-header-nav" id="workspace-navigation" data-open={menuOpen}><AppNavigation onNavigate={()=>setMenuOpen(false)}/><div className="workspace-mobile-tools"><ThemeToggle/></div></div>
   <div className="workspace-header-actions"><CommandPalette/><ThemeToggle/><WalletControl/><button type="button" className="workspace-menu-button" aria-label={menuOpen?'Close navigation':'Open navigation'} aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={()=>setMenuOpen(!menuOpen)}><MenuIcon size={20} aria-hidden="true"/></button></div>
  </div></header>
  <div className="workspace-body"><div className="workspace-context"><Breadcrumbs/><span>Development environment</span></div><main id="main-content" className="app-main">{children}</main><footer className="app-footer"><span>AgentPay · Development environment</span><Link href={routeHref('status')}>Network & deployments <ArrowUpRight size={12} aria-hidden="true"/></Link></footer></div>
 </div></ApiSessionProvider>;
}
