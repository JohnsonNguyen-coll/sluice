'use client';
import { useState, type ReactNode } from 'react';
import { WagmiProvider, createConfig, http, injected } from 'wagmi';
import { defineChain } from 'viem';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { siteConfig } from '../lib/site-config';
const chain=defineChain({id:siteConfig.chain.id,name:siteConfig.chain.name,nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[siteConfig.chain.rpc]}},testnet:true});
const config=createConfig({chains:[chain],connectors:[injected()],transports:{[chain.id]:http(siteConfig.chain.rpc)},ssr:true});
export function WalletProviders({children}:{children:ReactNode}) {
 const [client]=useState(()=>new QueryClient({defaultOptions:{queries:{retry:1,refetchOnWindowFocus:false}}}));
 return <WagmiProvider config={config}><QueryClientProvider client={client}>{children}<Toaster position="bottom-right" richColors /></QueryClientProvider></WagmiProvider>;
}
