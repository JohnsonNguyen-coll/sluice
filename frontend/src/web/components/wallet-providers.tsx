"use client";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { defineChain, fallback } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RainbowKitProvider,
  connectorsForWallets,
  darkTheme,
  lightTheme,
} from "@rainbow-me/rainbowkit";
import {
  rainbowWallet,
  metaMaskWallet,
  rabbyWallet,
  injectedWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import "@rainbow-me/rainbowkit/styles.css";
import { Toaster } from "sonner";
import { siteConfig } from "../lib/site-config";
const chain = defineChain({
  id: siteConfig.chain.id,
  name: siteConfig.chain.name,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [siteConfig.chain.rpc] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: siteConfig.chain.explorer },
  },
  testnet: true,
});
const publicRpcs = [
  siteConfig.chain.rpc,
  "https://rpc.testnet.arc.io",
  "https://rpc.blockdaemon.testnet.arc.io",
  "https://rpc.drpc.testnet.arc.io",
  "https://rpc.quicknode.testnet.arc.io",
];
// Empty configuration enables only browser wallets; never use a demo WalletConnect ID.
const projectId = (
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || ""
).trim();
const walletConnectReady = /^[a-f0-9]{32}$/i.test(projectId);
const connectors = connectorsForWallets(
  [
    {
      groupName: "Connect a wallet",
      wallets: walletConnectReady
        ? [
            metaMaskWallet,
            rabbyWallet,
            rainbowWallet,
            walletConnectWallet,
            injectedWallet,
          ]
        : [rabbyWallet, injectedWallet],
    },
  ],
  {
    appName: siteConfig.name,
    appDescription: siteConfig.description,
    projectId: walletConnectReady ? projectId : "",
  },
);
const config = createConfig({
  chains: [chain],
  connectors,
  transports: {
    [chain.id]: fallback(
      [...new Set(publicRpcs)].map((url) =>
        http(url, { timeout: 4000, retryCount: 0 }),
      ),
      { retryCount: 0 },
    ),
  },
  ssr: true,
});
function subscribeTheme(listener: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("storage", listener);
  window.addEventListener("sluice-theme", listener);
  media.addEventListener("change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("sluice-theme", listener);
    media.removeEventListener("change", listener);
  };
}
function currentTheme() {
  const selected = document.documentElement.dataset.theme;
  return selected === "light" || selected === "dark"
    ? selected
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
}
const themes = {
  dark: darkTheme({
    accentColor: "#acbaff",
    accentColorForeground: "#101526",
    borderRadius: "medium",
    fontStack: "system",
    overlayBlur: "small",
  }),
  light: lightTheme({
    accentColor: "#5265ce",
    accentColorForeground: "#ffffff",
    borderRadius: "medium",
    fontStack: "system",
    overlayBlur: "small",
  }),
};
export function WalletProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  const theme = useSyncExternalStore(
    subscribeTheme,
    currentTheme,
    () => "dark" as const,
  );
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={client}>
        <RainbowKitProvider
          initialChain={chain}
          theme={themes[theme]}
          modalSize="compact"
          appInfo={{
            appName: siteConfig.name,
            learnMoreUrl: "/docs/quickstart/agent",
          }}
        >
          {children}
          <Toaster position="bottom-right" richColors />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
