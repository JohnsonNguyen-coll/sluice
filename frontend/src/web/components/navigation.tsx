'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { routeManifest, routeHref, type RouteId } from '../lib/routes';
import { ArrowUpRight, BookOpen, Wallet, LayoutDashboard, Receipt, ShieldCheck, Building2, ListFilter } from 'lucide-react';
const appItems: { id: RouteId; label: string; icon: typeof Wallet }[] = [
 { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'wallets', label: 'Agent wallets', icon: Wallet },
 { id: 'provider', label: 'Provider', icon: Receipt }, { id: 'disputes', label: 'Disputes', icon: ShieldCheck },
 { id: 'approvals', label: 'Approvals', icon: ShieldCheck }, { id: 'org', label: 'Organization', icon: Building2 },
 { id: 'audit', label: 'Audit activity', icon: ListFilter },
];
export function AppNavigation() {
 const pathname = usePathname();
 return <nav aria-label="App navigation" className="app-nav">{appItems.map(({ id, label, icon: Icon }) => {
 const path = routeHref(id); const active = pathname === path || (path !== routeHref('overview') && pathname.startsWith(path + '/'));
 return <Link key={id} href={path} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}><Icon size={18} aria-hidden="true" />{label}{id === 'org' && <span className="nav-note">Planned</span>}</Link>;
 })}</nav>;
}
export function DocsNavigation() {
 const pathname = usePathname();
 const entries = routeManifest.filter(route => route.area === 'docs');
 const groupNames: Record<string, string> = { quickstart: 'Get started', concepts: 'Core concepts', sdk: 'SDK', middleware: 'Middleware', contracts: 'Contracts', guides: 'Guides', security: 'Security' };
 return <nav aria-label="Documentation navigation" className="docs-nav"><Link href={routeHref('docs')} className={pathname === routeHref('docs') ? 'active' : ''} aria-current={pathname === routeHref('docs') ? 'page' : undefined}><BookOpen size={15} aria-hidden="true" />Overview</Link>{Object.entries(groupNames).map(([group, label]) => <details key={group} open><summary>{label}</summary>{entries.filter(route => route.path.startsWith('/docs/' + group + '/')).map(route => <Link href={route.path} key={route.id} className={pathname === route.path ? 'active' : ''} aria-current={pathname === route.path ? 'page' : undefined}>{route.title}</Link>)}</details>)}<Link href={routeHref('docs-faq')} aria-current={pathname === routeHref('docs-faq') ? 'page' : undefined}>FAQ</Link></nav>;
}
export function PublicNavigation() {
 const pathname = usePathname();
 const ids: RouteId[] = ['how', 'docs', 'security', 'pricing', 'roadmap'];
 return <nav aria-label="Main navigation" className="public-nav">{ids.map(id => { const route = routeManifest.find(item => item.id === id)!; const active = pathname === route.path || (id === 'docs' && pathname.startsWith('/docs/')); return <Link href={route.path} key={id} aria-current={active ? 'page' : undefined}>{id === 'how' ? 'How it works' : id === 'docs' ? 'Docs' : route.title.replace('Security by design','Security').replace('Transparent protocol fees','Pricing').replace('A protocol built in stages','Roadmap')}</Link>; })}</nav>;
}
export function Breadcrumbs() {
 const pathname=usePathname();const segments=pathname.split('/').filter(Boolean);
 return <nav aria-label="Breadcrumb" className="breadcrumbs"><ol>{segments.map((segment,index)=>{
 const href='/'+segments.slice(0,index+1).join('/');
 const title=segment.startsWith('0x')?segment.slice(0,6)+'…'+segment.slice(-4):segment.replaceAll('-',' ');
 const navigable=routeManifest.some(route=>new RegExp('^'+route.path.replace(/\[\w+\]/g,'[^/]+')+'$').test(href));
 return <li key={href}>{index>0&&<span aria-hidden="true">/</span>}{index===segments.length-1||!navigable?<span aria-current={index===segments.length-1?'page':undefined}>{title}</span>:<Link href={href}>{title}</Link>}</li>;
 })}</ol></nav>;
}
export function MobileNavigation({docs=false}:{docs?:boolean}){return <details className="mobile-navigation"><summary>{docs?'Documentation menu':'Workspace menu'}<ArrowUpRight size={16} aria-hidden="true"/></summary><div>{docs?<DocsNavigation/>:<AppNavigation/>}</div></details>;}
