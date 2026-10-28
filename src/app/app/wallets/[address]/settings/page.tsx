import { AppPage } from '@/web/components/app-page';
import { pageMetadata } from '@/web/lib/metadata';
import { notFound } from 'next/navigation';
export const metadata = pageMetadata('wallet-settings');

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
 const { address: value } = await params;
 if (!/^0x[0-9a-fA-F]{40}$/ .test(value)) notFound();
 return <AppPage id="wallet-settings" record={value} />;
}
