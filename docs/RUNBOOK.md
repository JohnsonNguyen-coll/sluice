# Sluice AgentPay Core — Operations Runbook

## Incident: Compromised agentSigner Key

**Severity:** High — attacker can drain up to `encumberedBalance` per wallet.

### Immediate steps (< 5 minutes)

1. **Pause all affected wallets.**
   ```bash
   # Using SDK owner helpers (one wallet):
   await client.pause(walletAddress);
   # Or directly via cast (if you have the owner private key):
   cast send $WALLET_ADDRESS "pause()" --private-key $OWNER_PK --rpc-url $RPC_URL
   ```
   This blocks all new settlements immediately.

2. **Assess damage.** Query `settled[provider]` for each provider. Subtract expected cumulative amounts. The difference is the attacker's gain.

3. **Rotate the signer.**
   ```bash
   await client.rotateAgentSigner(walletAddress, newSignerAddress);
   # Old key's vouchers remain valid for settleWindow (1 hour default).
   # Generate a new keypair from a secure source (HSM recommended).
   ```

4. **Monitor for `Settled` events** during the `settleWindow` — the attacker may submit last-minute vouchers from the old key within that window.

5. **Unpause** once settleWindow has elapsed and no suspicious settlements have appeared.
   ```bash
   await client.unpause(walletAddress);
   # Note: withdrawal cooldown lasts settleWindow from pause time.
   ```

6. **Withdraw remaining funds** if the wallet is compromised beyond recovery.

### Recovery checklist
- [ ] New agentSigner key generated from a secure source
- [ ] New key stored in KMS / HSM (not in plaintext env var)
- [ ] SDK configured with new signer
- [ ] All providers notified of new signer (for off-chain verification caches)
- [ ] Budgets reviewed — consider reducing maxTotal until audit is complete
- [ ] Incident report filed

---

## Incident: Wallet Pause (Routine)

**When to use:** Unusual spending patterns, suspected compromise, key rotation.

```bash
# Pause
cast send $WALLET_ADDRESS "pause()" --private-key $OWNER_PK --rpc-url $RPC_URL

# Check pauseWithdrawDeadline
cast call $WALLET_ADDRESS "pauseWithdrawDeadline()(uint256)" --rpc-url $RPC_URL

# Unpause (does NOT clear withdrawal cooldown)
cast send $WALLET_ADDRESS "unpause()" --private-key $OWNER_PK --rpc-url $RPC_URL

# Withdraw (only after pauseWithdrawDeadline has passed)
cast send $WALLET_ADDRESS "withdraw(uint256)" $AMOUNT --private-key $OWNER_PK --rpc-url $RPC_URL
```

---

## Incident: Budget Decrease Under Load

If you need to reduce a provider's budget quickly:

1. Call `requestBudgetDecrease(provider, newMaxTotal, newPerCallCap)`.
2. Wait `settleWindow` seconds (provider has this window to settle outstanding vouchers at the old limit).
3. Call `executeBudgetDecrease(provider)`.

**Emergency:** If you need to stop a provider immediately, pause the wallet (blocks all settlements). Then rotate the signer to invalidate outstanding vouchers after settleWindow.

---

## Incident: Settler Worker Down

**Symptom:** Unsettled vouchers accumulating in the middleware's database. Providers earning exposure without on-chain settlement.

**Action:**
1. Check settler worker logs for errors (nonce conflicts, RPC errors, gas price issues).
2. If nonce conflict: reset the nonce in the settler's state store to match the on-chain tx count.
3. If gas price: increase `maxFeePerGas` in settler config.
4. Restart settler. It reads all unsettled vouchers from the database on startup.

**Alert threshold:** Configure middleware to alert when unsettled exposure per wallet exceeds a configured limit. Stop serving that wallet if the limit is breached (the middleware's `settle.exposureAlertUsdc` option).

---

## Monitoring Checklist

| Metric | Source | Alert threshold |
|---|---|---|
| `encumberedBalance` per wallet | Contract events | > 90% of `usdc.balanceOf(wallet)` |
| Unsettled voucher age | Middleware DB | > 2× settleWindow |
| Settler tx failure rate | Middleware logs | > 3 consecutive failures |
| `Settled` events with unexpected provider | Chain indexer | Any unknown provider |
| `AgentSignerRotated` events | Chain indexer | Unexpected rotation |
| `Paused` events | Chain indexer | Any pause (pager-duty) |

---

## Key Rotation (Routine)

Rotate the agentSigner regularly (monthly or quarterly):

1. Generate a new keypair from a secure source.
2. Store in KMS / HSM.
3. Call `rotateAgentSigner(walletAddress, newSigner)`.
4. Update SDK configuration.
5. Monitor for `settleWindow` to confirm no issues with the old key.

---

## Factory Owner Key Compromise

**Impact:** Attacker can change `feeBps` (for new wallets only) or initiate a `feeRecipient` transfer. Existing wallets and their funds are unaffected.

**Action:**
1. Initiate a 2-step ownership transfer to a fresh wallet.
2. Accept with the new owner.
3. Verify new owner is correct on-chain.
