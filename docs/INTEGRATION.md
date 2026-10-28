# Sluice AgentPay Core — Integration Guide

## Provider: Add Payments in Under 10 Minutes

### 1. Install middleware

```bash
npm install @sluice/middleware
# or
pnpm add @sluice/middleware
```

### 2. Add one line to your Express app

```typescript
import express from 'express';
import { agentpay } from '@sluice/middleware';

const app = express();

app.use('/api/my-endpoint',
  agentpay({
    price:    500_000n,          // 0.5 USDC in base units (6 decimals)
    provider: process.env.PROVIDER_WALLET_ADDRESS!,
    rpc:      process.env.RPC_URL!,
    settle: {
      thresholdUsdc: 10_000_000n, // settle when 10 USDC is pending
      intervalSec:   300,          // or every 5 minutes
    },
  }),
  (req, res) => {
    // req.agentpay.wallet     — agent wallet address
    // req.agentpay.paid       — amount paid this call (in base units)
    // req.agentpay.cumulative — total paid to date
    res.json({ result: 'your response here' });
  }
);
```

### 3. Set env vars

```
PROVIDER_WALLET_ADDRESS=0x...   # Your EOA or safe that receives USDC
RPC_URL=https://...             # Your RPC endpoint
FACTORY_ADDRESS=0x...           # Deployed AgentWalletFactory address
```

That's it. The middleware handles 402 responses, signature verification, voucher persistence, and settlement.

---

## Agent: Pay for API Calls in Under 10 Minutes

### 1. Install SDK

```bash
npm install @sluice/sdk
```

### 2. Create a wallet and deposit

```typescript
import { AgentPayClient } from '@sluice/sdk';

const client = new AgentPayClient({
  chain:       'arc-testnet',         // or 'base', 'ethereum', etc.
  ownerKey:    process.env.OWNER_PK!,
  agentKey:    process.env.AGENT_SIGNER_PK!,
  factory:     process.env.FACTORY_ADDRESS!,
  usdc:        process.env.USDC_ADDRESS!,
});

// Create a wallet (one-time)
const walletAddress = await client.createWallet({
  settleWindow: 3600,  // 1 hour
  userSalt:     '0x0000000000000000000000000000000000000000000000000000000000000001',
});

// Deposit USDC
await client.deposit(walletAddress, 100_000_000n); // 100 USDC

// Set a budget for the provider
await client.setProviderBudget(walletAddress, {
  provider:   '0xPROVIDER...',
  maxTotal:   50_000_000n,   // 50 USDC total
  perCallCap: 1_000_000n,    // 1 USDC per call
});
```

### 3. Make paid API calls

```typescript
// Drop-in fetch replacement
const response = await client.fetch('https://api.example.com/endpoint', {
  method: 'POST',
  body:   JSON.stringify({ query: 'hello' }),
});

const data = await response.json();
```

The SDK automatically handles 402 responses, signs vouchers, and retries with payment headers.

---

## Voucher Header Format

The SDK sends vouchers as a Base64-encoded JSON object in the `X-AgentPay-Voucher` header:

```json
{
  "wallet":           "0x...",
  "provider":         "0x...",
  "cumulativeAmount": "1000000",
  "nonce":            "7",
  "expiry":           "1735689600",
  "sig":              "0x..."
}
```

## 402 Response Format

```json
{
  "error":    "PaymentRequired",
  "price":    "500000",
  "currency": "USDC",
  "decimals": 6,
  "provider": "0x...",
  "chainId":  5042002,
  "factory":  "0x..."
}
```

## FAQ

**Can multiple providers use the same agent wallet?**
Yes. Each provider has its own independent budget. Settlements from different providers do not interact.

**What happens if the agent signer key is compromised?**
Call `pause()` on the wallet immediately. See RUNBOOK.md for the full incident response procedure.

**Can I precompute my wallet address before deployment?**
Yes. Call `factory.predictWalletAddress(owner, agentSigner, settleWindow, feeBps, userSalt)` or use `client.predictWalletAddress(...)` from the SDK.

**What if my settler crashes with unsettled vouchers?**
The middleware persists every voucher to SQLite/Postgres before acknowledging the request. On restart, it re-reads all unpersisted vouchers and re-submits. No vouchers are lost.
