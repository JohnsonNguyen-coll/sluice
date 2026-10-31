import { PageHeading, Badge, Card, EmptyState } from "./ui";
import { WalletTabs } from "./app-tools";
import { routeById, type RouteId } from "../lib/routes";
import { LiveWorkspace } from "./live-workspace";
export function AppPage({ id, record }: { id: RouteId; record?: string }) {
  const route = routeById(id),
    planned = ["org", "team", "approvals", "approval"].includes(id);
  const descriptions: Record<string, string> = {
    overview:
      "Your agent payments, all in one place. Set up a wallet, control spending and track real payments.",
    wallets:
      "Manage the USDC wallets you create for your agents. You own the funds and set the spending rules.",
    "wallet-new":
      "Create a separate payment account for an agent you already run.",
    wallet: "Add funds and review payments for this agent’s wallet.",
    "wallet-budgets":
      "Choose which API services your agent can pay and how much each can collect.",
    "wallet-activity": "Follow confirmed transactions for this payment wallet.",
    "wallet-settings":
      "Manage ownership, payment controls and the key your agent uses to sign payments.",
    provider:
      "Connect an existing API, set a per-call price and receive agent payments.",
    "provider-settlements":
      "Review payment receipts and funds awaiting release. Only records available to your signed-in wallet appear here.",
    disputes:
      "Find a payment receipt to review its refund options, or open a payment using its reference.",
    dispute:
      "Review this payment, its refund deadlines and the actions available to your wallet.",
    audit: "Look up a wallet to review its confirmed payment activity.",
  };
  return (
    <>
      <PageHeading
        eyebrow="SLUICE WORKSPACE"
        title={route.title}
        description={descriptions[id] || route.description}
      >
        <Badge tone={planned ? "neutral" : "accent"}>
          {planned ? "Planned" : "Testnet"}
        </Badge>
      </PageHeading>
      {record && (
        <Card className="record-card compact-record">
          <span className="small muted">
            {id.startsWith("wallet")
              ? "Payment wallet address"
              : "Payment reference"}
          </span>
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
    </>
  );
}
