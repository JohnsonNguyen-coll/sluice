'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Brand, Badge } from './ui';
import { AppNavigation, Breadcrumbs, MobileNavigation } from './navigation';
import { CommandPalette } from './command-palette';
import { ThemeToggle } from './theme';
import { WalletControl } from './wallet-control';
import { siteConfig } from '../lib/site-config';
import { routeHref } from '../lib/routes';
export function AppShell({ children }: { children: ReactNode }) {
 return <div className="workspace"><aside className="app-sidebar"><Brand /><div className="workspace-label"><span className="workspace-avatar">S</span><div>Sluice workspace<small>Testnet environment</small></div><Badge>Dev</Badge></div><p className="nav-group-label">WORKSPACE</p><AppNavigation /><div className="sidebar-bottom"><Link href={routeHref('docs')}>Developer documentation<ArrowUpRight size={15} aria-hidden="true" /></Link><div className="sidebar-network"><span className="status-dot" /><span>{siteConfig.chain.name}</span><Badge>Testnet</Badge></div></div></aside><div className="workspace-body"><header className="app-topbar"><Breadcrumbs /><div className="app-topbar-actions"><CommandPalette /><ThemeToggle /><Badge tone="accent">Testnet</Badge><WalletControl /></div></header><MobileNavigation /><main id="main-content" className="app-main">{children}</main><footer className="app-footer"><span>AgentPay · Development environment</span><Link href={routeHref('status')}>Network & deployments <ArrowUpRight size={12} aria-hidden="true" /></Link></footer></div></div>;
}
