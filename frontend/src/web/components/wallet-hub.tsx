"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { formatUnits, type Address } from "viem";
import {
  ArrowRight,
  Wallet,
  ShieldCheck,
  PlugZap,
  Plus,
  ArrowUpRight,
} from "lucide-react";
import { useApi, ApiSignIn } from "./api-session";
import type { AgentDetailsResponse } from "./agent-profile";
import { WalletControl } from "./wallet-control";
import { Button, ButtonLink, Card, Callout } from "./ui";
import { siteConfig, shortAddress } from "../lib/site-config";
import { routes } from "../lib/routes";
const tokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
type WalletInfo = {
  address: Address;
  owner: Address;
  agentSigner: Address;
  paused: boolean;
  version: number;
};
function SetupSteps() {
  return (
    <ol className="setup-steps">
      <li>
        <span>
          <Wallet size={20} />
        </span>
        <div>
          <strong>Create a payment wallet</strong>
          <p>
            A separate balance for your agent. You keep control of the funds.
          </p>
        </div>
      </li>
      <li>
        <span>
          <ShieldCheck size={20} />
        </span>
        <div>
          <strong>Add USDC & set limits</strong>
          <p>Choose which API providers your agent can pay and how much.</p>
        </div>
      </li>
      <li>
        <span>
          <PlugZap size={20} />
        </span>
        <div>
          <strong>Connect your own agent</strong>
          <p>
            Use the SDK in your agent’s code. Payments appear here when it calls
            a paid API.
          </p>
        </div>
      </li>
    </ol>
  );
}
export function WalletHub({ home = false }: { home?: boolean }) {
  const { address } = useAccount(),
    client = usePublicClient(),
    { request, revision, signedIn, sessionAddress } = useApi();
  const [offset, setOffset] = useState(0);
  const page = useQuery({
    queryKey: ["wallet-hub", address, offset, revision, sessionAddress],
    enabled: !!address && !!client,
    retry: false,
    queryFn: async () => {
      const list = await request<{
        items: { wallet: Address }[];
        total: number;
      }>("/wallets?owner=" + address + "&limit=12&offset=" + offset);
      const rows = await Promise.all(
        list.items.map(async (item) => {
          try {
            const info = await request<WalletInfo>("/wallets/" + item.wallet);
            let balance: bigint | null = null;
            try {
              balance = await client!.readContract({
                address: siteConfig.usdc as Address,
                abi: tokenAbi,
                functionName: "balanceOf",
                args: [item.wallet],
              });
            } catch {}
            let agent: AgentDetailsResponse | null = null;
            if (signedIn && info.owner.toLowerCase() === address?.toLowerCase())
              try {
                agent = await request<AgentDetailsResponse>(
                  "/wallets/" + item.wallet + "/profile",
                  undefined,
                  true,
                );
              } catch {}
            return { info, balance, agent, address: item.wallet, error: false };
          } catch {
            return {
              info: null,
              balance: null,
              agent: null,
              address: item.wallet,
              error: true,
            };
          }
        }),
      );
      return { ...list, rows };
    },
  });
  const owned =
    page.data?.rows.filter(
      (row) => row.info?.owner.toLowerCase() === address?.toLowerCase(),
    ) || [];
  const allRead =
    !!page.data &&
    !page.data.rows.some((row) => row.error) &&
    owned.every((row) => row.balance !== null);
  const total = owned.reduce((sum, row) => sum + (row.balance ?? 0n), 0n);
  if (!address)
    return (
      <>
        <section className="welcome-panel">
          <div className="welcome-copy">
            <span className="product-label">
              YOUR AGENT. YOUR SPENDING RULES.
            </span>
            <h2>
              Give your agent a budget.
              <br />
              Keep control of your money.
            </h2>
            <p>
              Connect your wallet to create and manage a separate USDC balance
              for your AI agent. Every payment and receipt comes from real
              activity on Arc Testnet.
            </p>
            <WalletControl />
            <Link href="/docs/quickstart/agent" className="text-link">
              See how to connect an agent <ArrowUpRight size={15} />
            </Link>
          </div>
          <div className="welcome-guide">
            <h3>From setup to your first payment</h3>
            <SetupSteps />
          </div>
        </section>
        <div className="workspace-note">
          <ShieldCheck size={18} />
          <p>
            Your connected wallet owns the funds. An agent uses a separate
            signing key and the spending limits you set. Creating a payment
            wallet does not create or run an AI agent.
          </p>
        </div>
      </>
    );
  return (
    <>
      {home && (
        <div className="home-balance-bar">
          <div>
            <span className="muted small">
              USDC in your wallets on this page
            </span>
            <strong>
              {allRead ? formatUnits(total, 6) : "—"} <small>USDC</small>
            </strong>
            <span className="muted small">
              {allRead
                ? "Read from Arc Testnet · not your personal wallet balance"
                : "Balances appear after all wallet reads succeed"}
            </span>
          </div>
          <ButtonLink href="/app/wallets/new">
            Create a payment wallet
          </ButtonLink>
        </div>
      )}
      <section className="wallet-collection">
        <div className="collection-heading">
          <div>
            <h2>{home ? "Your payment wallets" : "Manage your wallets"}</h2>
            <p>Separate balances for the agents you connect.</p>
          </div>
          <div className="live-actions">
            <ApiSignIn />
            <Button
              variant="ghost"
              disabled={page.isFetching}
              onClick={() => void page.refetch()}
            >
              {page.isFetching ? "Refreshing…" : "Refresh"}
            </Button>
            {!home && (
              <ButtonLink href="/app/wallets/new">Create wallet</ButtonLink>
            )}
          </div>
        </div>
        {page.isLoading && (
          <p role="status" className="loading-panel">
            Loading your wallets and on-chain balances…
          </p>
        )}
        {page.error && (
          <Callout title="We couldn’t load your wallets" tone="warn">
            {page.error.message}{" "}
            <Button variant="ghost" onClick={() => void page.refetch()}>
              Try again
            </Button>
          </Callout>
        )}
        {page.data && !page.data.total && (
          <div className="first-wallet">
            <span className="first-wallet-icon">
              <Plus size={24} />
            </span>
            <h3>Your first agent payment starts here</h3>
            <p>
              Create a payment wallet, fund it with testnet USDC, then connect
              your existing agent with the SDK.
            </p>
            <ButtonLink href="/app/wallets/new">
              Create your first wallet
            </ButtonLink>
          </div>
        )}
        <div className="wallet-card-grid">
          {page.data?.rows.map((row) => {
            const info = row.info,
              owns = info?.owner.toLowerCase() === address.toLowerCase();
            return (
              <Card key={row.address} className="payment-wallet-card">
                <div className="wallet-card-top">
                  <span className="wallet-card-symbol">
                    <Wallet size={21} />
                  </span>
                  <span
                    className={
                      "badge " +
                      (info?.paused ? "badge-warning" : "badge-neutral")
                    }
                  >
                    {!info
                      ? "Unavailable"
                      : !owns
                        ? "Ownership changed"
                        : info.paused
                          ? "Payments paused"
                          : "Ready for payments"}
                  </span>
                </div>
                <Link
                  href={routes.wallet(row.address)}
                  className="wallet-card-title"
                >
                  {row.agent?.profile?.name ||
                    "Wallet " + shortAddress(row.address)}
                </Link>
                {row.agent?.profile?.purpose && (
                  <p className="muted small">{row.agent.profile.purpose}</p>
                )}
                <p className="wallet-card-balance">
                  {row.balance === null ? "—" : formatUnits(row.balance, 6)}{" "}
                  <span>USDC</span>
                </p>
                <p className="muted small">
                  {info
                    ? "Agent signing address: " + shortAddress(info.agentSigner)
                    : "Could not verify this wallet. Open it to retry."}
                </p>
                <div className="wallet-card-bottom">
                  <span className="muted small">
                    {info
                      ? "Arc Testnet"
                      : "Connection unavailable"}
                  </span>
                  <Link href={routes.wallet(row.address)}>
                    Manage wallet <ArrowRight size={15} />
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
        {!!page.data?.total && (
          <div className="collection-pagination">
            <p className="small muted">
              Showing creation records {offset + 1}–
              {Math.min(offset + 12, page.data.total)} of {page.data.total}.
              Current ownership is checked separately; wallets transferred to
              you may need address lookup.
            </p>
            <div className="live-actions">
              <Button
                variant="ghost"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 12))}
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                disabled={offset + 12 >= page.data.total}
                onClick={() => setOffset(offset + 12)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </section>
      {home && (
        <Card className="connect-agent-strip">
          <PlugZap size={25} />
          <div>
            <h3>Have a wallet? Connect your agent next.</h3>
            <p>
              Add the SDK to your existing agent. This app manages payments;
              your agent runs in your own environment.
            </p>
          </div>
          <ButtonLink href="/docs/quickstart/agent" variant="secondary">
            Connect an agent
          </ButtonLink>
        </Card>
      )}
    </>
  );
}
