'use client';
import { Button, EmptyState } from './ui';
export function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div role="alert" className="state-page"><p className="eyebrow">REQUEST INTERRUPTED</p><EmptyState title="We couldn’t load this view." description="Your wallet and funds are unaffected. Retry to load the page again." action={<Button onClick={reset}>Try again</Button>} /></div>; }
