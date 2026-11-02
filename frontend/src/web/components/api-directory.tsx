"use client";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { verifyDomain } from "@sluice/sdk";
import Link from "next/link";
import { Search, ArrowUpRight } from "lucide-react";
import { apiBase, useApi, ApiSignIn } from "./api-session";
import { Button, ButtonLink, Card, Callout } from "./ui";
import { CodeBlock, AddressChip } from "./primitives";
import { routes } from "../lib/routes";
import { shortAddress } from "../lib/site-config";
export type ApiListing = {
  chain_id: number;
  provider: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  endpoint: string;
  method: "GET" | "POST";
  docs_url: string;
  price: string;
  published: boolean;
  updated_at: string;
  providerStatus: "active" | "inactive" | "unavailable";
  disputeWindow: number | null;
  token: string;
  decimals: number;
};
const categories = ["Data", "AI", "Search", "Tools", "Other"];
const holdTime = (seconds: number) =>
  seconds % 86400 === 0
    ? seconds / 86400 + " day" + (seconds === 86400 ? "" : "s")
    : seconds % 3600 === 0
      ? seconds / 3600 + " hour" + (seconds === 3600 ? "" : "s")
      : seconds % 60 === 0
        ? seconds / 60 + " minute" + (seconds === 60 ? "" : "s")
        : seconds + " seconds";
