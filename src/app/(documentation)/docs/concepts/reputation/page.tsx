import { FoundationPage } from '@/web/components/foundation-page';
import { pageMetadata } from '@/web/lib/metadata';

export const metadata = pageMetadata('docs-concepts-reputation');
export const dynamic = 'force-static';
export default function Page() {

 return <FoundationPage id="docs-concepts-reputation" />;
}
