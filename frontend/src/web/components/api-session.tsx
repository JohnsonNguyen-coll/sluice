"use client";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { Address } from "viem";
import type { Factory } from "@sluice/sdk";
import { Button, Callout } from "./ui";
export type ApiConfig = {
  chainId: number;
  negotiationVaults?:Address[];
  legacyDisputeVaults?:Address[];
  factories: Factory[];
  contracts: {
    agentRegistry?: Address;
    providerRegistry?: Address;
    reputationRegistry?: Address;
    disputeVault?: Address;
  };
};
export const apiBase = (
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001"
).replace(/\/$/, "");
type Session = {
  address: string;
  chainId: number;
  token: string;
  expiresAt: number;
};
type ApiContext = {
  config: ApiConfig | null;
  error: string;
  revision: number;
  refresh: () => void;
  request: <T>(path: string, init?: RequestInit, auth?: boolean) => Promise<T>;
  signIn: () => Promise<void>;
  signedIn: boolean;
  sessionAddress?: string;
  signing: boolean;
};
const Context = createContext<ApiContext | null>(null);
export function ApiSessionProvider({ children }: { children: ReactNode }) {
  const { address, chainId } = useAccount(),
    { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<Session | null>(null),
    [config, setConfig] = useState<ApiConfig | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [signing, setSigning] = useState(false);
  const active =
    session &&
    session.address === address?.toLowerCase() &&
    session.chainId === chainId
      ? session
      : null;
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => setSession(null),
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  const request = useCallback(
    async <T,>(path: string, init?: RequestInit, auth = false): Promise<T> => {
      if (auth && !active) throw Error("Sign in with your wallet first");
      const headers = new Headers(init?.headers);
      if (init?.body) headers.set("Content-Type", "application/json");
      if (active) headers.set("Authorization", "Bearer " + active.token);
      const result = await fetch(apiBase + path, {
        ...init,
        headers,
        cache: "no-store",
      });
      const data = await result.json();
      if (!result.ok) throw Error(data.error?.message || "API request failed");
      return data as T;
    },
    [active],
  );
  useEffect(() => {
    let disposed = false;
    void fetch(apiBase + "/config", { cache: "no-store" })
      .then(async (result) => {
        if (!result.ok) throw Error("Backend configuration unavailable");
        const value = (await result.json()) as ApiConfig;
        if (!disposed) {
          setConfig(value);
          setError("");
        }
      })
      .catch(() => {
        if (!disposed)
          setError(
            "Backend is unavailable. Check the API connection and retry.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [revision]);
  useEffect(() => {
    if (
      !session ||
      (session.address === address?.toLowerCase() &&
        session.chainId === chainId)
    )
      return;
    void fetch(apiBase + "/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + session.token },
    })
      .catch(() => {})
      .finally(() => setSession(null));
  }, [session, address, chainId]);
  async function signIn() {
    if (!address || !chainId) throw Error("Connect a wallet first");
    if (config && chainId !== config.chainId)
      throw Error("Switch to the configured network first");
    setSigning(true);
    try {
      const challenge = await request<{ id: string; message: string }>(
        "/auth/nonce",
        { method: "POST", body: JSON.stringify({ address }) },
      );
      const signature = await signMessageAsync({ message: challenge.message });
      const issued = await request<{ token: string; expiresIn: number }>(
        "/auth/verify",
        {
          method: "POST",
          body: JSON.stringify({ id: challenge.id, signature }),
        },
      );
      setSession({
        address: address.toLowerCase(),
        chainId,
        token: issued.token,
        expiresAt: Date.now() + issued.expiresIn * 1000,
      });
    } finally {
      setSigning(false);
    }
  }
  return (
    <Context.Provider
      value={{
        config,
        error,
        revision,
        refresh: () => setRevision((v) => v + 1),
        request,
        signIn,
        signedIn: !!active,
        sessionAddress: active?.address,
        signing,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useApi() {
  const value = useContext(Context);
  if (!value) throw Error("API session provider missing");
  return value;
}
export function ApiSignIn() {
  const { address } = useAccount();
  const { signIn, signedIn, signing } = useApi(),
    [error, setError] = useState("");
  return (
    <div>
      {signedIn ? (
        <span className="badge badge-success">Private records unlocked</span>
      ) : (
        <Button
          variant="secondary"
          disabled={signing || !address}
          onClick={() => {
            setError("");
            void signIn().catch((error) =>
              setError(
                error instanceof Error
                  ? error.message
                  : "Wallet sign-in failed",
              ),
            );
          }}
        >
          {signing ? "Waiting for signature…" : "Unlock my receipts"}
        </Button>
      )}
      {!address && <p className="small muted">Connect your wallet first.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function ApiConnection() {
  const { error, config, refresh } = useApi();
  return error ? (
    <Callout tone="warn" title="API connection">
      {error}{" "}
      <Button variant="ghost" onClick={refresh}>
        Retry
      </Button>
    </Callout>
  ) : !config ? (
    <p role="status" className="muted">
      Connecting to the payment API…
    </p>
  ) : null;
}
