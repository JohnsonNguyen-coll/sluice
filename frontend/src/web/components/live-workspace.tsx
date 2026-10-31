"use client";
import { useState, useEffect, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import {
  decodeEventLog,
  formatUnits,
  parseUnits,
  isAddress,
  isHex,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import {
  walletAbis,
  factoryAbis,
  agentAbi,
  providerAbi,
  vaultAbi,
  negotiationAbi,
  type Version,
  type SignedReceipt,
} from "@sluice/sdk";
import { useApi, ApiConnection, ApiSignIn } from "./api-session";
import { ReceiptRecords, EvidenceRecords } from "./receipt-records";
import { WalletHub } from "./wallet-hub";
import { AgentProfile } from "./agent-profile";
import {ArbitrationConsent,NegotiationActions,DisputeAssistant,type NegotiationState} from "./negotiation";
import { ProviderListings } from "./api-directory";
import {ManagedServices,HostedDisputeActions} from "./managed-services";
import { WalletControl } from "./wallet-control";
import {
  Button,
  ButtonLink,
  Card,
  Callout,
  EmptyState,
  Stat,
  Timeline,
} from "./ui";
import { CodeBlock, AddressChip } from "./primitives";
import { routes, type RouteId } from "../lib/routes";
import {
  siteConfig,
  explorerTransaction,
  shortAddress,
} from "../lib/site-config";
type WalletState = {
  address: Address;
  version: Version;
  owner: Address;
  agentSigner: Address;
  paused: boolean;
};
type LogRecord = {
  eventName: string;
  transactionHash: Hex;
  blockNumber: string;
  args: Record<string, string>;
};
type Settlement = {
  wallet: Address;
  provider: Address;
  token: Address;
  amount: string;
  heldAt: string;
  releaseAfter: string;
  state: number;
  payoutAddress: Address;
  arbiter: Address;
  undisputedReleased: string;
};
type Dispute = {
  openedBy: Address;
  amount: string;
  bond: string;
  openedAt: string;
  responseDeadline: string;
  arbiterDeadline: string;
  providerResponded: boolean;
  resolved: boolean;
};
const zero = "0x0000000000000000000000000000000000000000" as Address;
const erc20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
function Field({
  label,
  name,
  defaultValue = "",
  type = "text",
  required = true,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="live-field">
      <span>{label}</span>
      <input
        name={name}
        defaultValue={defaultValue}
        type={type}
        required={required}
        autoComplete="off"
      />
    </label>
  );
}
function data(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}
function addr(value: FormDataEntryValue | null): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw Error("Enter a valid wallet address");
  return value;
}
function h32(value: string): Hex {
  if (!isHex(value) || value.length !== 66) throw Error("Enter a 32-byte hash");
  return value;
}
const text = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v), 2);
const timestamp = (value: string | undefined) =>
  value && value !== "0"
    ? new Date(Number(value) * 1000).toLocaleString()
    : "—";
