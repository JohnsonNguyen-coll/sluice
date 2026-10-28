/**
 * Minimal Provider Example
 * ========================
 * A minimal Express API that requires AgentPay payment for each request.
 * Copy this file and adapt price/provider/rpc to your needs.
 *
 * Prerequisites:
 *   - Deploy AgentWalletFactory (see contract/script/Deploy.s.sol)
 *   - Set PROVIDER_WALLET_ADDRESS, RPC_URL, FACTORY_ADDRESS in your env
 */

import express from 'express';
import { agentpay } from '@sluice/middleware';

const app = express();
app.use(express.json());

const PRICE_USDC = 500_000n; // 0.50 USDC (6 decimals)

// Protect the /answer endpoint with AgentPay payment
app.post(
  '/answer',
  agentpay({
    price:    PRICE_USDC,
    provider: process.env.PROVIDER_WALLET_ADDRESS!,
    rpc:      process.env.RPC_URL!,
    factory:  process.env.FACTORY_ADDRESS!,
    settle: {
      thresholdUsdc: 10_000_000n, // settle when 10 USDC pending
      intervalSec:   60,           // or every minute
    },
  }),
  (req, res) => {
    const { question } = req.body as { question: string };

    // req.agentpay is populated by the middleware
    console.log(`Received ${req.agentpay.paid} base units from wallet ${req.agentpay.wallet}`);

    res.json({ answer: `You asked: "${question}". Answer: 42.` });
  },
);

app.listen(3000, () => {
  console.log('Provider listening on http://localhost:3000');
  console.log(`Requires ${PRICE_USDC} USDC base units per call`);
});
