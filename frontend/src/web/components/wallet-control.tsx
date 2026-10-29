"use client";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Wallet, ChevronDown } from "lucide-react";
import { Button } from "./ui";
export function WalletControl() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        mounted,
      }) => (
        <div className="wallet-actions">
          {!mounted || !account || !chain ? (
            <Button
              type="button"
              variant="secondary"
              disabled={!mounted}
              onClick={openConnectModal}
            >
              <Wallet size={15} aria-hidden="true" />
              Connect wallet
            </Button>
          ) : chain.unsupported ? (
            <Button type="button" variant="secondary" onClick={openChainModal}>
              Switch to Arc Testnet
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={openAccountModal}
              aria-label={"Manage wallet " + account.displayName}
              title="Manage wallet or disconnect"
            >
              <Wallet size={15} aria-hidden="true" />
              {account.displayName}
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </ConnectButton.Custom>
  );
}