function useRead<T>(path: string | null) {
  const { request, revision, sessionAddress } = useApi();
  const query = useQuery<T>({
    queryKey: ["sluice-api", path, revision, sessionAddress || "public"],
    queryFn: () => request<T>(path!),
    enabled: !!path,
    retry: false,
  });
  return {
    value: query.data,
    error: query.error?.message,
    loading: !!path && query.isLoading,
  };
}
function ReadStatus({ loading, error }: { loading: boolean; error?: string }) {
  return loading ? (
    <p role="status">Loading confirmed chain data…</p>
  ) : error ? (
    <Callout title="Record unavailable" tone="warn">
      {error}
    </Callout>
  ) : null;
}
function useTransaction() {
  const client = usePublicClient(),
    { data: wallet } = useWalletClient(),
    { config, refresh } = useApi();
  const [phase, setPhase] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hash, setHash] = useState<Hex>();
  async function execute(action: () => Promise<void>) {
    setBusy(true);
    setPhase("Checking this action against the contract…");
    setError("");
    setHash(undefined);
    try {
      await action();
      setPhase("Confirmed on Arc Testnet.");
      refresh();
    } catch (error) {
      setPhase("");
      setError(
        error instanceof Error
          ? error.message.split("\n")[0]
          : "Transaction failed",
      );
    } finally {
      setBusy(false);
    }
  }
  async function write(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ) {
    if (!client || !wallet?.account || !config)
      throw Error("Connect your wallet first");
    if ((await wallet.getChainId()) !== config.chainId)
      throw Error("Switch your wallet to the configured network");
    const { request } = await client.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: wallet.account,
    });
    setPhase("Confirm this transaction in your wallet.");
    const tx = await wallet.writeContract({
      ...request,
      account: wallet.account,
      chain: wallet.chain,
    });
    setHash(tx);
    setPhase("Transaction sent. Waiting for network confirmation…");
    const receipt = await client.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw Error("Transaction reverted");
    return receipt;
  }
  return {
    busy,
    execute,
    write,
    status: (
      <div aria-live="polite">
        {phase && (
          <p className="transaction-feedback" role="status">
            {phase}
          </p>
        )}
        {error && (
          <p role="alert" className="live-error">
            {error}
          </p>
        )}
        {hash && (
          <a
            className="text-link"
            target="_blank"
            rel="noopener noreferrer"
            href={explorerTransaction(hash)}
          >
            View transaction
          </a>
        )}
      </div>
    ),
  };
}
function CreateWallet() {
  const { config } = useApi(),
    { address } = useAccount(),
    router = useRouter(),
    tx = useTransaction();
  const factory = config?.factories.find(
    (candidate) => candidate.version === 3 && !!candidate.negotiationVault,
  );
  return (
    <Card className="create-payment-wallet">
      <div className="form-step-label">STEP 1 OF 3 · CREATE A WALLET</div>
      <h2>A payment wallet you control</h2>
      <p>
        Keep ownership in your connected wallet. Enter the agent’s public
        signing address. This creates a payment account, not an AI agent. You
        can fund it and connect your agent after creation.
      </p>
      <div className="live-actions" aria-label="Payment wallet features">
        <span className="badge">Multi-token support</span>
        <span className="badge">Spending controls</span>
        <span className="badge">Signed receipts</span>
        <span className="badge">Disputes &amp; refunds</span>
      </div>
      <p className="field-help">
        Pay with tokens enabled on this network, set spending limits and keep
        signed receipts. Request refunds under the provider’s agreed dispute terms.
      </p>
      <form
        className="live-form"
        onSubmit={(event) => {
          const form = data(event);
          void tx.execute(async () => {
            if (!address || !config) throw Error("Connect a wallet first");
            if (!factory)
              throw Error("Payment wallet creation is currently unavailable");
            const version = factory.version;
            const window = Number(form.get("window"));
            if (!Number.isInteger(window) || window < 600)
              throw Error("Settlement grace must be at least 600 seconds");
            const receipt = await tx.write(
              factory.address,
              factoryAbis[version],
              "createWallet",
              [
                address,
                addr(form.get("signer")),
                window,
                keccak256(toHex(crypto.randomUUID())),
              ],
            );
            for (const log of receipt.logs) {
              try {
                const result = decodeEventLog({
                  abi: factoryAbis[version],
                  ...log,
                }) as unknown as {
                  eventName: string;
                  args: { wallet: Address };
                };
                if (result.eventName === "WalletCreated")
                  router.push(routes.wallet(result.args.wallet));
              } catch {}
            }
          });
        }}
      >
        <Field label="Your agent’s public signing address" name="signer" />
        <p className="field-help">
          Paste the public address used by your agent’s signing key. Never paste
          a private key.{" "}
          <Link href="/docs/quickstart/agent">How to connect an agent ↗</Link>
        </p>
        <details className="workspace-disclosure">
          <summary>Advanced wallet settings</summary>
          <Field
            label="Time to finish pending payments (seconds)"
            name="window"
            defaultValue="3600"
            type="number"
          />
          <p className="field-help">
            Existing payment authorizations remain valid during this period when
            you pause, change keys or lower a budget. Minimum: 10 minutes.
          </p>
        </details>
        {!address && (
          <p className="field-help">
            Connect your wallet using the button in the navigation to continue.
          </p>
        )}
        {config && !factory && (
          <p role="alert" className="live-error">Payment wallet creation is currently unavailable. Please try again later.</p>
        )}
        <Button disabled={tx.busy || !address || !factory}>
          {tx.busy ? "Creating your wallet…" : "Create payment wallet"}
        </Button>
      </form>
      {tx.status}
    </Card>
  );
}
function WalletDetail({
  record,
  section,
}: {
  record: string;
  section: RouteId;
}) {
  const state = useRead<WalletState>("/wallets/" + encodeURIComponent(record)),
    { address } = useAccount(),
    client = usePublicClient(),
    { revision, config } = useApi(),
    tx = useTransaction();
  const searchParams = useSearchParams();
  const selectedProvider = searchParams.get("provider") || "";
  const [budgetProvider, setBudgetProvider] = useState(
    isAddress(selectedProvider) ? selectedProvider : "",
  );
  const budget = useRead<{
    budget: [string, string];
    settled: string;
    nonce: string;
  }>(
    isAddress(budgetProvider)
      ? "/wallets/" +
          record +
          "/budgets?provider=" +
          budgetProvider +
          "&token=" +
          siteConfig.usdc
      : null,
  );
  const activity = useRead<{ items: LogRecord[] }>(
    section === "wallet-activity" ? "/wallets/" + record + "/activity" : null,
  );
  const balanceRead = useQuery({
    queryKey: ["payment-wallet-balance", record, revision],
    enabled: !!client && isAddress(record),
    retry: false,
    queryFn: async () =>
      formatUnits(
        await client!.readContract({
          address: siteConfig.usdc as Address,
          abi: erc20,
          functionName: "balanceOf",
          args: [record as Address],
        }),
        6,
      ),
  });
  const balance = balanceRead.data;
  const dailyLimitRead = useQuery({
    queryKey: ["wallet-daily-limit", record, state.value?.version, revision],
    enabled: !!client && !!state.value,
    retry: false,
    queryFn: async () =>
      client!.readContract({
        address: record as Address,
        abi: walletAbis[state.value!.version],
        functionName:
          state.value!.version === 1 ? "dailyLimit" : "dailyLimitUsdE6",
      }) as Promise<bigint>,
  });
  const w = state.value,
    isOwner = !!w && address?.toLowerCase() === w.owner.toLowerCase();
  return (
    <>
      <ReadStatus {...state} />
      {balanceRead.error && (
        <Callout title="Balance unavailable" tone="warn">
          We couldn’t read this wallet’s USDC balance.{" "}
          <Button variant="ghost" onClick={() => void balanceRead.refetch()}>
            Retry balance
          </Button>
        </Callout>
      )}
      {w && (
        <>
          <div className="grid-three app-stats">
            <Stat label="USDC balance" hint="Live on-chain balance">
              {balance ?? "—"}
            </Stat>
            <Stat label="Payment wallet" hint="Owner-controlled funds">
              {w.paused ? "Paused" : "Active"}
            </Stat>
            <Stat label="Agent signer" hint="Separate from wallet ownership">
              <span className="live-small-value">
                {shortAddress(w.agentSigner)}
              </span>
            </Stat>
          </div>
          {(section === "wallet" || section === "wallet-settings") && (
            <AgentProfile wallet={w.address} isOwner={isOwner} />
          )}
          {section === "wallet-settings" && (
            <Card>
              <h2>Wallet owner</h2>
              <AddressChip address={w.owner} />
            </Card>
          )}
          {section === "wallet" && (
            <div className="wallet-next-actions">
              <div>
                <strong>Next: set a spending limit</strong>
                <p>
                  Your agent needs an allowance for each API provider before it
                  can pay.
                </p>
              </div>
              <ButtonLink
                href={routes.wallet(w.address, "budgets")}
                variant="secondary"
              >
                Set spending limits
              </ButtonLink>
              <ButtonLink href="/docs/quickstart/agent" variant="ghost">
                Connect your agent
              </ButtonLink>
            </div>
          )}
          {section === "wallet" && <ReceiptRecords wallet={w.address} />}
          {section === "wallet-activity" ? (
            <EventTable logs={activity.value?.items || []} state={activity} />
          ) : (
            <>
              {section === "wallet-budgets" && (
                <Card>
                  <h2>Check a provider’s spending limit</h2>
                  <p className="muted small">
                    A provider is the API service your agent pays. Enter its
                    payment address to see your allowance and confirmed
                    spending.
                  </p>
                  <label className="live-field">
                    <span>Provider address to inspect</span>
                    <input
                      value={budgetProvider}
                      onChange={(e) => setBudgetProvider(e.target.value)}
                    />
                  </label>
                  <ReadStatus {...budget} />
                  {budget.value !== undefined && (
                    <div>
                      <dl className="readable-facts">
                        <div>
                          <dt>Total allowance</dt>
                          <dd>
                            {formatUnits(BigInt(budget.value.budget[0]), 6)}{" "}
                            USDC
                          </dd>
                        </div>
                        <div>
                          <dt>Already collected</dt>
                          <dd>
                            {formatUnits(BigInt(budget.value.settled), 6)} USDC
                          </dd>
                        </div>
                        <div>
                          <dt>Per-collection limit</dt>
                          <dd>
                            {budget.value.budget[1] === "0"
                              ? "No cap"
                              : formatUnits(BigInt(budget.value.budget[1]), 6) +
                                " USDC"}
                          </dd>
                        </div>
                      </dl>
                      <details className="workspace-disclosure">
                        <summary>Technical details</summary>
                        <CodeBlock
                          code={text(budget.value)}
                          language="json"
                          filename="On-chain budget"
                        />
                      </details>
                    </div>
                  )}
                </Card>
              )}
              {section === "wallet-budgets" && isAddress(budgetProvider) && <ArbitrationConsent key={w.address+budgetProvider+address} wallet={w.address} provider={budgetProvider} owner={isOwner}/>}
              {isOwner && (
                <div className="live-grid">
                  {section === "wallet" && (
                    <Card>
                      <h2>Add money to this wallet</h2>
                      <p className="muted small">
                        Transfer testnet USDC from your connected wallet. You’ll
                        confirm an allowance, then the deposit.
                      </p>
                      <form
                        className="live-form"
                        onSubmit={(event) => {
                          const form = data(event);
                          void tx.execute(async () => {
                            const amount = parseUnits(
                              String(form.get("amount")),
                              6,
                            );
                            if (amount <= 0n)
                              throw Error("Amount must be positive");
                            await tx.write(
                              siteConfig.usdc as Address,
                              erc20,
                              "approve",
                              [w.address, amount],
                            );
                            await tx.write(
                              w.address,
                              walletAbis[w.version],
                              "deposit",
                              w.version === 1
                                ? [amount]
                                : [siteConfig.usdc, amount],
                            );
                          });
                        }}
                      >
                        <Field label="Amount (USDC)" name="amount" />
                        <p className="muted small">
                          Your wallet will approve USDC, then deposit it into
                          the agent wallet.
                        </p>
                        <Button disabled={tx.busy}>Approve and deposit</Button>
                      </form>
                    </Card>
                  )}
                  {section === "wallet" && (
                    <Card>
                      <h2>Withdraw available USDC</h2>
                      <p className="muted small">
                        Return unreserved funds to your connected owner wallet.
                        Provider allowances and pending-payment protections can
                        restrict the available amount.
                      </p>
                      <form
                        className="live-form"
                        onSubmit={(event) => {
                          const form = data(event);
                          void tx.execute(async () => {
                            const amount = parseUnits(
                              String(form.get("withdrawAmount")),
                              6,
                            );
                            if (amount <= 0n)
                              throw Error("Enter an amount greater than zero");
                            if (!client)
                              throw Error("Network connection unavailable");
                            const free = (await client.readContract({
                              address: w.address,
                              abi: walletAbis[w.version],
                              functionName: "freeBalance",
                              args: w.version === 1 ? [] : [siteConfig.usdc],
                            })) as bigint;
                            if (amount > free)
                              throw Error(
                                "Only " +
                                  formatUnits(free, 6) +
                                  " USDC is available to withdraw. Lower reserved provider budgets and wait for pending-payment protections if needed.",
                              );
                            await tx.write(
                              w.address,
                              walletAbis[w.version],
                              "withdraw",
                              w.version === 1
                                ? [amount]
                                : [siteConfig.usdc, amount],
                            );
                          });
                        }}
                      >
                        <Field
                          label="Amount to withdraw (USDC)"
                          name="withdrawAmount"
                        />
                        <p className="field-help">
                          Destination: your owner wallet {shortAddress(w.owner)}
                          . The contract checks availability and any pause
                          cooldown before withdrawal.
                        </p>
                        <Button variant="secondary" disabled={tx.busy}>
                          Withdraw to my wallet
                        </Button>
                      </form>
                    </Card>
                  )}
                  {section === "wallet-budgets" && (
                    <Card>
                      <h2>Daily spending limit</h2>
                      <p className="muted small">
                        Limit the total amount providers can collect in a UTC
                        day. This is checked when payments settle, not when your
                        agent makes a call.
                      </p>
                      <p className="field-help">
                        Current limit:{" "}
                        {dailyLimitRead.data === undefined
                          ? "Unavailable"
                          : dailyLimitRead.data === 0n
                            ? "No daily limit"
                            : formatUnits(dailyLimitRead.data, 6) +
                              (w.version === 1 ? " USDC" : " USD equivalent")}
                      </p>
                      <form
                        className="live-form"
                        onSubmit={(event) => {
                          const form = data(event);
                          void tx.execute(async () => {
                            const limit = parseUnits(
                              String(form.get("dailyLimit")),
                              6,
                            );
                            if (limit < 0n)
                              throw Error("Daily limit cannot be negative");
                            await tx.write(
                              w.address,
                              walletAbis[w.version],
                              "setDailyLimit",
                              [limit],
                            );
                          });
                        }}
                      >
                        <Field
                          label={
                            w.version === 1
                              ? "Daily limit (USDC)"
                              : "Daily limit (USD equivalent)"
                          }
                          name="dailyLimit"
                        />
                        <p className="field-help">
                          Enter 0 for no daily limit. Multi-token wallets use
                          the token rates configured on-chain.
                        </p>
                        <Button disabled={tx.busy}>Save daily limit</Button>
                      </form>
                    </Card>
                  )}
                  {section === "wallet-budgets" && (
                    <Card>
                      <h2>Set spending limits</h2>
                      <p className="muted small">
                        Choose how much this API provider can collect from your
                        agent wallet.
                      </p>
                      <form
                        className="live-form"
                        onSubmit={(event) => {
                          const form = data(event);
                          void tx.execute(async () => {
                            const provider = addr(form.get("provider")),
                              action = String(
                                form.get("action") || "setProviderBudget",
                              );
                            if (action === "executeBudgetDecrease") {
                              await tx.write(
                                w.address,
                                walletAbis[w.version],
                                action,
                                w.version === 1
                                  ? [provider]
                                  : [provider, siteConfig.usdc],
                              );
                            } else {
                              const total = parseUnits(
                                  String(form.get("total")),
                                  6,
                                ),
                                cap = parseUnits(String(form.get("cap")), 6);
                              await tx.write(
                                w.address,
                                walletAbis[w.version],
                                action,
                                w.version === 1
                                  ? [provider, total, cap]
                                  : [provider, siteConfig.usdc, total, cap],
                              );
                            }
                          });
                        }}
                      >
                        <label className="live-field">
                          <span>Budget action</span>
                          <select name="action">
                            <option value="setProviderBudget">
                              Increase budget
                            </option>
                            <option value="requestBudgetDecrease">
                              Request a decrease
                            </option>
                            <option value="executeBudgetDecrease">
                              Apply matured decrease
                            </option>
                          </select>
                        </label>
                        <Field
                          label="Provider address"
                          name="provider"
                          defaultValue={budgetProvider}
                        />
                        <Field
                          label="Total allowance for this provider (USDC)"
                          name="total"
                          defaultValue="0"
                        />
                        <Field
                          label="Maximum per collection (USDC; 0 = no cap)"
                          name="cap"
                          defaultValue="1"
                        />
                        <p className="muted small">
                          The per-collection cap limits each provider
                          settlement, which may contain several API calls.
                          Decreases wait for the settlement grace period.
                          Applying a matured decrease uses the provider address
                          only.
                        </p>
                        <Button disabled={tx.busy}>Submit budget action</Button>
                      </form>
                    </Card>
                  )}
                  {section === "wallet-settings" && (
                    <Card>
                      <h2>Payment controls</h2>
                      <p className="muted small">
                        Pause new payments or replace your agent’s signing
                        address. Previously signed payments keep their
                        settlement grace period.
                      </p>
                      <Button
                        variant="secondary"
                        disabled={tx.busy}
                        onClick={() =>
                          void tx.execute(async () => {
                            await tx.write(
                              w.address,
                              walletAbis[w.version],
                              w.paused ? "unpause" : "pause",
                              [],
                            );
                          })
                        }
                      >
                        {w.paused ? "Resume payments" : "Pause payments"}
                      </Button>
                      <form
                        className="live-form"
                        onSubmit={(event) => {
                          const form = data(event);
                          void tx.execute(async () => {
                            await tx.write(
                              w.address,
                              walletAbis[w.version],
                              "rotateAgentSigner",
                              [addr(form.get("signer"))],
                            );
                          });
                        }}
                      >
                        <Field label="New agent signer" name="signer" />
                        <Button disabled={tx.busy}>Rotate signer</Button>
                      </form>
                    </Card>
                  )}
                  {section === "wallet-settings" &&
                    config?.contracts.agentRegistry && (
                      <Card>
                        <h2>Register your agent’s identity</h2>
                        <p className="muted small">
                          Optional: publish a fingerprint of your agent’s
                          profile. Profile content stays off-chain; only its
                          hash is stored.
                        </p>
                        <form
                          className="live-form"
                          onSubmit={(event) => {
                            const form = data(event);
                            void tx.execute(async () => {
                              await tx.write(
                                config.contracts.agentRegistry!,
                                agentAbi,
                                "registerWithMetadataHash",
                                [
                                  w.address,
                                  keccak256(
                                    toHex(String(form.get("metadata"))),
                                  ),
                                ],
                              );
                            });
                          }}
                        >
                          <label className="live-field">
                            <span>
                              Metadata JSON (only its hash goes on-chain)
                            </span>
                            <textarea
                              name="metadata"
                              required
                              placeholder={'{"name":"My agent"}'}
                            />
                          </label>
                          <Button disabled={tx.busy}>Register identity</Button>
                        </form>
                      </Card>
                    )}
                </div>
              )}
              {tx.status}
            </>
          )}
        </>
      )}
    </>
  );
}
function EventTable({
  logs,
  state,
}: {
  logs: LogRecord[];
  state: { loading: boolean; error?: string };
}) {
  return (
    <Card>
      <h2>Payment activity</h2>
      <p className="muted small">
        Recent block-window results, not a complete historical index.
      </p>
      <ReadStatus {...state} />
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Block</th>
              <th>Transaction</th>
              <th>Settlement</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log, i) => (
              <tr key={log.transactionHash + ":" + i}>
                <td>
                  {(
                    {
                      Deposited: "Money added",
                      Withdrawn: "Money withdrawn",
                      Settled: "Payment collected",
                      Paused: "Payments paused",
                      Unpaused: "Payments resumed",
                      ProviderBudgetSet: "Spending limit updated",
                      DisputeOpened: "Refund requested",
                      SettlementReceived: "Payment held",
                    } as Record<string, string>
                  )[log.eventName] ||
                    log.eventName.replace(/([a-z])([A-Z])/g, "$1 $2")}
                </td>
                <td>{log.blockNumber}</td>
                <td>
                  <a
                    href={explorerTransaction(log.transactionHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {shortAddress(log.transactionHash)}
                  </a>
                </td>
                <td>
                  {log.args.settlementId ? (
                    <Link href={routes.dispute(log.args.settlementId)}>
                      {shortAddress(log.args.settlementId)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!state.loading && !state.error && !logs.length && (
          <p>No matching events in the recent block window.</p>
        )}
      </div>
    </Card>
  );
}
function ProviderPanel() {
  const { config } = useApi(),
    { address } = useAccount(),
    tx = useTransaction();
  const profile = useRead<{
      entry: {
        payoutAddress: Address;
        disputeWindow: number;
        preferredArbiter: Address;
        active: boolean;
      };
    }>(
      address && config?.contracts.providerRegistry
        ? "/providers/" + address
        : null,
    ),
    reputation = useRead<unknown>(
      address && config?.contracts.reputationRegistry
        ? "/reputation/" + address
        : null,
    );
  if (!address)
    return (
      <Card className="provider-welcome">
        <h2>Get paid when an agent uses your API</h2>
        <p>
          Connect the wallet that will represent your API service. Register its
          payout address and refund period, then add the middleware to your
          server.
        </p>
        <WalletControl />
        <ButtonLink href="/docs/quickstart/provider" variant="ghost">
          Read the integration guide
        </ButtonLink>
      </Card>
    );
  if (!config?.contracts.providerRegistry)
    return (
      <EmptyState
        title="Provider registration is not available yet."
        description="The registry will appear after the new contract release is configured."
      />
    );
  return (
    <div className="live-grid">
      <Card>
        <h2>
          {profile.value ? "Provider configuration" : "Register your provider"}
        </h2>
        {profile.value && (
          <p>
            Dispute window: {profile.value.entry.disputeWindow}s ·{" "}
            {profile.value.entry.active ? "Active" : "Inactive"}
          </p>
        )}
        <form
          className="live-form"
          onSubmit={(event) => {
            const form = data(event);
            void tx.execute(async () => {
              const payout = addr(form.get("payout")),
                window = Number(form.get("window")),
                arbiter = zero,
                metadata = keccak256(toHex(String(form.get("metadata"))));
              if (!Number.isInteger(window) || window < 0 || window > 604800)
                throw Error("Choose a dispute window from 0 to 604800 seconds");
              if (profile.value) {
                await tx.write(
                  config.contracts.providerRegistry!,
                  providerAbi,
                  "updatePayoutAddress",
                  [payout],
                );
                await tx.write(
                  config.contracts.providerRegistry!,
                  providerAbi,
                  "updateArbiter",
                  [arbiter],
                );
                await tx.write(
                  config.contracts.providerRegistry!,
                  providerAbi,
                  "requestDisputeWindowChange",
                  [window],
                );
              } else
                await tx.write(
                  config.contracts.providerRegistry!,
                  providerAbi,
                  "register",
                  [payout, metadata, window, arbiter],
                );
            });
          }}
        >
          <Field
            label="Payout address"
            name="payout"
            defaultValue={profile.value?.entry.payoutAddress || address || ""}
          />
          <Field
            label="Dispute window (seconds; 0 = instant)"
            name="window"
            type="number"
            defaultValue={String(profile.value?.entry.disputeWindow ?? 3600)}
          />
          <div className="field-help"><strong>Dispute resolution</strong><p>Provider registrations use the protocol’s configured arbiter. Custom arbiter addresses cannot be entered here. Saving an existing provider resets its preference to the protocol default for future settlements.</p><p>Negotiated wallets enforce the approved protocol arbiter on-chain and require the wallet owner to accept the terms before settlement. Legacy wallets keep their original arbitration rules. The current last-resort arbiter is the protocol operator on Arc Testnet.</p></div>
          <Field
            label="Metadata JSON (hashed before submission)"
            name="metadata"
            defaultValue="{}"
          />
          <Button disabled={tx.busy || !address}>
            {profile.value
              ? "Request configuration changes"
              : "Register provider"}
          </Button>
        </form>
        {profile.value && (
          <Button
            variant="secondary"
            disabled={tx.busy}
            onClick={() =>
              void tx.execute(async () => {
                await tx.write(
                  config.contracts.providerRegistry!,
                  providerAbi,
                  "applyDisputeWindowChange",
                  [],
                );
              })
            }
          >
            Apply matured window change
          </Button>
        )}
        {tx.status}
      </Card>
      <Card>
        <h2>Provider history</h2>
        <p className="muted small">
          Recorded payment and refund counters from the protocol. These are
          activity records, not a guarantee of service quality.
        </p>
        <ReadStatus {...reputation} />
        {reputation.value !== undefined ? (
          <details className="workspace-disclosure">
            <summary>View verified activity counters</summary>
            <CodeBlock
              filename="On-chain counters"
              language="json"
              code={text(reputation.value)}
            />
          </details>
        ) : (
          <p>Connect a provider wallet to inspect its history.</p>
        )}
      </Card>
    </div>
  );
}
function DisputePanel({ record }: { record: string }) {
  const { config, request, signedIn,sessionAddress } = useApi(),
    { address } = useAccount(),
    client = usePublicClient(),
    tx = useTransaction(),
    state = useRead<{ id: string; settlement: Settlement;vault:Address;negotiated:boolean }>(
      "/settlements/" + encodeURIComponent(record),
    ),
    details = useRead<{ dispute: Dispute;negotiation?:NegotiationState }>(
      "/disputes/" + encodeURIComponent(record),
    );
  const [now, setNow] = useState(0),
    [evidence, setEvidence] = useState(""),[evidenceWarning,setEvidenceWarning]=useState("");
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const vaultAddress=state.value?.vault||config?.contracts.disputeVault;
  const negotiated=!!state.value?.negotiated;
  const s = state.value?.settlement,
    d = details.value?.dispute;
  const ownerState = useRead<WalletState>(s ? "/wallets/" + s.wallet : null);
  const ownsWallet =
    !!address &&
    !!ownerState.value &&
    address.toLowerCase() === ownerState.value.owner.toLowerCase();
  const receiptOptions = useRead<{
    items: { receipt: SignedReceipt; commitment?: { settlementId: string } }[];
  }>(
    ownsWallet && signedIn && s
      ? "/receipts?wallet=" + s.wallet + "&limit=100"
      : null,
  );
  async function evidenceHash() {
    if (!evidence.trim()) return toHex(0, { size: 32 });
    const saved = await request<{ evidenceHash: Hex }>(
      "/disputes/" + record + "/evidence",
      { method: "POST", body: JSON.stringify({ content: evidence }) },
      true,
    );
    return saved.evidenceHash;
  }
  if (!config?.contracts.disputeVault)
    return (
      <EmptyState
        title="Disputes are not available yet."
        description="Payment wallets with refund support are not configured on this network."
      />
    );
  return (
    <>
      <ReadStatus {...state} />
      {s && (
        <>
          <div className="grid-three app-stats">
            <Stat
              label="Settlement amount"
              hint={
                s.token.toLowerCase() === siteConfig.usdc.toLowerCase()
                  ? "USDC · original payment after protocol fee"
                  : "Token base units"
              }
            >
              {s.token.toLowerCase() === siteConfig.usdc.toLowerCase()
                ? formatUnits(BigInt(s.amount), 6) + " USDC"
                : s.amount}
            </Stat>
            <Stat label="State" hint="Live vault state">
              {["Held", "Released", "Disputed", "Split", "Refunded"][s.state]}
            </Stat>
            <Stat label="Hold ends" hint="Original settlement window">
              <span className="live-small-value">
                {timestamp(s.releaseAfter)}
              </span>
            </Stat>
          </div>
          <Card>
            <h2>Settlement terms</h2>
            <p>
              Provider: <AddressChip address={s.provider} />
            </p>
            <p>
              Arbiter: <AddressChip address={s.arbiter} />
            </p>
            <p>
              Payout: <AddressChip address={s.payoutAddress} />
            </p>
            <p>
              Agent wallet:{" "}
              <Link href={routes.wallet(s.wallet)}>
                {shortAddress(s.wallet)}
              </Link>
            </p>
          </Card>
          <ApiSignIn />
          {evidenceWarning&&<Callout title="Evidence needs another save" tone="warn">{evidenceWarning}</Callout>}
          {d && <EvidenceRecords id={record} />}
          {d && (
            <Card>
              <h2>Dispute timeline</h2>
              <Timeline
                items={[
                  {
                    title: "Dispute opened",
                    detail: timestamp(d.openedAt),
                    status: "Recorded",
                  },
                  {
                    title: negotiated ? "Negotiation deadline" : "Provider response deadline",
                    detail: timestamp(d.responseDeadline),
                    status: d.resolved ? "Resolved" : d.providerResponded
                      ? "Responded"
                      : now >= Number(d.responseDeadline)
                        ? "Expired"
                        : "Waiting",
                  },
                  ...((negotiated || d.providerResponded)
                    ? [
                        {
                          title: negotiated ? "Final deadline (fixed at claim opening)" : "Arbiter deadline",
                          detail: timestamp(d.arbiterDeadline),
                          status: d.resolved
                            ? "Resolved"
                            : now >= Number(d.arbiterDeadline)
                              ? "Expired"
                              : "Waiting",
                        },
                      ]
                    : []),
                ]}
              />
            </Card>
          )}
          {d && negotiated && vaultAddress && <NegotiationActions key={record+address} id={h32(record)} vault={vaultAddress} provider={s.provider} token={s.token} amount={d.amount} owner={ownsWallet} deadline={d.responseDeadline} arbiterDeadline={d.arbiterDeadline} arbiter={s.arbiter} responded={d.providerResponded} resolved={d.resolved} now={now} state={details.value?.negotiation} execute={tx.execute} write={tx.write} busy={tx.busy}/>}
          {d && <HostedDisputeActions key={record+sessionAddress} id={record} amount={d.amount} resolved={d.resolved} negotiated={negotiated} proposal={details.value?.negotiation?.proposal}/>}
          {d && (ownsWallet||address?.toLowerCase()===s.provider.toLowerCase()||address?.toLowerCase()===s.arbiter.toLowerCase()) && <DisputeAssistant key={record+sessionAddress} id={record}/>}
          <Card>
            <h2>Payment actions</h2>{d?.resolved && <p>This payment is finalized. No further resolution is required.</p>}
            <p className="muted small">
              Amounts below are in the settlement token’s base units. The wallet
              previews each transaction before signing.
            </p>
            <div className="live-actions">
              {s.state === 0 && now >= Number(s.releaseAfter) && (
                <Button
                  disabled={tx.busy}
                  onClick={() =>
                    void tx.execute(async () => {
                      await tx.write(
                        vaultAddress!,
                        vaultAbi,
                        "release",
                        [h32(record)],
                      );
                    })
                  }
                >
                  Release payment
                </Button>
              )}
              {s.state === 2 &&
                d &&
                now >= Number(s.releaseAfter) &&
                BigInt(s.amount) - BigInt(d.amount) >
                  BigInt(s.undisputedReleased) && (
                  <Button
                    disabled={tx.busy}
                    onClick={() =>
                      void tx.execute(async () => {
                        await tx.write(
                          vaultAddress!,
                          vaultAbi,
                          "releaseUndisputed",
                          [h32(record)],
                        );
                      })
                    }
                  >
                    Release undisputed remainder
                  </Button>
                )}
              {d &&
                !d.resolved &&
                !d.providerResponded &&
                now >= Number(d.responseDeadline) && (
                  <Button
                    disabled={tx.busy}
                    onClick={() =>
                      void tx.execute(async () => {
                        await tx.write(
                          vaultAddress!,
                          vaultAbi,
                          "autoRefund",
                          [h32(record)],
                        );
                      })
                    }
                  >
                    Refund after provider silence
                  </Button>
                )}
              {d &&
                !d.resolved &&
                d.providerResponded &&
                now >= Number(d.arbiterDeadline) && (
                  <Button
                    disabled={tx.busy}
                    onClick={() =>
                      void tx.execute(async () => {
                        await tx.write(
                          vaultAddress!,
                          vaultAbi,
                          "arbiterTimeout",
                          [h32(record)],
                        );
                      })
                    }
                  >
                    Refund after arbiter timeout
                  </Button>
                )}
            </div>
            {s.state === 0 && now < Number(s.releaseAfter) && ownsWallet && (
              <form
                className="live-form"
                onSubmit={(event) => {
                  const form = data(event);
                  void tx.execute(async () => {
                    if (!client) throw Error("Connect a wallet first");
                    const bond = (await client.readContract({
                      address: vaultAddress!,
                      abi: negotiated ? negotiationAbi : vaultAbi,
                      functionName: negotiated ? "settlementBond" : "disputeBond",
                      args: [negotiated ? h32(record) : s.token],
                    })) as bigint;
                    const approveBond = async () => {
                      if (bond > 0n)
                        await tx.write(s.token, erc20, "approve", [
                          vaultAddress!,
                          bond,
                        ]);
                    };
                    const amount =
                      s.token.toLowerCase() === siteConfig.usdc.toLowerCase()
                        ? parseUnits(String(form.get("amount")), 6)
                        : BigInt(String(form.get("amount")));
                    if (amount <= 0n || amount > BigInt(s.amount))
                      throw Error(
                        "Enter a refund amount within the held payment",
                      );
                    const content=String(form.get("evidence"));setEvidence(content);setEvidenceWarning("");
                    const evidenceHash = keccak256(toHex(content)),
                      voucherId = String(form.get("receipt") || "").trim();
                    if (voucherId) {
                      const proof = await request<{
                        receipt: SignedReceipt;
                        commitment?: { settlementId: Hex; proof: Hex[] };
                      }>("/receipts/" + h32(voucherId), undefined, true);
                      if (
                        proof.commitment?.settlementId.toLowerCase() !==
                        record.toLowerCase()
                      )
                        throw Error(
                          "Receipt belongs to a different settlement",
                        );
                      const r = proof.receipt;
                      await approveBond();
                      await tx.write(
                        vaultAddress!,
                        vaultAbi,
                        "openDisputeWithReceipt",
                        [
                          h32(record),
                          {
                            ...r.receipt,
                            timestamp: BigInt(r.receipt.timestamp),
                            nonce: BigInt(r.receipt.nonce),
                            amount: BigInt(r.receipt.amount),
                          },
                          r.signature,
                          proof.commitment.proof,
                          amount,
                          1,
                          evidenceHash,
                        ],
                      );
                    } else {
                      if (form.get("missing") !== "on")
                        throw Error(
                          "Supply a receipt or confirm the missing-receipt claim",
                        );
                      await approveBond();
                      await tx.write(
                        vaultAddress!,
                        vaultAbi,
                        "openDispute",
                        [h32(record), amount, 1, evidenceHash],
                      );
                    }
                    try{await request("/disputes/"+record+"/evidence",{method:"POST",body:JSON.stringify({content})},true);}catch{setEvidenceWarning("The claim is confirmed on-chain, but the explanation was not saved. Use Save evidence privately below to retry.");}
                  });
                }}
              >
                <Field
                  label={
                    s.token.toLowerCase() === siteConfig.usdc.toLowerCase()
                      ? "Refund requested (USDC)"
                      : "Refund requested (token base units)"
                  }
                  name="amount"
                />
                <label className="live-field">
                  <span>Payment receipt</span>
                  <select name="receipt">
                    <option value="">
                      Select a receipt, or report a missing receipt
                    </option>
                    {receiptOptions.value?.items
                      .filter(
                        (item) =>
                          item.commitment?.settlementId.toLowerCase() ===
                          record.toLowerCase(),
                      )
                      .map((item) => (
                        <option
                          key={item.receipt.receipt.voucherHash}
                          value={item.receipt.receipt.voucherHash}
                        >
                          API call #{item.receipt.receipt.nonce} ·{" "}
                          {new Date(
                            Number(item.receipt.receipt.timestamp) * 1000,
                          ).toLocaleString()}
                        </option>
                      ))}
                  </select>
                  <span className="field-help">
                    Receipts are loaded from your private records. If a receipt
                    is not listed, open its wallet to check additional records;
                    this view includes the first 100.
                  </span>
                </label>
                <ReadStatus
                  loading={receiptOptions.loading}
                  error={receiptOptions.error}
                />
                <label className="live-check">
                  <input type="checkbox" name="missing" />I am making a
                  missing-receipt claim if no receipt is supplied.
                </label>
                <label className="live-field">
                  <span>
                    What went wrong? (shared privately with the provider and
                    arbiter)
                  </span>
                  <textarea name="evidence" required />
                </label>
                <p className="muted small">
                  The configured dispute bond is approved before opening. Only
                  the current agent wallet owner can open this claim.
                </p>
                <Button disabled={tx.busy || !address || !signedIn}>
                  Approve bond and request refund
                </Button>
              </form>
            )}
            {d &&
              (ownsWallet ||
                address?.toLowerCase() === s.provider.toLowerCase() ||
                address?.toLowerCase() === s.arbiter.toLowerCase()) && (
                <form
                  className="live-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void tx.execute(async () => {
                      await evidenceHash();
                    });
                  }}
                >
                  <label className="live-field">
                    <span>
                      Private evidence or file link (shared with the wallet
                      owner, provider and arbiter)
                    </span>
                    <textarea
                      value={evidence}
                      onChange={(e) => setEvidence(e.target.value)}
                      required
                      maxLength={16000}
                    />
                  </label>
                  <Button variant="secondary" disabled={tx.busy}>
                    Save evidence privately
                  </Button>
                </form>
              )}
            {d &&
              !d.resolved &&
              address?.toLowerCase() === s.provider.toLowerCase() && (
                <>
                  <Button
                    variant="secondary"
                    disabled={tx.busy}
                    onClick={() =>
                      void tx.execute(async () => {
                        await tx.write(
                          vaultAddress!,
                          vaultAbi,
                          "acceptDispute",
                          [h32(record)],
                        );
                      })
                    }
                  >
                    Accept and refund disputed amount
                  </Button>
                  {!d.providerResponded && now < Number(d.responseDeadline) && (
                    <form
                      className="live-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void tx.execute(async () => {
                          await tx.write(
                            vaultAddress!,
                            vaultAbi,
                            "respondToDispute",
                            [h32(record), await evidenceHash()],
                          );
                        });
                      }}
                    >
                      <label className="live-field">
                        <span>
                          Provider evidence (stored privately; hash goes
                          on-chain)
                        </span>
                        <textarea
                          value={evidence}
                          onChange={(e) => setEvidence(e.target.value)}
                          required
                          maxLength={16000}
                        />
                      </label>
                      <Button disabled={tx.busy}>
                        Save evidence and respond
                      </Button>
                    </form>
                  )}
                </>
              )}
            {!negotiated && d &&
              !d.resolved &&
              d.providerResponded &&
              now < Number(d.arbiterDeadline) &&
              address?.toLowerCase() === s.arbiter.toLowerCase() && (
                <form
                  className="live-form"
                  onSubmit={(event) => {
                    const form = data(event);
                    void tx.execute(async () => {
                      const refund =
                          s.token.toLowerCase() ===
                          siteConfig.usdc.toLowerCase()
                            ? parseUnits(String(form.get("refund")), 6)
                            : BigInt(String(form.get("refund"))),
                        amount = BigInt(d.amount);
                      if (refund < 0n || refund > amount)
                        throw Error("Refund exceeds the disputed amount");
                      await tx.write(
                        vaultAddress!,
                        vaultAbi,
                        "arbiterDecide",
                        [
                          h32(record),
                          refund,
                          amount - refund,
                          form.get("returnBond") === "on",
                        ],
                      );
                    });
                  }}
                >
                  <Field
                    label={
                      s.token.toLowerCase() === siteConfig.usdc.toLowerCase()
                        ? "Refund to agent (USDC)"
                        : "Refund to agent (token base units)"
                    }
                    name="refund"
                    defaultValue={
                      s.token.toLowerCase() === siteConfig.usdc.toLowerCase()
                        ? formatUnits(BigInt(d.amount), 6)
                        : d.amount
                    }
                  />
                  <label className="live-check">
                    <input name="returnBond" type="checkbox" defaultChecked />
                    Return bond (always returned on any agent win)
                  </label>
                  <Button disabled={tx.busy}>
                    Submit arbitration decision
                  </Button>
                </form>
              )}
            {tx.status}
          </Card>
        </>
      )}
    </>
  );
}
function Lookup({
  label,
  href,
}: {
  label: string;
  href: (value: string) => string;
}) {
  const router = useRouter();
  return (
    <form
      className="live-lookup"
      onSubmit={(event) => {
        const form = data(event);
        router.push(href(String(form.get("record")).trim()));
      }}
    >
      <Field label={label} name="record" />
      <Button variant="secondary">Look up</Button>
    </form>
  );
}
export function LiveWorkspace({
  id,
  record,
}: {
  id: RouteId;
  record?: string;
}) {
  const { config } = useApi();
  const events = useRead<{ items: LogRecord[] }>(
      config?.contracts.disputeVault &&
        (id === "disputes" || id === "provider-settlements")
        ? id === "disputes"
          ? "/disputes"
          : "/settlements"
        : null,
    ),
    profile = useRead<unknown>(
      id === "profile" && record
        ? isAddress(record)
          ? "/providers/" + record
          : "/agents/" + record
        : null,
    );
  return (
    <div className="live-workspace">
      <ApiConnection />
      {id === "overview" && <WalletHub home />}
      {id === "wallets" && (
        <>
          <WalletHub />
          <details className="workspace-disclosure">
            <summary>Already have a wallet address?</summary>
            <p className="muted small">
              Open an existing payment wallet, including one transferred to you.
            </p>
            <Lookup label="Payment wallet address" href={routes.wallet} />
          </details>
        </>
      )}
      {id === "wallet-new" && <CreateWallet />}
      {record && id.startsWith("wallet") && (
        <WalletDetail record={record} section={id} />
      )}{" "}
      {id === "provider" && (
        <>
          <ManagedServices />
          <details className="workspace-disclosure">
            <summary>Already run your own API? Set up a self-hosted provider</summary>
            <p>Use your own server and middleware instead of Sluice hosting.</p>
            <ProviderPanel />
            <ProviderListings />
          </details>
        </>
      )}
      {id === "provider-settlements" && (
        <>
          <ReceiptRecords provider />
          <details className="workspace-disclosure">
            <summary>Look up another payment</summary>
            <Lookup
              label="Payment reference (settlement ID)"
              href={routes.dispute}
            />
          </details>
          <details className="workspace-disclosure">
            <summary>Explore recent network activity</summary>
            <p className="muted small">
              Public events across the protocol in the recent block window. This
              is not limited to your account.
            </p>
            <EventTable logs={events.value?.items || []} state={events} />
          </details>
        </>
      )}
      {id === "disputes" && (
        <>
          <Card className="refund-intro">
            <h2>Need help with a payment?</h2>
            <p>
              Sign in to find your payment receipt, then open its payment
              details. Refund availability depends on the API provider’s hold
              period and the current on-chain status.
            </p>
            <p className="muted small">
              Opening a claim requires a refundable bond. The provider can
              accept the refund, respond to it, or let the response deadline
              expire.
            </p>
          </Card>
          <ReceiptRecords />
          <details className="workspace-disclosure">
            <summary>Open a payment by reference</summary>
            <Lookup
              label="Payment reference (settlement ID)"
              href={routes.dispute}
            />
          </details>
          <EventTable logs={events.value?.items || []} state={events} />
        </>
      )}
      {id === "dispute" && record && <DisputePanel record={record} />}{" "}
      {id === "profile" && (
        <>
          <ReadStatus {...profile} />
          {profile.value !== undefined && (
            <Card>
              <CodeBlock
                code={text(profile.value)}
                filename="Verified registry profile"
                language="json"
              />
            </Card>
          )}
        </>
      )}
      {id === "provider-integration" && (
        <Card>
          <h2>Provider integration</h2>
          <p>
            Use @sluice/middleware with a server-only provider signer and
            Supabase persistence. Your API returns signed call receipts; the
            provider submits settlement batches.
          </p>
          <ButtonLink href="/docs/quickstart/provider">
            Integration guide
          </ButtonLink>
        </Card>
      )}
      {id === "audit" && (
        <Lookup
          label="Agent wallet address for activity"
          href={(address) => routes.wallet(address, "activity")}
        />
      )}
    </div>
  );
}
