import { FoundationPage } from '@/web/components/foundation-page';
import { pageMetadata } from '@/web/lib/metadata';

export const metadata = pageMetadata('docs-security-threat-model');
export const dynamic = 'force-static';
export default function Page() {

 return <FoundationPage id="docs-security-threat-model" />;
}
