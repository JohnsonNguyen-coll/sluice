"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import Link from "next/link";
import { formatUnits } from "viem";
import type { SignedReceipt } from "@sluice/sdk";
import { useApi, ApiSignIn } from "./api-session";
import { Card, Button, Callout, Stat } from "./ui";
import { shortAddress, siteConfig } from "../lib/site-config";
import { routes } from "../lib/routes";
type Entry = {
  receipt: SignedReceipt;
  verified: boolean;
  commitment?: { settlementId: string; transactionHash: string };
};
type Settlement = {
  amount: string;
  token: string;
  state: number;
  releaseAfter: string;
  undisputedReleased: string;
};
export function ReceiptRecords({
  wallet,
  provider = false,
}: {
  wallet?: string;
  provider?: boolean;
}) {
  const { signedIn, sessionAddress, revision, request } = useApi(),
    client = usePublicClient(),
    [offset, setOffset] = useState(0);
  const [selectedWallet, setSelectedWallet] = useState("");
  const ownedWallets = useQuery({
    queryKey: ["receipt-wallet-options", sessionAddress, revision],
    enabled: signedIn && !provider && !wallet,
    retry: false,
    queryFn: () =>
      request<{ items: { wallet: string }[]; total: number }>(
        "/wallets?owner=" + sessionAddress + "&limit=100",
      ),
  });
  const resolvedWallet =
    wallet ||
    (ownedWallets.data?.items.some((item) => item.wallet === selectedWallet)
      ? selectedWallet
      : ownedWallets.data?.items[0]?.wallet);
  const records = useQuery<{ items: Entry[] }>({
    queryKey: [
      "receipt-records",
      resolvedWallet,
      provider,
      sessionAddress,
      revision,
      offset,
    ],
    enabled: signedIn && (provider || !!resolvedWallet),
    queryFn: () =>
      request(
        "/receipts?limit=100&offset=" +
          offset +
          (resolvedWallet ? "&wallet=" + resolvedWallet : ""),
        undefined,
        true,
      ),
    retry: false,
  });
  const ids = [
    ...new Set(
      (records.data?.items || []).flatMap((item) =>
        item.commitment ? [item.commitment.settlementId] : [],
      ),
    ),
  ].slice(0, 25);
  const balances = useQuery({
    queryKey: ["provider-balances", ids, revision, sessionAddress],
    enabled: provider && signedIn && !!client && ids.length > 0,
    retry: false,
    queryFn: async () => {
      const now = (await client!.getBlock()).timestamp;
      let held = 0n,
        releasable = 0n;
      const rows = await Promise.all(
        ids.map(async (id) => {
          try {
            const { settlement: s } = await request<{ settlement: Settlement }>(
              "/settlements/" + id,
            );
            const active = s.state === 0 || s.state === 2;
            let ready = 0n;
            if (active && now >= BigInt(s.releaseAfter)) {
              if (s.state === 0) ready = BigInt(s.amount);
              else {
                const { dispute } = await request<{
                  dispute: { amount: string };
                }>("/disputes/" + id);
                ready =
                  BigInt(s.amount) -
                  BigInt(dispute.amount) -
                  BigInt(s.undisputedReleased);
              }
            }
            if (
              s.token.toLowerCase() === siteConfig.usdc.toLowerCase() &&
              active
            ) {
              held += BigInt(s.amount) - BigInt(s.undisputedReleased);
              releasable += ready;
            }
            return { id, settlement: s, ready };
          } catch {
            return { id, settlement: undefined, ready: 0n };
          }
        }),
      );
      return { held, releasable, rows };
    },
  });
  return (
    <>
      <Card>
        <div className="section-heading compact">
          <div>
            <h2>
              {provider ? "Payments & incoming funds" : "Your payment receipts"}
            </h2>
            <p className="muted small">
              Receipts are private. Verify wallet ownership to view the records
              available to your account.
            </p>
          </div>
          <ApiSignIn />
        </div>
        {signedIn && !wallet && !provider && ownedWallets.data?.items.length ? (
          <label className="live-field receipt-wallet-picker">
            <span>Payment wallet</span>
            <select
              value={resolvedWallet || ""}
              onChange={(event) => {
                setSelectedWallet(event.target.value);
                setOffset(0);
              }}
            >
              {ownedWallets.data.items.map((item) => (
                <option key={item.wallet} value={item.wallet}>
                  {shortAddress(item.wallet)}
                </option>
              ))}
            </select>
            <span className="field-help">
              Choose a wallet you created. For transferred wallets, open the
              wallet directly. Up to 100 creation records are available here.
            </span>
          </label>
        ) : null}
        {!signedIn ? (
          <p>
            Sign a free login message to view your receipts. This does not move
            funds or authorize a payment.
          </p>
        ) : !provider && !wallet && ownedWallets.isLoading ? (
          <p role="status">Finding your payment wallets…</p>
        ) : ownedWallets.error ? (
          <Callout title="Couldn’t load your wallets" tone="warn">
            {ownedWallets.error.message}
          </Callout>
        ) : !provider && !resolvedWallet ? (
          <p className="receipt-empty">
            No payment wallets found for this account.{" "}
            <Link href="/app/wallets">Open your wallets</Link> to create one or
            look up an existing address.
          </p>
        ) : records.isLoading ? (
          <p role="status">Loading signed receipts…</p>
        ) : records.error ? (
          <Callout tone="warn" title="Receipts unavailable">
            {records.error.message}
          </Callout>
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Amount</th>
                    <th>API response</th>
                    <th>Receipt</th>
                    <th>Payment details</th>
                  </tr>
                </thead>
                <tbody>
                  {records.data?.items.map((item) => (
                    <tr key={item.receipt.receipt.voucherHash}>
                      <td>
                        <code title={item.receipt.receipt.voucherHash}>
                          {new Date(
                            Number(item.receipt.receipt.timestamp) * 1000,
                          ).toLocaleString()}
                        </code>
                      </td>
                      <td>
                        {item.receipt.receipt.token.toLowerCase() ===
                        siteConfig.usdc.toLowerCase()
                          ? formatUnits(
                              BigInt(item.receipt.receipt.amount),
                              6,
                            ) + " USDC"
                          : item.receipt.receipt.amount + " token units"}
                      </td>
                      <td>
                        {item.receipt.receipt.status >= 200 &&
                        item.receipt.receipt.status < 300
                          ? "Successful"
                          : "Returned an error"}
                        <span className="muted small">
                          {" "}
                          · {item.receipt.receipt.status}
                        </span>
                      </td>
                      <td>
                        {item.verified ? "Signature verified" : "Unverified"}
                      </td>
                      <td>
                        {item.commitment ? (
                          <Link
                            href={routes.dispute(item.commitment.settlementId)}
                          >
                            View payment →
                          </Link>
                        ) : (
                          "Provider hasn’t collected yet"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!records.data?.items.length && (
              <p className="receipt-empty">
                No payment receipts yet. They appear after your connected agent
                makes a paid API call through a provider using Sluice.
              </p>
            )}
            <div className="live-actions">
              <Button
                variant="ghost"
                disabled={offset === 0}
                onClick={() => setOffset((v) => Math.max(0, v - 100))}
              >
                Newer records
              </Button>
              <Button
                variant="ghost"
                disabled={(records.data?.items.length || 0) < 100}
                onClick={() => setOffset((v) => v + 100)}
              >
                Older records
              </Button>
            </div>
          </>
        )}
      </Card>
      {provider && balances.data && (
        <>
          <div className="grid-three app-stats">
            <Stat
              label="Held USDC"
              hint="Within this page’s latest 25 stored batches"
            >
              {formatUnits(balances.data.held, 6)}
            </Stat>
            <Stat
              label="Releasable USDC"
              hint="Confirmed chain time · included in held balance"
            >
              {formatUnits(balances.data.releasable, 6)}
            </Stat>
          </div>
          <Card>
            <h2>Batch availability</h2>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Settlement</th>
                    <th>Vault state</th>
                    <th>Available now (token base units)</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.data.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link href={routes.dispute(row.id)}>
                          {shortAddress(row.id)}
                        </Link>
                      </td>
                      <td>
                        {row.settlement
                          ? [
                              "Held",
                              "Released",
                              "Disputed",
                              "Split",
                              "Refunded",
                            ][row.settlement.state]
                          : "No vault record"}
                      </td>
                      <td>{String(row.ready)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              USDC totals cover this page only. “No vault record” is not a claim
              that a payment was verified or released.
            </p>
          </Card>
        </>
      )}
    </>
  );
}

export function EvidenceRecords({ id }: { id: string }) {
  const { signedIn, sessionAddress, revision, request } = useApi();
  const evidence = useQuery<{
    items: {
      id: string;
      author: string;
      content: string;
      created_at: string;
    }[];
  }>({
    queryKey: ["private-evidence", id, sessionAddress, revision],
    enabled: signedIn,
    queryFn: () => request("/disputes/" + id + "/evidence", undefined, true),
    retry: false,
  });
  if (!signedIn) return null;
  return (
    <Card>
      <h2>Private evidence</h2>
      {evidence.isLoading && <p role="status">Loading evidence…</p>}
      {evidence.error && (
        <Callout title="Evidence access" tone="warn">
          {evidence.error.message}
        </Callout>
      )}
      {evidence.data?.items.map((item) => (
        <section key={item.id}>
          <p className="small muted">
            {shortAddress(item.author)} ·{" "}
            {new Date(item.created_at).toLocaleString()}
          </p>
          <code>{item.id}</code>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {item.content}
          </pre>
        </section>
      ))}
      {evidence.data?.items.length === 0 && (
        <p>No private evidence has been uploaded.</p>
      )}
    </Card>
  );
}
