'use client';
import { usePathname } from 'next/navigation';
import { Brand, ButtonLink } from './ui';
import { PublicNavigation } from './navigation';
import { ThemeToggle } from './theme';
import { routeHref } from '../lib/routes';
export function PublicHeader() {
 const pathname=usePathname();
 return <header className={'site-header'+(pathname==='/'?' site-header-floating':'')}><div className="header-inner"><Brand/><div className="header-navigation"><PublicNavigation/></div><div className="header-actions"><ThemeToggle/><ButtonLink href={routeHref('overview')}>Launch app</ButtonLink></div></div><details className="mobile-public-nav" key={pathname}><summary>Explore Sluice</summary><PublicNavigation/></details></header>;
}
