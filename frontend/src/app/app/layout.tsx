import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { WalletProviders } from '@/web/components/wallet-providers';
import { AppShell } from '@/web/components/app-shell';
import { PageLoading } from '@/web/components/states';
export const dynamic = 'force-dynamic';
export default function WorkspaceLayout({children}:{children:ReactNode}) { return <WalletProviders><AppShell><Suspense fallback={<PageLoading />}>{children}</Suspense></AppShell></WalletProviders>; }
