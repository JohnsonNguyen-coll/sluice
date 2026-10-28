import Link from 'next/link';
import type { ReactNode } from 'react';
import { Brand, ButtonLink } from './ui';
import { PublicNavigation } from './navigation';
import { ThemeToggle } from './theme';
import { CommandPalette } from './command-palette';
import { routeHref } from '../lib/routes';
const copyrightYear = new Date().getUTCFullYear();
export function PublicHeader() { return <header className="site-header"><div className="header-inner"><Brand /><div className="header-navigation"><PublicNavigation /></div><div className="header-actions"><ThemeToggle /><ButtonLink href={routeHref('overview')}>Launch app</ButtonLink></div></div><details className="mobile-public-nav"><summary>Explore Sluice</summary><PublicNavigation /></details></header>; }
export function PublicFooter() { return <footer className="site-footer"><div className="footer-top"><div><Brand /><p>Financial infrastructure for machines.</p></div><nav aria-label="Footer navigation">{(['docs','overview','security','status','changelog'] as const).map(id => <Link key={id} href={routeHref(id)}>{id === 'overview' ? 'App' : id.charAt(0).toUpperCase() + id.slice(1)}</Link>)}</nav></div><div className="footer-bottom"><span>© {copyrightYear} Sluice. AgentPay is a working protocol name.</span><span className="mono">BUILT ON ARC · TESTNET</span></div></footer>; }
export function PublicShell({ children }: { children: ReactNode }) { return <><PublicHeader /><main id="main-content" className="marketing-main">{children}</main><PublicFooter /></>; }
export function DocsSearch() { return <CommandPalette />; }
