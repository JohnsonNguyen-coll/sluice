import Link from 'next/link';
import type { ReactNode } from 'react';
import { Brand, ButtonLink } from './ui';
import { PublicNavigation } from './navigation';
import { ThemeToggle } from './theme';
import { CommandPalette } from './command-palette';
import { routeHref, type RouteId } from '../lib/routes';
const copyrightYear = new Date().getUTCFullYear();
export function PublicHeader() { return <header className="site-header"><div className="header-inner"><Brand /><div className="header-navigation"><PublicNavigation /></div><div className="header-actions"><ThemeToggle /><ButtonLink href={routeHref('overview')}>Launch app</ButtonLink></div></div><details className="mobile-public-nav"><summary>Explore Sluice</summary><PublicNavigation /></details></header>; }
const footerGroups: { title: string; links: { id: RouteId; label: string }[] }[] = [
 { title: 'Build', links: [{id:'docs',label:'Documentation'},{id:'docs-quickstart-agent',label:'Agent quickstart'},{id:'docs-quickstart-provider',label:'Provider quickstart'},{id:'docs-contracts-addresses',label:'Contract addresses'}]},
 { title: 'Protocol', links: [{id:'how',label:'How it works'},{id:'security',label:'Security'},{id:'pricing',label:'Pricing'},{id:'roadmap',label:'Roadmap'}]},
 { title: 'Explore', links: [{id:'overview',label:'Dashboard'},{id:'status',label:'Network status'},{id:'changelog',label:'Changelog'}]},
];
export function PublicFooter() { return <footer className="site-footer"><div className="footer-content"><div className="footer-grid"><div className="footer-brand-block"><Brand/><p className="footer-brand-copy">Payment infrastructure for autonomous software. Built on Arc.</p></div>{footerGroups.map(group=><nav aria-label={group.title+' footer links'} className="footer-link-group" key={group.title}><strong>{group.title}</strong>{group.links.map(item=><Link key={item.id} href={routeHref(item.id)}>{item.label}</Link>)}</nav>)}</div><div className="footer-bottom"><span>© {copyrightYear} Sluice. AgentPay is a working protocol name.</span><span className="mono">ARC TESTNET / DEVELOPER PREVIEW</span></div></div></footer>; }
export function PublicShell({ children }: { children: ReactNode }) { return <><PublicHeader /><main id="main-content" className="marketing-main">{children}</main><PublicFooter /></>; }
export function DocsSearch() { return <CommandPalette />; }
