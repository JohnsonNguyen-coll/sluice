import { AppPage } from '@/web/components/app-page';
import { pageMetadata } from '@/web/lib/metadata';
import { notFound } from 'next/navigation';
export const metadata = pageMetadata('profile');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
 const { id: value } = await params;
 if (!/^[a-zA-Z0-9_-]{1,128}$/ .test(value)) notFound();
 return <AppPage id="profile" record={value} />;
}
