import { PageHeading, Badge, Card, EmptyState } from "./ui";
import { WalletTabs } from "./app-tools";
import { routeById, type RouteId } from "../lib/routes";
import { LiveWorkspace } from "./live-workspace";
import { LegacyDashboard } from "./legacy-dashboard";
export function AppPage({ id, record }: { id: RouteId; record?: string }) {
  const route = routeById(id),
    planned = ["org", "team", "approvals", "approval"].includes(id);
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE / ARC TESTNET"
        title={route.title}
        description={route.description}
      >
        <Badge tone={planned ? "neutral" : "accent"}>
          {planned ? "Planned" : "Testnet"}
        </Badge>
      </PageHeading>
      {record && (
        <Card className="record-card">
          <span className="small muted">Selected record</span>
          <code>{record}</code>
        </Card>
      )}
      {record && id.startsWith("wallet") && <WalletTabs address={record} />}
      {planned ? (
        <EmptyState
          title="This capability is planned."
          description="Organization and approval features are not enabled."
        />
      ) : (
        <LiveWorkspace id={id} record={record} />
      )}
      {id === "overview" && <LegacyDashboard />}
    </>
  );
}
