"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import {
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import { negotiationAbi } from "@sluice/sdk";
import { useApi, ApiSignIn } from "./api-session";
import { Button, Card, Callout } from "./ui";
import { AddressChip } from "./primitives";
import { siteConfig, explorerTransaction } from "../lib/site-config";
type Terms = {
  mode: string;
  vault: Address;
  termsHash: Hex;
  accepted: boolean;
  arbiter: Address;
  bond: string;
  cap: string;
  notice: string;
};
export function ArbitrationConsent({
  wallet,
  provider,
  owner,
}: {
  wallet: string;
  provider: string;
  owner: boolean;
}) {
  const { request, revision, refresh, config } = useApi(),
    { data: signer } = useWalletClient(),
    client = usePublicClient(),
    [agree, setAgree] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hash, setHash] = useState<Hex>();
  const terms = useQuery({
    queryKey: ["arbitration-consent", wallet, provider, revision],
    enabled: !!provider,
    retry: false,
    queryFn: () =>
      request<Terms>(
        "/wallets/" +
          wallet +
          "/arbitration?provider=" +
          provider +
          "&token=" +
          siteConfig.usdc,
      ),
  });
  if (terms.isLoading)
    return <p role="status">Checking this wallet’s dispute rules…</p>;
  if (terms.error)
    return (
      <Callout title="Could not load arbitration terms" tone="warn">
        {terms.error.message}
      </Callout>
    );
  if (!terms.data || terms.data.mode !== "negotiation")
    return (
      <p className="field-help">
        Legacy wallet: existing dispute rules still apply. The new 30-minute
        negotiation rules require a wallet from the negotiated factory.
      </p>
    );
  const t = terms.data;
  return (
    <Card>
      <h2>Review the payment’s dispute rules</h2>
      <dl className="readable-facts">
        <div>
          <dt>Negotiation</dt>
          <dd>30 minutes from claim opening</dd>
        </div>
        <div>
          <dt>Last-resort arbitration</dt>
          <dd>24 hours after negotiation ends</dd>
        </div>
        <div>
          <dt>Claim limit per settlement</dt>
          <dd>{formatUnits(BigInt(t.cap), 6)} USDC</dd>
        </div>
        <div>
          <dt>Claim bond</dt>
          <dd>{formatUnits(BigInt(t.bond), 6)} USDC</dd>
        </div>
        <div>
          <dt>Provider silence / final timeout</dt>
          <dd>Refund disputed principal + return bond</dd>
        </div>
      </dl>
      <p className="field-help">
        Only the disputed amount is protected up to the claim limit above.
        Undisputed funds can release after the provider’s original hold. The
        arbiter can award either party the disputed funds; if the agent receives
        no refund, its bond may be forfeited to the protocol.
      </p>
      <p>
        Last-resort arbiter: <AddressChip address={t.arbiter} />
      </p>
      <p className="field-help">
        {t.notice} Changes to these terms invalidate the current consent and
        block new held settlements until you review them again.
      </p>
      {t.accepted ? (
        <span className="badge badge-success">
          Current terms accepted on-chain
        </span>
      ) : owner ? (
        <>
          <label className="live-check">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            I accept these terms, the named arbiter and the timeout refund rule.
          </label>
          <Button
            disabled={!agree || busy || !signer || !client}
            onClick={() => {
              setBusy(true);
              setError("");
              void (async () => {
                if (!signer?.account || !client || !config)
                  throw Error("Connect your owner wallet");
                if ((await signer.getChainId()) !== config.chainId)
                  throw Error("Switch to Arc Testnet");
                const simulated = await client.simulateContract({
                  address: t.vault,
                  abi: negotiationAbi,
                  functionName: "acceptArbitrationTerms",
                  args: [wallet, provider, siteConfig.usdc, t.termsHash],
                  account: signer.account,
                });
                const tx = await signer.writeContract({
                  ...simulated.request,
                  account: signer.account,
                  chain: signer.chain,
                });
                setHash(tx);
                if (
                  (await client.waitForTransactionReceipt({ hash: tx }))
                    .status !== "success"
                )
                  throw Error("Consent transaction reverted");
                setAgree(false);
                refresh();
              })()
                .catch((e) =>
                  setError(
                    e instanceof Error
                      ? e.message.split("\n")[0]
                      : "Could not accept terms",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Waiting for confirmation…" : "Accept terms on-chain"}
          </Button>
        </>
      ) : (
        <p>Only this wallet’s current owner can accept these terms.</p>
      )}
      {error && (
        <p role="alert" className="live-error">
          {error}
        </p>
      )}
      {hash && (
        <a
          className="text-link"
          href={explorerTransaction(hash)}
          target="_blank"
          rel="noopener noreferrer"
        >
          View consent transaction
        </a>
      )}
    </Card>
  );
}
export type NegotiationState = {
  proposal: {
    hash: Hex;
    refund: string;
    returnBond: boolean;
    proposer: Address;
    agentOwner: Address;
    rationaleHash: Hex;
    revision: string;
  };
  escalated: boolean;
  decisionRationale: Hex;
};
type Execute = (action: () => Promise<void>) => Promise<void>;
type Write = (
  address: Address,
  abi: Abi,
  name: string,
  args: readonly unknown[],
) => Promise<unknown>;
export function NegotiationActions({
  id,
  vault,
  provider,
  amount,
  token,
  owner,
  deadline,
  arbiterDeadline,
  arbiter,
  responded,
  resolved,
  now,
  state,
  execute,
  write,
  busy,
}: {
  id: Hex;
  vault: Address;
  provider: Address;
  amount: string;
  token: Address;
  owner: boolean;
  deadline: string;
  arbiterDeadline: string;
  arbiter: Address;
  responded: boolean;
  resolved: boolean;
  now: number;
  state?: NegotiationState;
  execute: Execute;
  write: Write;
  busy: boolean;
}) {
  const { address } = useAccount(),
    { request, signedIn } = useApi(),
    [reason, setReason] = useState("");
  const providerParty = address?.toLowerCase() === provider.toLowerCase(),
    party = owner || providerParty,
    inNegotiation = now < Number(deadline),
    isUsdc = token.toLowerCase() === siteConfig.usdc.toLowerCase();
  const units = (v: string) => (isUsdc ? parseUnits(v, 6) : BigInt(v)),
    display = (v: string) =>
      isUsdc ? formatUnits(BigInt(v), 6) + " USDC" : v + " token units";
  async function reasonHash() {
    if (!reason.trim()) throw Error("Explain the proposal or decision");
    const saved = await request<{ evidenceHash: Hex }>(
      "/disputes/" + id + "/evidence",
      { method: "POST", body: JSON.stringify({ content: reason }) },
      true,
    );
    return saved.evidenceHash;
  }
  if (resolved)
    return (
      <Card>
        <h2>Resolution completed</h2>
        <p>
          This claim has been finalized on-chain. Its result cannot be changed
          by a new proposal.
        </p>
      </Card>
    );
  const proposal = state?.proposal,
    hasProposal = !!proposal && proposal.hash !== "0x" + "00".repeat(32);
  return (
    <Card>
      <h2>
        {inNegotiation
          ? "Agree a resolution together"
          : state?.escalated
            ? "Last-resort arbitration"
            : "Negotiation has ended"}
      </h2>
      <p className="muted small">
        Two parties can settle immediately during negotiation. The agent’s
        report is optional and never authorizes a payout. Arbitration requires
        an explicit escalation after negotiation.
      </p>
      <dl className="readable-facts">
        <div>
          <dt>Negotiation ends</dt>
          <dd>{new Date(Number(deadline) * 1000).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Final arbitration deadline</dt>
          <dd>{new Date(Number(arbiterDeadline) * 1000).toLocaleString()}</dd>
        </div>
      </dl>
      {hasProposal && (
        <div className="workspace-disclosure">
          <strong>Current proposal</strong>
          <p>
            Refund {display(proposal.refund)} to the agent; release{" "}
            {display(String(BigInt(amount) - BigInt(proposal.refund)))} of the
            disputed principal to the provider.
          </p>
          <p className="field-help">
            Bond:{" "}
            {proposal.returnBond || BigInt(proposal.refund) > 0n
              ? "Return to claimant"
              : "Forfeit to protocol if the agent receives no refund"}
            . Proposal revision {proposal.revision}. Its reason is available in
            private evidence below.
          </p>
          {inNegotiation &&
            party &&
            proposal.proposer.toLowerCase() !== address?.toLowerCase() && (
              <Button
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    await write(vault, negotiationAbi, "acceptResolution", [
                      id,
                      proposal.hash,
                    ]);
                  })
                }
              >
                Agree to this exact proposal
              </Button>
            )}
        </div>
      )}
      {party && inNegotiation && (
        <form
          className="live-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void execute(async () => {
              const refund = units(String(form.get("refund")));
              if (refund < 0n || refund > BigInt(amount))
                throw Error("Refund must be within the disputed principal");
              await write(vault, negotiationAbi, "proposeResolution", [
                id,
                refund,
                form.get("returnBond") === "on",
                await reasonHash(),
              ]);
            });
          }}
        >
          <label className="live-field">
            <span>
              Proposed refund ({isUsdc ? "USDC" : "token base units"})
            </span>
            <input name="refund" required />
          </label>
          <label className="live-field">
            <span>Explain your proposal (stored privately)</span>
            <textarea
              required
              maxLength={4000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="live-check">
            <input type="checkbox" name="returnBond" defaultChecked />
            Return the claimant’s bond
          </label>
          <Button disabled={busy || !signedIn}>
            Send proposal for the other party to accept
          </Button>
        </form>
      )}
      {party &&
        !inNegotiation &&
        responded &&
        !state?.escalated &&
        now < Number(arbiterDeadline) && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                await write(vault, negotiationAbi, "escalateDispute", [id]);
              })
            }
          >
            Escalate to the accepted arbiter
          </Button>
        )}
      {!inNegotiation && !responded && (
        <p>
          The provider did not respond. The timeout refund action below is now
          available.
        </p>
      )}
      {address?.toLowerCase() === arbiter.toLowerCase() &&
        state?.escalated &&
        now < Number(arbiterDeadline) && (
          <form
            className="live-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void execute(async () => {
                const refund = units(String(form.get("refund")));
                if (refund < 0n || refund > BigInt(amount))
                  throw Error("Refund exceeds disputed principal");
                await write(vault, negotiationAbi, "resolveAfterEscalation", [
                  id,
                  refund,
                  BigInt(amount) - refund,
                  form.get("returnBond") === "on",
                  await reasonHash(),
                ]);
              });
            }}
          >
            <h3>Arbiter’s reasoned decision</h3>
            <label className="live-field">
              <span>Refund ({isUsdc ? "USDC" : "token base units"})</span>
              <input name="refund" required />
            </label>
            <label className="live-field">
              <span>Decision and supporting evidence</span>
              <textarea
                required
                maxLength={4000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="live-check">
              <input name="returnBond" type="checkbox" defaultChecked />
              Return bond
            </label>
            <Button disabled={busy || !signedIn}>
              Sign the final decision
            </Button>
          </form>
        )}
    </Card>
  );
}
export function DisputeAssistant({ id }: { id: string }) {
  const { signedIn, request, sessionAddress } = useApi(),
    [selected, setSelected] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [report, setReport] = useState<{
      summary: string;
      reasons: string[];
      missingEvidence: string[];
      refundBasisPoints: number | null;
      model: string;
      inputHash: string;
    }>();
  const config = useQuery({
    queryKey: ["dispute-ai-config", id, sessionAddress],
    enabled: signedIn,
    retry: false,
    queryFn: () =>
      request<{
        available: boolean;
        providerOrigin: string;
        model: string | null;
      }>("/disputes/" + id + "/analysis", undefined, true),
  });
  const evidence = useQuery({
    queryKey: ["dispute-ai-evidence", id, sessionAddress],
    enabled: signedIn,
    retry: false,
    queryFn: () =>
      request<{ items: { id: string; content: string }[] }>(
        "/disputes/" + id + "/evidence",
        undefined,
        true,
      ),
  });
  return (
    <Card>
      <h2>Agent-assisted review</h2>
      <ApiSignIn />
      {!signedIn ? (
        <p>Unlock your wallet session to analyze private evidence.</p>
      ) : config.isLoading ? (
        <p role="status">Checking the optional assistant…</p>
      ) : !config.data?.available ? (
        <p className="muted small">
          AI analysis is not configured or unavailable. Negotiation and contract
          deadlines work without AI; no generated recommendation is being shown.
        </p>
      ) : (
        <>
          <p className="field-help">
            Model: {config.data.model} at {config.data.providerOrigin}. The
            selected private evidence is sent to this service when you request
            analysis.
          </p>
          {evidence.data?.items.map((item) => (
            <label className="live-check" key={item.id}>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id),
                  )
                }
              />
              {item.content.slice(0, 120)}
            </label>
          ))}
          <label className="live-check">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            Send the selected evidence to the configured model for a non-binding
            recommendation.
          </label>
          <Button
            disabled={busy || !confirm || !selected.length}
            onClick={() => {
              setBusy(true);
              setError("");
              void request<typeof report>(
                "/disputes/" + id + "/analysis",
                {
                  method: "POST",
                  body: JSON.stringify({
                    confirmExternalProcessing: true,
                    evidenceIds: selected,
                  }),
                },
                true,
              )
                .then(setReport)
                .catch((e) =>
                  setError(e instanceof Error ? e.message : "Analysis failed"),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Analyzing evidence…" : "Ask the agent for a proposal"}
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {report && (
        <div className="workspace-disclosure">
          <strong>Non-binding proposal — review before acting</strong>
          <p>{report.summary}</p>
          <p>
            Suggested refund:{" "}
            {report.refundBasisPoints === null
              ? "Insufficient evidence"
              : report.refundBasisPoints / 100 + "% of disputed principal"}
          </p>
          <ul>
            {report.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          <p>
            Missing evidence:{" "}
            {report.missingEvidence.join("; ") || "None reported by the model"}
          </p>
          <p className="field-help">
            No decision has been signed and no funds have moved. The model may
            be wrong; both parties must review the evidence.
          </p>
        </div>
      )}
    </Card>
  );
}
