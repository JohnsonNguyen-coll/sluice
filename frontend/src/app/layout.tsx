import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { siteConfig } from '@/web/lib/site-config';
export const metadata: Metadata = { metadataBase: new URL(siteConfig.url), title: { default: 'Sluice — Payment infrastructure for AI agents', template: '%s | Sluice' }, description: siteConfig.description, icons: { icon: '/brand/favicon.svg' } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, colorScheme: 'dark light' };
const bootTheme = "(function(){try{var t=localStorage.getItem('sluice-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:'system'}catch(e){document.documentElement.dataset.theme='system'}})();";
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:bootTheme}} /></head><body><a className="skip-link" href="#main-content">Skip to content</a>{children}</body></html>; }
