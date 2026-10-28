/**
 * Minimal Agent Example
 * =====================
 * An AI agent that pays for API calls using AgentPayClient.
 * The `client.fetch()` call is a drop-in replacement for `fetch` that
 * automatically handles 402 Payment Required responses.
 *
 * Prerequisites:
 *   - Deploy AgentWalletFactory (see contract/script/Deploy.s.sol)
 *   - Set OWNER_PK, AGENT_SIGNER_PK, FACTORY_ADDRESS, USDC_ADDRESS in your env
 */

import { AgentPayClient } from '@sluice/sdk';

async function main() {
  const client = new AgentPayClient({
    chain:    'arc-testnet',
    ownerKey: process.env.OWNER_PK!,
    agentKey: process.env.AGENT_SIGNER_PK!,
    factory:  process.env.FACTORY_ADDRESS!,
    usdc:     process.env.USDC_ADDRESS!,
  });

  // Step 1: Create wallet (one-time per agent)
  const walletAddress = await client.createWallet({
    settleWindow: 3600,
    userSalt:     '0x0000000000000000000000000000000000000000000000000000000000000001',
  });
  console.log('Wallet deployed at:', walletAddress);

  // Step 2: Deposit USDC (approval required first)
  await client.deposit(walletAddress, 100_000_000n); // 100 USDC
  console.log('Deposited 100 USDC');

  // Step 3: Set budget for the provider
  const PROVIDER = process.env.PROVIDER_ADDRESS!;
  await client.setProviderBudget(walletAddress, {
    provider:   PROVIDER,
    maxTotal:   50_000_000n,  // 50 USDC max
    perCallCap: 1_000_000n,   // 1 USDC per call
  });
  console.log('Budget set for provider:', PROVIDER);

  // Step 4: Make paid API calls — works just like fetch
  const response = await client.fetch('http://localhost:3000/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ question: 'What is the meaning of life?' }),
  });

  const data = await response.json();
  console.log('Got answer:', data);
}

main().catch(console.error);
