"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, isAddress, type Address, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import Link from "next/link";
import {
  AgentPayClient,
  IndexedDBAgentStore,
  detectWallet,
  parseReceipt,
  unpack,
  walletAbis,
  type SignedReceipt,
} from "@sluice/sdk";
import { apiBase, useApi } from "./api-session";
import { Button, Callout, Card, PageHeading } from "./ui";
import { WalletControl } from "./wallet-control";
import { routes } from "../lib/routes";

type ServiceInfo = {
  name: string;
  example: unknown;
  requestFormat: string;
  priceUsdcBaseUnits: string;
  token: Address;
  provider: Address;
  state: string;
};
type Quote = {
  chainId: number;
  provider: Address;
  token: Address;
  price: string;
  version: number;
};
type Review = { wallet: Address; signer: Address; body: string; quote: Quote };
type Result = { status: number; body: string; receipt: SignedReceipt };

export function TryApi({ serviceId }: { serviceId: string }) {
  const endpoint = apiBase + "/hosted/" + serviceId;
  const { config } = useApi();
  const { address: signer, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [paymentWallet, setPaymentWallet] = useState("");
  const [payload, setPayload] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const service = useQuery({
    queryKey: ["try-api-service", serviceId],
    retry: false,
    queryFn: async () => {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw Error("API details could not be loaded");
      return (await response.json()) as ServiceInfo;
    },
  });
  const info = service.data;
  const requestText = payload ?? JSON.stringify(info?.example ?? {}, null, 2);
  const paymentStatus = useQuery({
    queryKey: ["try-api-payment", result?.receipt.receipt.voucherHash],
    enabled: !!result,
    retry: false,
    refetchInterval: query => query.state.data?.status === "settled" ? false : 10000,
    queryFn: async () => {
      const response = await fetch(apiBase + "/receipt-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt: result!.receipt }),
        cache: "no-store",
      });
      if (!response.ok) throw Error("Settlement status unavailable");
      return (await response.json()) as { status: "settled" | "awaiting-settlement"; settlementId: Hex | null };
    },
  });

  async function reviewCall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!config || !publicClient || !signer || chainId !== config.chainId)
        throw Error("Connect the agent signing wallet on Arc Testnet first");
      if (!isAddress(paymentWallet)) throw Error("Enter a valid payment wallet address");
      if (!info || info.state !== "active") throw Error("This API is not active");
      const parsed: unknown = JSON.parse(requestText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw Error("Request must be a JSON object");
      const body = JSON.stringify(parsed);
      if (new TextEncoder().encode(body).length > 24000)
        throw Error("Request exceeds the 24 KiB API limit");
      const version = await detectWallet(publicClient, paymentWallet, config.factories);
      if (version !== 3) throw Error("Use a payment wallet with signed receipts and refund support");
      const validUntil = await publicClient.readContract({
        address: paymentWallet,
        abi: walletAbis[version],
        functionName: "signerValidUntil",
        args: [signer],
      }) as bigint;
      const block = await publicClient.getBlock();
      if (validUntil <= block.timestamp)
        throw Error("Connected wallet is not an active agent signer for this payment wallet");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AgentPay-Version": String(version) },
        body,
        cache: "no-store",
      });
      if (response.status !== 402) throw Error(`Expected a payment quote; API returned HTTP ${response.status}`);
      const header = response.headers.get("X-AgentPay-Quote");
      const quote = (header ? unpack<Quote>(header) : await response.json()) as Quote;
      if (quote.chainId !== config.chainId || quote.version !== version ||
          quote.provider.toLowerCase() !== info.provider.toLowerCase() ||
          quote.token.toLowerCase() !== info.token.toLowerCase() ||
          !/^\d+$/.test(quote.price) || BigInt(quote.price) <= 0n ||
          BigInt(quote.price) > BigInt(info.priceUsdcBaseUnits))
        throw Error("Live payment quote differs from this API's listed terms");
      setReview({ wallet: paymentWallet, signer, body, quote });
    } catch (cause) {
      setReview(null);
      setError(cause instanceof Error ? cause.message : "Could not review the call");
    } finally {
      setBusy(false);
    }
  }

  async function payAndRun() {
    if (!review || !config || !publicClient || !walletClient || !signer ||
        signer.toLowerCase() !== review.signer.toLowerCase() ||
        chainId !== config.chainId) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const account = toAccount({
        address: signer,
        signMessage: ({ message }) => walletClient.signMessage({ account: signer, message }),
        signTransaction: async () => { throw Error("The agent signer cannot send transactions here"); },
        signTypedData: (parameters) => walletClient.signTypedData(
          { account: signer, ...parameters } as unknown as Parameters<typeof walletClient.signTypedData>[0],
        ),
      });
      const client = new AgentPayClient({
        wallet: review.wallet,
        chainId: config.chainId,
        publicClient,
        agent: account,
        factories: config.factories,
        providerRegistry: config.contracts.providerRegistry,
        reputationRegistry: config.contracts.reputationRegistry,
        vault: config.contracts.disputeVault,
        store: new IndexedDBAgentStore("sluice-try-api"),
        policy: {
          allowedProviders: [review.quote.provider],
          allowedTokens: [review.quote.token],
          allowedOrigins: [new URL(endpoint).origin],
          maxPerCall: BigInt(review.quote.price),
          ...(review.quote.version === 3 ? { requireRegisteredProvider: true } : {}),
        },
      });
      const response = await client.fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: review.body,
      });
      const receiptHeader = response.headers.get("X-AgentPay-Receipt");
      if (!receiptHeader) throw Error("Payment response has no signed receipt");
      const receipt = parseReceipt(unpack<SignedReceipt>(receiptHeader));
      const body = await response.text();
      let display = body;
      try { display = JSON.stringify(JSON.parse(body), null, 2); } catch { /* Keep original body. */ }
      setResult({ status: response.status, body: display, receipt });
      setReview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Paid call failed");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading eyebrow="LIVE API CALL" title="Try an API" description="Pay with a real agent wallet and see the JSON result and verified receipt here." />
    <Card className="try-api-card">
      {service.isLoading ? <p role="status">Loading API details…</p> : service.error || !info ?
        <Callout title="API unavailable" tone="warn">{service.error?.message || "Unknown API"}</Callout> : <>
        <h2>{info.name}</h2>
        <p>{info.requestFormat}</p>
        <p className="field-help">Listed price: {formatUnits(BigInt(info.priceUsdcBaseUnits), 6)} USDC per accepted request. An upstream error or timeout can still be charged; refunds are handled separately.</p>
        {info.state !== "active" && <Callout title="API is not active" tone="warn">The provider must activate this API before paid calls can run.</Callout>}
        <div className="try-api-wallet"><span>Connected agent signer</span><WalletControl /></div>
        <p className="field-help">Connect the wallet designated as this payment wallet's agent signer. The owner keeps control of funds and must set the provider budget and accept payment terms first. No private key is entered here.</p>
        <form className="live-form" onSubmit={event => void reviewCall(event)}>
          <label className="live-field"><span>Agent payment wallet address</span><input value={paymentWallet} onChange={event => {setPaymentWallet(event.target.value);setReview(null);}} placeholder="0x…" required autoComplete="off" /></label>
          {isAddress(paymentWallet) && <Link className="text-link" href={routes.wallet(paymentWallet, "budgets") + "?provider=" + info.provider}>Set provider budget and accept refund terms ↗</Link>}
          <label className="live-field"><span>Request JSON</span><textarea value={requestText} onChange={event => {setPayload(event.target.value);setReview(null);}} rows={8} required spellCheck={false} /></label>
          <Button type="submit" variant="secondary" disabled={busy || info.state !== "active"}>{busy ? "Checking…" : "Review live price"}</Button>
        </form>
        {review && <div className="try-api-review"><strong>Confirm paid call</strong><p>Provider: <code>{review.quote.provider}</code></p><p>Maximum charge for this attempt: <strong>{formatUnits(BigInt(review.quote.price), 6)} USDC</strong></p><p className="field-help">Your wallet will ask for EIP-712 signatures. Sluice accepts the voucher before calling the upstream. The result and receipt will appear below; settlement follows later.</p><Button disabled={busy || !walletClient || signer?.toLowerCase() !== review.signer.toLowerCase() || signer?.toLowerCase() !== walletClient.account.address.toLowerCase()} onClick={() => void payAndRun()}>{busy ? "Calling API…" : "Pay and run API"}</Button></div>}
      </>}
      {error && <Callout title="Call could not complete" tone="warn">{error} If signing already started, retry the same request; the authorization may still be pending.</Callout>}
      {result && <div className="try-api-result" role="status"><h2>API result</h2><p>HTTP {result.status} · Signed receipt verified by the SDK</p><pre>{result.body}</pre><div className="try-api-receipt"><strong>Receipt</strong><code>{result.receipt.receipt.voucherHash}</code><span>{formatUnits(BigInt(result.receipt.receipt.amount), 6)} USDC · recorded for settlement</span><span>{paymentStatus.data?.status === "settled" ? "Settled on Arc · payout may remain held during the dispute window" : paymentStatus.error ? "Settlement status unavailable; check payment activity later" : "Awaiting worker settlement · checking automatically"}</span>{paymentStatus.data?.settlementId && <Link className="text-link" href={routes.dispute(paymentStatus.data.settlementId)}>View payment details ↗</Link>}</div><p className="field-help">The receipt confirms the accepted call. Settlement is a separate on-chain step.</p></div>}
    </Card>
  </>;
}
