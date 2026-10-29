import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { PageHeading } from "@/web/components/ui";
import { ApiListingDetail } from "@/web/components/api-directory";
import { pageMetadata } from "@/web/lib/metadata";
export const metadata = pageMetadata("api-listing");
export default async function Page({
  params,
}: {
  params: Promise<{ provider: string; slug: string }>;
}) {
  const { provider, slug } = await params;
  if (!isAddress(provider) || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug))
    notFound();
  return (
    <>
      <PageHeading
        eyebrow="API DIRECTORY"
        title="API details"
        description="Review the API’s price and payment terms, then choose a wallet for your agent."
      />
      <div className="live-workspace">
        <ApiListingDetail provider={provider} slug={slug} />
      </div>
    </>
  );
}
