# Negotiation-first disputes

Delivered on Arc Testnet, 2026-10-30 (Asia/Bangkok). Working testnet implementation; not an independent audit or a production arbitration service.

## Rules

- A claim starts 30 minutes of negotiation. Either party proposes an exact refund, bond treatment and reason; the other accepts that proposal hash before the deadline. Agreement executes immediately.
- A provider proposal counts as a response. Provider silence allows anyone to trigger a refund of disputed principal and return of the claimant bond after negotiation.
- After negotiation, either party can explicitly escalate a responded claim. Only then can the snapshotted arbiter decide, with a reason hash. Its allocation must equal the disputed principal.
- The final deadline is fixed at claim opening + 30 minutes + 24 hours. Responding/escalating cannot extend it. After this deadline, anyone can trigger the disputed-principal refund and bond return, even without escalation.
- Current claim cap: 100 USDC per settlement. Bond: 0.1 USDC. Receipt-backed claims retain signature, inclusion, nonce interval and proportional payout checks. Missing-receipt claims remain unverified and bonded. Protocol fees are not refunded.
- Undisputed principal can release after the provider's original hold. A final arbiter award of zero to the agent may forfeit the bond to the protocol.

## Consent and trust

New wallets require an active registered provider with a nonzero hold. Their owner accepts the exact on-chain terms hash before settlement; the SDK checks before signing. Raw vouchers cannot bypass the wallet's on-chain check. Terms bind payout/hold, token, bond, cap, approved arbiter, deadlines and timeout outcome. The provider chooses registration terms; the wallet owner accepts them.

Terms are accepted on-chain, **not embedded in each signed voucher**. Changed terms block unsettled payments until the current owner accepts them again. Providers must account for this settlement risk. Existing settlements snapshot their arbiter, bond and claim cap.

Custom provider arbiters are rejected by this vault. The approved last-resort arbiter is currently the protocol operator EOA `0xfFFCD12eD0b2Df08D07f5546194BD3bb46d2aE02`, not an independent panel or multisig. An approved arbiter can still make an unfair allocation of disputed principal. Admin approval does not prove fairness. There is no post-decision appeal in this release; escalation is the final stage before decision or timeout. Production requires independent arbitration operations and security review.

## Deployments and compatibility

| Component | Arc Testnet address |
|---|---|
| NegotiationWalletFactory | `0x6f753e100de35d30ac978363e7737595152e9d03` |
| NegotiationDisputeVault | `0x4cb34a1ae20007561a90826086f1c3a3e72037f2` |

V3's external wallet/voucher interface is retained; factory descriptors identify the negotiation vault. Canonical configuration/runtime hashes: `contract/deployments/arc-testnet.json` and `negotiation-arc-testnet.json`. Backend public addresses were updated; frontend imports canonical chain facts and reads API configuration.

Legacy factories/vaults remain discoverable. No old balance or dispute was migrated. The two legacy timeout cases in `phase3-testnet-e2e.json` resolved after their original November 1 deadlines. The legacy resume script used its recorded historical release instead of the new factory.

## Optional evidence assistant

Set `DISPUTE_AI_API_KEY`, `DISPUTE_AI_MODEL` and optionally `DISPUTE_AI_BASE_URL` in ignored `backend/.env`; restart the backend after environment changes. Default endpoint: OpenRouter's OpenAI-compatible API. Keys never go to the browser.

An authenticated party selects private evidence and explicitly confirms external processing. The assistant receives those records and settlement facts. Validated output is non-binding; the service has no wallet keys, signing tools or transaction authority. Recommendations are not automatically submitted as proposals. Missing configuration displays unavailability, not invented reports. Unit tests use isolated model responses; live paid inference is not claimed.

## Verification

- Solidity unit/fuzz selection: 294 passed, zero failures. Coverage includes stale proposals, owner changes, unauthorized/early arbitration, allocation conservation, fixed timeout, silence and direct voucher bypass.
- Backend/SDK/middleware: 43 tests passed, 279 assertions, including analysis authorization and explicit evidence-export consent.
- Frontend lint/typecheck and production build passed. All 56 route/metadata/link checks passed. RainbowKit dependencies emit optional React Native storage/pino-pretty module warnings; the web build completes.
- Local Anvil integration: signed paid calls, receipts/proofs, immediate agreement, explicit arbitration, silence refund and final timeout. Time travel is not proof of elapsed testnet deadlines.
- Real Arc Testnet: paid API call, verified receipt/proof persisted in Supabase, 0.004 USDC claim, two-party 0.002 USDC refund without arbiter intervention. API confirmed resolution and private evidence persistence.
- Agreement transaction: `0x6f63a1468e4e8c6ed4770e40de0d1f97a1c15627726a976255d885d1d0507b64`. Report: `contract/deployments/negotiation-testnet-e2e.json`. The API is an explicitly labeled integration harness, not a published AI model service.

Do not blindly repeat deployments after partial failure; inspect the public pending journal. New deployments do not upgrade old instances.
