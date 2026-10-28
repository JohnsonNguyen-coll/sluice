import { LandingFoundation } from '@/web/components/foundation-page';
import { pageMetadata } from '@/web/lib/metadata';

export const metadata = pageMetadata('home');
export const dynamic = 'force-static';
export default function Page() {

 return <LandingFoundation />;
}
