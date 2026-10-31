"use client";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import Link from "next/link";
import { KeyRound, Globe, ArrowRight } from "lucide-react";
import { useApi, ApiSignIn } from "./api-session";
import { Button, Card, Callout } from "./ui";
import { AddressChip, CodeBlock } from "./primitives";
import { explorerTransaction } from "../lib/site-config";
import { routes } from "../lib/routes";
import { WalletControl } from "./wallet-control";
import { DisputeAssistant, type NegotiationState } from "./negotiation";
type Service = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  connection?: { url: string; method: "GET" | "POST"; auth: string; header: string; hasKey: boolean; testedAt: string | null } | null;
  owner: Address;
  provider: Address;
  price: string;
  state: "draft" | "active" | "paused";
  published: boolean;
  endpoint: string;
  x402Endpoint: string;
  registrationTx: Hex | null;
  lastSettlementTx: Hex | null;
  lastWorkerAt: string | null;
  workerError: string | null;
};
type Capabilities = {
  available: boolean;
  templates: {
    id: string;
    name: string;
    description: string;
    example: unknown;
  }[];
  canPublish: boolean;
  gasDepositWei: string;
  notice: string;
};
export function ManagedServices() {
  const { sessionAddress } = useApi();
  return <ManagedServicesEditor key={sessionAddress || "signed-out"} />;
}
function GatewayConnection({ service }: { service: Service }) {
  const { request, refresh } = useApi();
  const [pending, setPending] = useState(false), [result, setResult] = useState(""), [error, setError] = useState("");
  const connection = service.connection!;
  async function submit(event: FormEvent<HTMLFormElement>, rotate: boolean) {
    event.preventDefault();
    const element = event.currentTarget, data = new FormData(element);
    setPending(true); setError(""); setResult("");
    try {
      if (rotate) {
        await request("/managed-services/" + service.id + "/connection", {method:"POST", body:JSON.stringify({upstreamKey:data.get("key")})}, true);
        element.reset(); setResult("Key replaced. Run a new connection test before resuming.");
      } else {
        const payload: unknown = JSON.parse(String(data.get("payload")));
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("Test input must be a JSON object");
        const response = await request<{ok:boolean; status:number; message:string}>("/managed-services/" + service.id + "/test", {method:"POST",body:JSON.stringify({payload,confirm:data.get("confirm") === "on"})},true);
        if (!response.ok) setError(response.message + " (HTTP " + response.status + ")");
        else setResult(response.message);
      }
      refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Connection operation failed"); }
    finally { setPending(false); }
  }
  return <section className="gateway-connection">
    <div className="gateway-connection-meta"><span className="badge">{connection.method}</span><code>{connection.url}</code><span className="badge">{connection.auth === "none" ? "Public upstream" : "API key stored securely"}</span></div>
    <p className="field-help">{connection.testedAt ? "Last successful connection test: " + new Date(connection.testedAt).toLocaleString() : "Test your connection before activating. No test request has passed yet."}</p>
    {service.state !== "active" ? <>
      <details className="hosted-info" open={!connection.testedAt}>
        <summary>Test your upstream connection</summary>
        <form className="live-form" onSubmit={event => void submit(event, false)}>
          <label className="live-field"><span>Test request JSON</span><textarea name="payload" required rows={5} maxLength={24000} defaultValue={connection.method === "GET" ? '{"query": {}}' : '{}'} spellCheck={false} /><span className="field-help">Use a valid example for your API. Credentials are injected on the server. The response body is not displayed or stored by this test.</span></label>
          <label className="live-check"><input name="confirm" type="checkbox" required />Send one real request to my upstream API. It may consume upstream credits or cause the endpoint's normal side effects. No Sluice voucher is charged.</label>
          <Button type="submit" variant="secondary" disabled={pending}>{pending ? "Checking…" : "Send test request"}</Button>
        </form>
      </details>
      {connection.hasKey && <details className="hosted-info"><summary>Replace upstream API key</summary><form className="live-form" onSubmit={event => void submit(event,true)}><label className="live-field"><span>New API key</span><input name="key" type="password" required maxLength={4096} autoComplete="new-password" /></label><Button variant="secondary" disabled={pending}>Replace key</Button></form></details>}
    </> : <p className="field-help">Pause new calls to test the connection or replace its API key. The endpoint and method cannot be changed after creation.</p>}
    {result && <p role="status">{result}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
function ManagedServicesEditor() {
  const { signedIn, request, revision, refresh, sessionAddress, config } =
      useApi(),
    { address } = useAccount(),
    { data: wallet } = useWalletClient(),
    client = usePublicClient();
  const [authType, setAuthType] = useState("bearer");
  const [upstreamMethod, setUpstreamMethod] = useState("POST");
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const caps = useQuery({
    queryKey: ["hosted-config"],
    retry: false,
    queryFn: () => request<Capabilities>("/managed-services/config"),
  });
  const mine = useQuery({
    queryKey: ["hosted-services", sessionAddress, revision],
    enabled: signedIn && !!caps.data?.available,
    retry: false,
    refetchInterval: 30000,
    queryFn: () =>
      request<{ items: Service[] }>("/managed-services", undefined, true),
  });
  async function action(id: string, work: () => Promise<void>) {
    setBusy(id);
    setError("");
    setMessage("");
    try {
      await work();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hosted API operation failed");
    } finally {
      setBusy("");
    }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    void action("create", async () => {
      await request(
        "/managed-services",
        {
          method: "POST",
          body: JSON.stringify({
            name: form.get("name"),
            slug: form.get("slug"),
            kind: "http-proxy",
            upstreamUrl: form.get("upstreamUrl"),
            upstreamMethod,
            upstreamAuth: authType,
            upstreamHeader: form.get("upstreamHeader"),
            upstreamKey: form.get("upstreamKey"),
            acceptUpstreamRights: form.get("rights") === "on",
            acceptAttemptBilling: form.get("billing") === "on",
            priceUsdc: form.get("price"),
            published: form.get("published") === "on",
            acceptHostedCustody: form.get("custody") === "on",
          }),
        },
        true,
      );
      const keyInput = element.elements.namedItem("upstreamKey") as HTMLInputElement | null;
      if (keyInput) keyInput.value = "";
      setMessage("Connection saved. Send a test request below, then fund gas and activate.");
    });
  }
  async function activate(service: Service) {
    await action(service.id, async () => {
      if (service.connection && (!service.connection.testedAt || Date.now() - Date.parse(service.connection.testedAt) > 86400000)) throw Error("Test the upstream connection before funding and activation");
      if (!wallet?.account || !client || !address || !config || !caps.data)
        throw Error("Connect your owner wallet");
      if (address.toLowerCase() !== service.owner.toLowerCase())
        throw Error("Switch to the wallet that created this API");
      if ((await wallet.getChainId()) !== config.chainId)
        throw Error("Switch to Arc Testnet");
      const balance = await client.getBalance({ address: service.provider });
      if (balance < parseUnits("0.01", 18)) {
        const hash = await wallet.sendTransaction({
          account: wallet.account,
          chain: wallet.chain,
          to: service.provider,
          value: BigInt(caps.data.gasDepositWei),
        });
        setMessage("Waiting for provider gas funding to confirm…");
        if (
          (await client.waitForTransactionReceipt({ hash })).status !==
          "success"
        )
          throw Error("Gas funding reverted");
      }
      await request(
        "/managed-services/" + service.id + "/activate",
        { method: "POST" },
        true,
      );
      setMessage(
        "Your API is active. Sluice handles signed receipts and checks for settlement every minute.",
      );
    });
  }
  return (
    <>
      <Card className="hosted-builder">
        <header className="hosted-intro">
          <div className="form-step-label">API CONNECTION</div>
          <h2>Connect your API</h2>
          <p>Bring an API you already run. Sluice adds agent payments in front of it.</p>
        </header>
        {!signedIn && <div className="hosted-auth">
          <div><strong>{address ? "Verify your wallet" : "Connect to manage your API"}</strong><p>{address ? "Sign a message to manage your APIs. No transaction or gas fee." : "Your wallet receives payouts. Your upstream API key stays on the server."}</p></div>
          {address ? <ApiSignIn label="Sign in to manage APIs" /> : <WalletControl />}
        </div>}
        {caps.isLoading ? (
          <p role="status">Checking hosted API availability…</p>
        ) : caps.error ? (
          <Callout title="Hosted APIs unavailable" tone="warn">
            {caps.error.message}
          </Callout>
        ) : !caps.data?.available ? (
          <Callout title="Hosted APIs need server configuration" tone="warn">
            The backend needs its provider encryption key, Supabase migration
            and negotiated payment contracts.
          </Callout>
        ) : (
          <>
            <form className="live-form hosted-create-form" onSubmit={create}>
              <fieldset className="hosted-service-picker">
                <legend><span>01</span> Your upstream API</legend>
                <p className="field-help">An existing public HTTPS endpoint returning JSON. Sluice does not create or host your application.</p>
                <div className="gateway-flow"><span><Globe size={18} /> Agent</span><ArrowRight size={18}/><span>Sluice · voucher payment</span><ArrowRight size={18}/><span><KeyRound size={18}/> Your API · private key</span></div>
                <label className="live-field"><span>Upstream endpoint</span><input name="upstreamUrl" type="url" required maxLength={2048} placeholder="https://api.your-company.com/v1/analyze" /><span className="field-help">Fixed HTTPS path, port 443. No keys or query parameters in this URL.</span></label>
                <div className="gateway-choice-row" role="group" aria-label="Upstream request method">{["POST", "GET"].map(method => <button key={method} type="button" className={`gateway-choice ${upstreamMethod === method ? "is-selected" : ""}`} aria-pressed={upstreamMethod === method} onClick={() => setUpstreamMethod(method)}>{method}<small>{method === "POST" ? "Forward a JSON body" : "Forward query parameters"}</small></button>)}</div>
                <p className="field-help">Agents always POST to Sluice. {upstreamMethod === "GET" ? 'Use {"query":{"key":"value"}} to build the upstream GET query.' : "The JSON body is forwarded unchanged to your API."} Streaming, file uploads and dynamic paths are not supported.</p>
                <div className="gateway-choice-row" role="group" aria-label="Upstream authentication">{[{id:"bearer",name:"Bearer token",detail:"Authorization: Bearer …"},{id:"header",name:"API key header",detail:"x-api-key, api-key, …"},{id:"none",name:"No authentication",detail:"Public endpoint"}].map(option => <button key={option.id} type="button" className={`gateway-choice ${authType === option.id ? "is-selected" : ""}`} aria-pressed={authType === option.id} onClick={() => setAuthType(option.id)}>{option.name}<small>{option.detail}</small></button>)}</div>
                {authType === "header" && <label className="live-field"><span>API key header name</span><input name="upstreamHeader" required defaultValue="x-api-key" maxLength={64} /></label>}
                {authType !== "none" && <label className="live-field"><span>Upstream API key</span><input key={authType} name="upstreamKey" type="password" required maxLength={4096} autoComplete="new-password" placeholder="Paste a key authorized for this endpoint" /><span className="field-help">Encrypted before storage. Never sent to agents or included in public API details.</span></label>}
              </fieldset>
              <div className="hosted-details-heading"><span>02</span> Make it yours</div>
              <div className="hosted-field-grid">
              <label className="live-field">
                <span>API name</span>
                <input
                  name="name"
                  required
                  maxLength={80}
                  placeholder="My analysis API"
                />
              </label>
              <label className="live-field">
                <span>Directory slug</span>
                <input
                  name="slug"
                  required
                  maxLength={48}
                  pattern="[a-z0-9][a-z0-9-]*"
                  placeholder="my-analysis-api"
                />
              </label>
              <label className="live-field">
                <span>Price per call (USDC)</span>
                <input
                  name="price"
                  required
                  type="number"
                  min="0.000001"
                  max="1"
                  step="0.000001"
                  defaultValue="0.01"
                />
              </label>
              </div>
              {caps.data.canPublish ? (
                <label className="live-check">
                  <input name="published" type="checkbox" />
                  Publish in API Directory after activation
                </label>
              ) : (
                <p className="field-help">
                  Local endpoint only. Directory publishing becomes available
                  when the operator configures a public HTTPS API origin.
                </p>
              )}
              <details className="hosted-info">
                <summary>Hosting, payouts & key security</summary>
                <p>Your application stays on your own server. Sluice forwards authenticated requests after checking vouchers and encrypts your upstream API key separately from its payment signer. Customer payments go to your wallet. The generated payment endpoint uses a service ID, not the Directory slug.</p>
              </details>
              <label className="live-check"><input name="rights" type="checkbox" required />I own this API or have permission to expose and charge for access to it.</label>
              <label className="live-check"><input name="billing" type="checkbox" required />I accept per-request-attempt billing: an accepted voucher is charged even if the upstream returns an error or times out. Signed receipts support refund claims; refunds are not automatic.</label>
              <label className="live-check">
                <input name="custody" type="checkbox" required />I authorize
                Sluice to forward requests and use its encrypted provider key for
                registration, receipts, settlement and provider actions I
                request. Payouts go to my connected wallet.
              </label>
              <p className="field-help">
                Activation may request{" "}
                {formatUnits(BigInt(caps.data.gasDepositWei), 18)} testnet
                native USDC for provider gas. Payments are held for 1 hour so a
                customer can open a claim; claims then use 30-minute negotiation
                and last-resort arbitration rules.
              </p>
              <Button disabled={!signedIn || !!busy}>
                {busy === "create" ? "Creating API…" : "Create API"}
              </Button>
            </form>
          </>
        )}
      </Card>
      {error && (
        <Callout title="Action could not complete" tone="warn">
          {error}
        </Callout>
      )}
      {message && <p role="status">{message}</p>}
      {mine.error && (
        <Callout title="Could not load your hosted APIs" tone="warn">
          {mine.error.message}
        </Callout>
      )}
      {mine.data?.items.map((s) => (
        <Card key={s.id}>
          <div className="live-actions">
            <span className="badge">
              {s.state === "draft"
                ? "Needs activation"
                : s.state === "active"
                  ? "Active"
                  : "Paused"}
            </span>
            <span className="badge">
              {formatUnits(BigInt(s.price), 6)} USDC / call
            </span>
            <span className="badge">
              {s.published ? "Directory publishing enabled" : "Unlisted"}
            </span>
          </div>
          <h2>{s.name}</h2>
          {s.kind !== "http-proxy" && <p className="field-help">Legacy hosted utility · retained for existing receipts and payments.</p>}
          {s.connection && <GatewayConnection service={s} />}
          <p>
            Provider: <AddressChip address={s.provider} />
          </p>
          <p>
            Payout wallet: <AddressChip address={s.owner} />
          </p>
          <CodeBlock
            code={s.endpoint}
            filename="AgentPay endpoint"
            language="text"
          />
          <p className="field-help">
            POST a JSON body to this endpoint using AgentPay. GET the same URL
            for the request example and payment details. No SDK installation is
            needed to connect an existing API; callers use the agent SDK for
            payment authorization.
          </p>
          <CodeBlock
            code={s.x402Endpoint}
            filename="x402 v2 · batch-settlement endpoint"
            language="text"
          />
          <p className="field-help">
            Standard x402 clients POST the same JSON here. The API result is
            returned to the caller in the paid HTTP response body, after the
            payment voucher has been verified and committed. This dashboard
            never publishes or stores that private result. x402 provides
            interoperable escrow and payment; use the AgentPay endpoint when
            you also need signed receipts, negotiation and DisputeVault
            protection.
          </p>
          <div className="live-actions">
            {s.state !== "active" && (
              <Button
                disabled={!!busy || !!s.workerError || (!!s.connection && (!s.connection.testedAt))}
                onClick={() => void activate(s)}
              >
                {busy === s.id
                  ? "Activating…"
                  : s.state === "draft"
                    ? "Fund gas & activate"
                    : "Resume API"}
              </Button>
            )}
            {s.state === "active" && (
              <Button
                variant="secondary"
                disabled={!!busy}
                onClick={() =>
                  void action(s.id, async () => {
                    await request(
                      "/managed-services/" + s.id + "/pause",
                      { method: "POST" },
                      true,
                    );
                    setMessage(
                      "API paused. Already accepted vouchers will still be settled.",
                    );
                  })
                }
              >
                Pause new calls
              </Button>
            )}
            <a
              className="text-link"
              href={s.endpoint}
              target="_blank"
              rel="noopener noreferrer"
            >
              Request format ↗
            </a>
            {s.published && s.state === "active" && (
              <Link
                className="text-link"
                href={"/app/explore/" + s.provider + "/" + s.slug}
              >
                Directory listing ↗
              </Link>
            )}
          </div>
          {s.workerError ? (
            <Callout title="Provider needs operator attention" tone="warn">
              {s.workerError}
            </Callout>
          ) : (
            s.state !== "draft" && (
              <p className="field-help">
                Last worker check:{" "}
                {s.lastWorkerAt
                  ? new Date(s.lastWorkerAt).toLocaleString()
                  : "Waiting for the first check"}
                . Settlement runs every minute; transaction confirmation and RPC
                availability can add time.
              </p>
            )
          )}
          {s.registrationTx && (
            <p>
              <a
                className="text-link"
                href={explorerTransaction(s.registrationTx)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Provider registration ↗
              </a>
            </p>
          )}
          {s.lastSettlementTx && (
            <p>
              <a
                className="text-link"
                href={explorerTransaction(s.lastSettlementTx)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Latest settlement ↗
              </a>
            </p>
          )}
          <HostedReceipts service={s} />
        </Card>
      ))}
    </>
  );
}
function HostedReceipts({ service }: { service: Service }) {
  const { request, sessionAddress, revision } = useApi(),
    [show, setShow] = useState(false);
  const receipts = useQuery({
    queryKey: ["hosted-receipts", service.id, sessionAddress, revision],
    enabled: show,
    retry: false,
    refetchInterval: 30000,
    queryFn: () =>
      request<{
        items: {
          id: string;
          receipt: { receipt: { amount: string; voucherHash: string } };
          commitment?: { settlementId: string };
        }[];
      }>(
        "/receipts?provider=" + service.provider + "&limit=20",
        undefined,
        true,
      ),
  });
  return (
    <details
      className="workspace-disclosure"
      onToggle={(e) => setShow(e.currentTarget.open)}
    >
      <summary>Receipts &amp; payment details</summary>
      {receipts.isLoading ? (
        <p>Loading signed receipts…</p>
      ) : receipts.error ? (
        <p role="alert">{receipts.error.message}</p>
      ) : !receipts.data?.items.length ? (
        <p>No receipts yet. A successful paid call will appear here.</p>
      ) : (
        <ul>
          {receipts.data.items.map((r) => (
            <li key={r.receipt.receipt.voucherHash}>
              {formatUnits(BigInt(r.receipt.receipt.amount), 6)} USDC ·{" "}
              {r.commitment ? (
                <Link href={routes.dispute(r.commitment.settlementId)}>
                  View payment and disputes ↗
                </Link>
              ) : (
                "Awaiting automatic settlement"
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function HostedDisputeActions({
  id,
  amount,
  resolved,
  proposal,
  negotiated,
}: {
  id: string;
  amount: string;
  resolved: boolean;
  proposal?: NegotiationState["proposal"];
  negotiated: boolean;
}) {
  const { signedIn, request, sessionAddress, revision, refresh } = useApi(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const managed = useQuery({
    queryKey: ["hosted-dispute-owner", id, sessionAddress, revision],
    enabled: signedIn,
    retry: false,
    queryFn: () =>
      request<{ service: Service | null }>(
        "/disputes/" + id + "/managed-provider",
        undefined,
        true,
      ),
  });
  const service = managed.data?.service;
  if (!service) return null;
  async function act(input: Record<string, unknown>, reason?: string) {
    setBusy(true);
    setError("");
    try {
      if (reason) {
        const saved = await request<{ evidenceHash: Hex }>(
          "/disputes/" + id + "/evidence",
          { method: "POST", body: JSON.stringify({ content: reason }) },
          true,
        );
        input.evidenceHash = saved.evidenceHash;
      }
      await request(
        "/disputes/" + id + "/managed-provider",
        { method: "POST", body: JSON.stringify(input) },
        true,
      );
      refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not submit provider action",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Card>
        <h2>Your hosted provider’s response</h2>
        <p>
          You control {service.name}. These actions are signed by its
          server-held provider key, not your connected wallet. They affect only
          this payment’s disputed funds.
        </p>
        {resolved ? (
          <p>This claim is already resolved.</p>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void act({ action: "accept" })}
            >
              Accept the claim and refund the disputed amount
            </Button>
            {negotiated &&
              proposal &&
              proposal.hash !== "0x" + "00".repeat(32) &&
              proposal.proposer.toLowerCase() !==
                service.provider.toLowerCase() && (
                <div className="workspace-disclosure">
                  <p>
                    Current proposal: refund{" "}
                    {formatUnits(BigInt(proposal.refund), 6)} USDC; release{" "}
                    {formatUnits(BigInt(amount) - BigInt(proposal.refund), 6)}{" "}
                    USDC of disputed principal to you. Bond:{" "}
                    {proposal.returnBond || BigInt(proposal.refund) > 0n
                      ? "return to claimant"
                      : "forfeit to protocol"}
                    .
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act({ action: "agree", proposalHash: proposal.hash })
                    }
                  >
                    Agree to this exact proposal
                  </Button>
                </div>
              )}
            <form
              className="live-form"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const action = String(f.get("action"));
                try {
                  const refund = parseUnits(String(f.get("refund") || "0"), 6);
                  if (refund < 0n || refund > BigInt(amount))
                    throw Error("Refund must be within the disputed principal");
                  void act(
                    {
                      action,
                      refund: refund.toString(),
                      returnBond: f.get("bond") === "on",
                    },
                    String(f.get("reason")),
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Invalid refund");
                }
              }}
            >
              <label className="live-field">
                <span>Provider action</span>
                <select name="action">
                  {negotiated && (
                    <option value="propose">Propose a partial refund</option>
                  )}
                  <option value="respond">Respond with evidence</option>
                  {negotiated && (
                    <option value="escalate">
                      Escalate after negotiation ends
                    </option>
                  )}
                </select>
              </label>
              {negotiated && (
                <label className="live-field">
                  <span>Proposed refund (USDC)</span>
                  <input name="refund" defaultValue="0" />
                </label>
              )}
              <label className="live-field">
                <span>Reason / supporting evidence</span>
                <textarea name="reason" required maxLength={4000} />
              </label>
              <label className="live-check">
                <input name="bond" type="checkbox" defaultChecked />
                Return the claimant’s bond if this proposal is accepted
              </label>
              <Button disabled={busy}>
                {busy ? "Waiting for confirmation…" : "Submit provider action"}
              </Button>
            </form>
            <p className="field-help">
              Contract deadlines still apply. A late proposal, early escalation
              or repeated response will be rejected on-chain.
            </p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </Card>
      <DisputeAssistant id={id} />
    </>
  );
}
