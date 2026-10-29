"use client";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi, ApiSignIn } from "./api-session";
import { Card, Button, ButtonLink, Callout } from "./ui";
import { CodeBlock } from "./primitives";
import { siteConfig } from "../lib/site-config";
type Profile = { name: string; purpose: string; updated_at: string };
export type AgentDetailsResponse = {
  profile: Profile | null;
  lastPayment: {
    timestamp: string;
    provider: string;
    amount: string;
    token: string;
    settled: boolean;
  } | null;
  agentRuntimeStatus: "unknown";
};
export function AgentProfile({
  wallet,
  isOwner,
}: {
  wallet: string;
  isOwner: boolean;
}) {
  const { signedIn, sessionAddress, revision, request, refresh, config } =
    useApi();
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const details = useQuery({
    queryKey: ["agent-profile", wallet, sessionAddress, revision],
    enabled: isOwner && signedIn,
    retry: false,
    queryFn: () =>
      request<AgentDetailsResponse>(
        "/wallets/" + wallet + "/profile",
        undefined,
        true,
      ),
  });
  if (!isOwner) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await request(
        "/wallets/" + wallet + "/profile",
        {
          method: "POST",
          body: JSON.stringify({
            name: form.get("name"),
            purpose: form.get("purpose"),
          }),
        },
        true,
      );
      setSaved(true);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the profile");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="live-grid">
      <Card>
        <div className="section-heading compact">
          <div>
            <h2>Your agent</h2>
            <p className="muted small">
              A private name and description for this payment wallet.
            </p>
          </div>
          <ApiSignIn />
        </div>
        {!signedIn ? (
          <p className="muted">
            Unlock your wallet session to save a name and view payment activity.
          </p>
        ) : details.isLoading ? (
          <p role="status">Loading your agent profile…</p>
        ) : (
          <>
            <form
              key={details.data?.profile?.updated_at || wallet}
              className="live-form"
              onSubmit={submit}
            >
              <label className="live-field">
                <span>Agent name</span>
                <input
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={details.data?.profile?.name || ""}
                  placeholder="e.g. Research assistant"
                />
              </label>
              <label className="live-field">
                <span>What does this agent do?</span>
                <textarea
                  name="purpose"
                  maxLength={500}
                  defaultValue={details.data?.profile?.purpose || ""}
                  placeholder="Describe the task you use this agent for."
                />
              </label>
              <Button disabled={saving}>
                {saving ? "Saving…" : "Save agent details"}
              </Button>
            </form>
            {details.error && (
              <Callout title="Profile storage unavailable" tone="warn">
                {details.error.message}
              </Callout>
            )}
            {error && (
              <p role="alert" className="live-error">
                {error}
              </p>
            )}
            {saved && (
              <p role="status" className="transaction-feedback">
                Agent details saved to your account.
              </p>
            )}
          </>
        )}
      </Card>
      <Card>
        <h2>Connect your existing agent</h2>
        <p className="muted small">
          This wallet does not run an AI agent. Add the SDK to the program you
          already use, with a separate agent signing key.
        </p>
        <dl className="readable-facts">
          <div>
            <dt>Runtime connection</dt>
            <dd>Not monitored</dd>
          </div>
          <div>
            <dt>Last signed payment receipt</dt>
            <dd>
              {!signedIn
                ? "Unlock receipts to check"
                : details.isLoading
                  ? "Checking…"
                  : details.error
                    ? "Unavailable"
                    : details.data?.lastPayment
                      ? new Date(
                          Number(details.data.lastPayment.timestamp) * 1000,
                        ).toLocaleString()
                      : "No receipt recorded"}
            </dd>
          </div>
        </dl>
        <ButtonLink href="/docs/quickstart/agent" variant="secondary">
          Connect with the SDK
        </ButtonLink>
        <details className="workspace-disclosure">
          <summary>Your wallet configuration</summary>
          <CodeBlock
            filename="agentpay-wallet.json"
            language="json"
            code={JSON.stringify(
              {
                chainId: config?.chainId,
                wallet,
                token: siteConfig.usdc,
                factories: config?.factories,
              },
              null,
              2,
            )}
          />
          <p className="field-help">
            Add your agent signer and allowlisted providers in the SDK. No
            private key belongs in this file or dashboard.
          </p>
        </details>
      </Card>
    </div>
  );
}
