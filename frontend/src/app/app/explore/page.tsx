import { PageHeading } from "@/web/components/ui";
import { ApiDirectory } from "@/web/components/api-directory";
import { pageMetadata } from "@/web/lib/metadata";
export const metadata = pageMetadata("explore");
export default function Page() {
  return (
    <>
      <PageHeading
        eyebrow="EXPLORE"
        title="API Directory"
        description="Find APIs your agent can pay for. Compare provider-published prices and refund terms before setting a budget."
      />
      <div className="live-workspace">
        <ApiDirectory />
      </div>
    </>
  );
}