export function ApiDirectory() {
  const { request, revision } = useApi(),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [offset, setOffset] = useState(0);
  const listing = useQuery({
    queryKey: ["api-directory", search, category, offset, revision],
    retry: false,
    queryFn: () =>
      request<{ items: ApiListing[]; hasMore: boolean }>(
        "/directory?limit=12&offset=" +
          offset +
          "&q=" +
          encodeURIComponent(search) +
          "&category=" +
          category,
      ),
  });
  return (
    <>
      <div className="directory-toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(
              String(new FormData(e.currentTarget).get("q") || "").trim(),
            );
            setOffset(0);
          }}
        >
          <label className="live-field">
            <span>Find an API</span>
            <input name="q" placeholder="Search by API name" maxLength={80} />
          </label>
          <Button variant="secondary">
            <Search size={16} />
            Search
          </Button>
        </form>
        <label className="live-field">
          <span>Category</span>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <ButtonLink href="/app/provider" variant="ghost">
          Publish your API
        </ButtonLink>
      </div>
      <p className="field-help">
        Providers publish their own API details and prices. Registration is
        checked on Arc Testnet; service quality and live pricing are not
        guaranteed. No provider is featured or rated without data.
      </p>
      {listing.isLoading ? (
        <p role="status">Checking published APIs and provider registration…</p>
      ) : listing.error ? (
        <Callout title="API Directory is unavailable" tone="warn">
          {listing.error.message}{" "}
          <Button variant="ghost" onClick={() => void listing.refetch()}>
            Retry
          </Button>
        </Callout>
      ) : !listing.data?.items.length ? (
        <Card className="directory-empty">
          <h2>
            {search || category
              ? "No APIs match this search"
              : "No APIs published yet"}
          </h2>
          <p>
            Only real provider-published listings appear here. Register your API
            service and publish its first listing to make it discoverable.
          </p>
          <ButtonLink href="/app/provider" variant="secondary">
            Set up a provider
          </ButtonLink>
        </Card>
      ) : (
        <div className="directory-grid">
          {listing.data.items.map((item) => (
            <Card key={item.provider + item.slug} className="directory-card">
              <div className="wallet-card-top">
                <span className="badge">{item.category}</span>
                <span
                  className={
                    "badge " +
                    (item.providerStatus === "active"
                      ? "badge-success"
                      : "badge-warning")
                  }
                >
                  {item.providerStatus === "active"
                    ? "Registered provider"
                    : item.providerStatus === "inactive"
                      ? "Provider inactive"
                      : "Registration unavailable"}
                </span>
              </div>
              <h2>{item.name}</h2>
              <p>{item.description}</p>
              <div className="directory-price">
                {formatUnits(BigInt(item.price), 6)} <span>USDC / call</span>
              </div>
              <p className="field-help">
                Listed price · live API quote may differ
              </p>
              <div className="directory-card-meta">
                <span>
                  {item.disputeWindow === null
                    ? "Refund terms unavailable"
                    : item.disputeWindow === 0
                      ? "Instant payout · no refund hold"
                      : holdTime(item.disputeWindow) + " refund hold"}
                </span>
                <code title={item.provider}>{shortAddress(item.provider)}</code>
              </div>
              <ButtonLink
                href={"/app/explore/" + item.provider + "/" + item.slug}
                variant="secondary"
              >
                View API
              </ButtonLink>
            </Card>
          ))}
        </div>
      )}
      <div className="live-actions">
        <Button
          variant="ghost"
          disabled={offset === 0 || listing.isFetching}
          onClick={() => setOffset(Math.max(0, offset - 12))}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          disabled={!listing.data?.hasMore || listing.isFetching}
          onClick={() => setOffset(offset + 12)}
        >
          Next
        </Button>
      </div>
    </>
  );
}
export function ApiListingDetail({
  provider,
  slug,
}: {
  provider: string;
  slug: string;
}) {
  const { request, revision, config } = useApi(),
    { address } = useAccount(),
    [selected, setSelected] = useState(""),
    [domain, setDomain] = useState(""),
    [checking, setChecking] = useState(false);
  const entry = useQuery({
    queryKey: ["api-listing", provider, slug, revision],
    retry: false,
    queryFn: () =>
      request<{ listing: ApiListing }>("/directory/" + provider + "/" + slug),
  });
  const wallets = useQuery({
    queryKey: ["directory-wallets", address, revision],
    enabled: !!address,
    retry: false,
    queryFn: () =>
      request<{ items: { wallet: string }[] }>(
        "/wallets?owner=" + address + "&limit=100",
      ),
  });
  const reputation = useQuery({
    queryKey: ["directory-provider-history", provider, revision],
    retry: false,
    queryFn: () =>
      request<{
        provider: {
          settledCount: string;
          disputesLost: string;
          disputesAutoRefunded: string;
        };
      }>("/reputation/" + provider),
  });
  const item = entry.data?.listing,
    chosen = wallets.data?.items.some((x) => x.wallet === selected)
      ? selected
      : wallets.data?.items[0]?.wallet;
  let managedServiceId = "";
  if (item) {
    try {
      const endpoint = new URL(item.endpoint);
      const match = endpoint.pathname.match(/^\/hosted\/([a-f0-9-]{36})$/);
      if (endpoint.origin === new URL(apiBase).origin && match) managedServiceId = match[1];
    } catch { /* External provider URLs do not have a built-in playground. */ }
  }
  if (entry.isLoading)
    return <p role="status">Checking this API’s listing and provider…</p>;
  if (entry.error || !item)
    return (
      <Callout title="This listing is unavailable" tone="warn">
        {entry.error?.message || "No published API found."}
      </Callout>
    );
  return (
    <>
      <Card className="api-detail-intro">
        <span className="badge">{item.category}</span>
        <h2>{item.name}</h2>
        <p>{item.description}</p>
        <div className="directory-price">
          {formatUnits(BigInt(item.price), 6)}{" "}
          <span>USDC per call · provider-declared price</span>
        </div>
        <p className="field-help">
          The SDK checks the actual 402 quote against your spending policy
          before signing. A listing never authorizes a payment.
        </p>
      </Card>
      <div className="live-grid">
        <Card>
          <h2>Provider & refund terms</h2>
          <dl className="readable-facts">
            <div>
              <dt>Registration</dt>
              <dd>
                {item.providerStatus === "active"
                  ? "Active on Arc Testnet"
                  : item.providerStatus === "inactive"
                    ? "Inactive"
                    : "Could not verify"}
              </dd>
            </div>
            <div>
              <dt>Refund hold</dt>
              <dd>
                {item.disputeWindow === null
                  ? "Unavailable"
                  : item.disputeWindow === 0
                    ? "No hold — instant payout"
                    : holdTime(item.disputeWindow)}
              </dd>
            </div>
            <div>
              <dt>Last listing update</dt>
              <dd>{new Date(item.updated_at).toLocaleString()}</dd>
            </div>
          </dl>
          <AddressChip address={item.provider} />
          <dl className="readable-facts">
            <div>
              <dt>Recorded settlements</dt>
              <dd>{reputation.data?.provider.settledCount ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Disputes lost / auto-refunded</dt>
              <dd>
                {reputation.data
                  ? reputation.data.provider.disputesLost +
                    " / " +
                    reputation.data.provider.disputesAutoRefunded
                  : "Unavailable"}
              </dd>
            </div>
          </dl>
          <p className="field-help">
            Verified registry counters across the provider, not a rating or
            history for this particular endpoint.
          </p>
          <p className="field-help">
            A registered address is not a guarantee of API quality. Refund
            decisions follow the provider’s configured arbiter and the contract
            deadlines.
          </p>
          <Button
            variant="secondary"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              setDomain("");
              void verifyDomain(item.endpoint, item.chain_id)
                .then((proof) => {
                  if (
                    proof.provider.toLowerCase() !== item.provider.toLowerCase()
                  )
                    throw Error("The domain proof belongs to another provider");
                  setDomain(
                    "Verified signed domain proof until " +
                      new Date(proof.expiresAt * 1000).toLocaleString(),
                  );
                })
                .catch((e) =>
                  setDomain(
                    "Not verified: " +
                      (e instanceof Error ? e.message : "Proof unavailable"),
                  ),
                )
                .finally(() => setChecking(false));
            }}
          >
            {checking ? "Checking domain…" : "Verify API domain"}
          </Button>
          {domain && (
            <p role="status" className="field-help">
              {domain}
            </p>
          )}
          <p className="field-help">
            Verification requires a current signed /.well-known/agentpay.json
            document and browser CORS access. The API endpoint is not called by
            this check.
          </p>
        </Card>
        <Card>
          <h2>Use this API with your agent</h2>
          <p>
            Choose a payment wallet, then set this provider’s allowance. You
            review and sign the budget transaction in your own wallet.
          </p>
          {!address ? (
            <p className="field-help">
              Connect your wallet in the navigation to continue.
            </p>
          ) : wallets.isLoading ? (
            <p role="status">Loading your payment wallets…</p>
          ) : wallets.error ? (
            <p role="alert">{wallets.error.message}</p>
          ) : chosen ? (
            <>
              <label className="live-field">
                <span>Payment wallet</span>
                <select
                  value={chosen}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {wallets.data?.items.map((w) => (
                    <option value={w.wallet} key={w.wallet}>
                      {shortAddress(w.wallet)}
                    </option>
                  ))}
                </select>
              </label>
              {item.providerStatus === "active" ? (
                <ButtonLink
                  href={
                    routes.wallet(chosen, "budgets") +
                    "?provider=" +
                    item.provider
                  }
                  variant="primary"
                >
                  Set provider allowance
                </ButtonLink>
              ) : (
                <p className="field-help">
                  A verified active provider is required to continue from this
                  listing.
                </p>
              )}
            </>
          ) : (
            <ButtonLink href="/app/wallets/new">
              Create a payment wallet
            </ButtonLink>
          )}
          <p className="field-help">
            For a transferred wallet, open its address directly. Its current
            owner is checked before any write action.
          </p>
          <details className="workspace-disclosure">
            <summary>Agent integration configuration</summary>
            <CodeBlock
              filename="provider.json"
              language="json"
              code={JSON.stringify(
                {
                  chainId: config?.chainId,
                  wallet: chosen,
                  provider: item.provider,
                  endpoint: item.endpoint,
                  method: item.method,
                  token: item.token,
                  listedPriceBaseUnits: item.price,
                },
                null,
                2,
              )}
            />
            <p className="field-help">
              Add this provider to the SDK allowlist and set your own maximum
              price. Your agent still needs code for this API’s request format.
            </p>
          </details>
          <ButtonLink href="/docs/quickstart/agent" variant="ghost">
            SDK integration guide
          </ButtonLink>
        </Card>
      </div>
      <Card>
        <h2>API endpoint</h2>
        <code className="api-endpoint">
          {item.method} {item.endpoint}
        </code>
        <p className="field-help">
          This address is published by the provider. No automatic request or
          payment is made here.
        </p>
        {managedServiceId && <ButtonLink href={"/app/try/" + managedServiceId} variant="primary">Try a paid call ↗</ButtonLink>}
        {item.docs_url && (
          <a
            className="text-link"
            href={item.docs_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Provider documentation <ArrowUpRight size={15} />
          </a>
        )}
        <Link className="text-link" href="/app/explore">
          Back to API Directory
        </Link>
      </Card>
    </>
  );
}
const blank = {
  slug: "",
  name: "",
  description: "",
  category: "Data",
  endpoint: "",
  method: "GET",
  docsUrl: "",
  priceUsdc: "",
  published: false,
};
export function ProviderListings() {
  const { sessionAddress } = useApi();
  return <ProviderListingsEditor key={sessionAddress || "signed-out"} />;
}
function ProviderListingsEditor() {
  const { signedIn, sessionAddress, revision, request, refresh } = useApi(),
    [draft, setDraft] = useState(blank),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const mine = useQuery({
    queryKey: ["my-api-listings", sessionAddress, revision],
    enabled: signedIn,
    retry: false,
    queryFn: () =>
      request<{ items: ApiListing[]; hasMore: boolean }>(
        "/directory/mine?limit=20",
        undefined,
        true,
      ),
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await request(
        "/directory",
        { method: "POST", body: JSON.stringify(draft) },
        true,
      );
      setMessage(
        draft.published
          ? "API listing published. Its registration is checked again when someone browses."
          : "Draft saved. It is not visible in the public directory.",
      );
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the listing");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <div className="section-heading compact">
        <div>
          <h2>Publish your APIs</h2>
          <p className="muted small">
            Make your API discoverable. Listings do not host or implement your
            API.
          </p>
        </div>
        <ApiSignIn />
      </div>
      {!signedIn ? (
        <p className="muted">
          Verify your wallet session to manage your API listings. Publishing
          requires an active on-chain provider registration.
        </p>
      ) : (
        <>
          <div className="listing-switcher">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft({ ...blank });
                setError("");
                setMessage("");
              }}
            >
              New listing
            </Button>
            {mine.data?.items.map((item) => (
              <Button
                key={item.slug}
                variant="secondary"
                onClick={() => {
                  setDraft({
                    slug: item.slug,
                    name: item.name,
                    description: item.description,
                    category: item.category,
                    endpoint: item.endpoint,
                    method: item.method,
                    docsUrl: item.docs_url,
                    priceUsdc: formatUnits(BigInt(item.price), 6),
                    published: item.published,
                  });
                  setMessage("");
                  setError("");
                }}
              >
                {item.name} · {item.published ? "Published" : "Draft"}
              </Button>
            ))}
          </div>
          {mine.error && <p role="alert">{mine.error.message}</p>}
          {mine.data?.hasMore && (
            <p className="field-help">
              Showing the latest 20 listings for this provider.
            </p>
          )}
          <form className="live-form" onSubmit={submit}>
            <div className="live-grid">
              <label className="live-field">
                <span>API name</span>
                <input
                  value={draft.name}
                  maxLength={80}
                  required
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="live-field">
                <span>Listing URL name</span>
                <input
                  value={draft.slug}
                  required
                  maxLength={48}
                  pattern="[a-z0-9][a-z0-9-]*"
                  placeholder="e.g. web-search"
                  onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                />
                <span className="field-help">
                  Use the same URL name to update a listing. A different name
                  creates another listing.
                </span>
              </label>
            </div>
            <label className="live-field">
              <span>What does this API do?</span>
              <textarea
                value={draft.description}
                required
                maxLength={1000}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            <div className="live-grid">
              <label className="live-field">
                <span>HTTPS API endpoint</span>
                <input
                  value={draft.endpoint}
                  type="url"
                  required
                  placeholder="https://your-api.example/search"
                  onChange={(e) =>
                    setDraft({ ...draft, endpoint: e.target.value })
                  }
                />
              </label>
              <label className="live-field">
                <span>Documentation URL (optional)</span>
                <input
                  value={draft.docsUrl}
                  type="url"
                  onChange={(e) =>
                    setDraft({ ...draft, docsUrl: e.target.value })
                  }
                />
              </label>
              <label className="live-field">
                <span>Request method</span>
                <select
                  value={draft.method}
                  onChange={(e) =>
                    setDraft({ ...draft, method: e.target.value })
                  }
                >
                  <option>GET</option>
                  <option>POST</option>
                </select>
              </label>
              <label className="live-field">
                <span>Category</span>
                <select
                  value={draft.category}
                  onChange={(e) =>
                    setDraft({ ...draft, category: e.target.value })
                  }
                >
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="live-field">
                <span>Listed price per call (USDC)</span>
                <input
                  value={draft.priceUsdc}
                  inputMode="decimal"
                  required
                  placeholder="e.g. 0.01"
                  onChange={(e) =>
                    setDraft({ ...draft, priceUsdc: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="live-check">
              <input
                type="checkbox"
                checked={draft.published}
                onChange={(e) =>
                  setDraft({ ...draft, published: e.target.checked })
                }
              />
              Publish in API Directory. I confirm these are my API’s real
              endpoint, documentation and advertised price.
            </label>
            <p className="field-help">
              Endpoint details become public when published. Never include API
              keys, credentials or private URLs. The SDK still checks the actual
              402 price before payment.
            </p>
            <Button disabled={saving}>
              {saving
                ? "Saving…"
                : draft.published
                  ? "Save & publish API"
                  : "Save private draft"}
            </Button>
          </form>
          {message && (
            <p role="status" className="transaction-feedback">
              {message}
            </p>
          )}
          {error && (
            <p role="alert" className="live-error">
              {error}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
