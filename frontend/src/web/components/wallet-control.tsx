'use client';
import { useId, useRef, useSyncExternalStore } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { Wallet } from 'lucide-react';
import { Button } from './ui';
import { siteConfig, shortAddress } from '../lib/site-config';
export function WalletControl() {
 const {address,isConnected,chainId}=useAccount(); const {connectors,connectAsync,isPending,error}=useConnect(); const {disconnect}=useDisconnect(); const {switchChain,isPending:switching,error:switchError}=useSwitchChain();
 const dialog=useRef<HTMLDialogElement>(null); const dialogTitle=useId(); const mounted=useSyncExternalStore(()=>()=>{},()=>true,()=>false);
 if(mounted&&isConnected&&address) return <div className="wallet-actions">{chainId!==siteConfig.chain.id&&<Button variant="secondary" onClick={()=>switchChain({chainId:siteConfig.chain.id})} disabled={switching}>{switching?'Switching…':'Switch to Arc Testnet'}</Button>}<Button variant="secondary" onClick={()=>disconnect()} title="Disconnect wallet">{shortAddress(address)}</Button>{switchError&&<span role="alert" className="small">{switchError.message.split('\n')[0]}</span>}</div>;
 return <><Button variant="secondary" onClick={()=>dialog.current?.showModal()}><Wallet size={15} aria-hidden="true" />Connect wallet</Button><dialog ref={dialog} className="command-dialog" aria-labelledby={dialogTitle}><div className="dialog-heading"><h2 id={dialogTitle}>Connect your wallet</h2><button className="icon-button" aria-label="Close wallet dialog" onClick={()=>dialog.current?.close()}>×</button></div><p className="muted">Connect a browser wallet for write actions. You can browse the app and inspect addresses without connecting.</p>{mounted&&connectors.map(connector=><Button key={connector.uid} disabled={isPending} onClick={()=>{ void connectAsync({connector}).then(()=>dialog.current?.close()).catch(()=>{}); }}>{isPending?'Connecting…':connector.name}</Button>)}{mounted&&connectors.length===0&&<p role="status">No browser wallet detected. Install a compatible injected wallet, then reload.</p>}{error&&<p role="alert">{error.message.split('\n')[0]}</p>}</dialog></>;
}
