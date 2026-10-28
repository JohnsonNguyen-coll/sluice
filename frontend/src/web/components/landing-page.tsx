import Link from 'next/link';
import { ArrowRight, ArrowUpRight, ShieldCheck, Layers3, Server, Bot, Check } from 'lucide-react';
import { routeHref } from '../lib/routes';
import { VeilBackground } from './backgrounds/veil-background';
import { CodeBlock } from './primitives';

const voucher = `struct Voucher {
    address wallet;
    address provider;
    address token;
    uint256 cumulativeAmount;
    uint256 nonce;
    uint64  expiry;
}`;
function PaymentDiagram() {
 return <figure className="protocol-diagram" aria-label="Protocol concept: an agent signs payment vouchers, a provider collects them and settles in batches on Arc.">
  <figcaption><span className="mono">THE PAYMENT PATH</span><span className="diagram-concept">Protocol concept</span></figcaption>
  <div className="diagram-node"><div className="diagram-node-icon"><Bot size={23} aria-hidden="true"/></div><div><strong>Your agent</strong><span>Requests an API · checks spending policy</span></div><span className="diagram-node-tag">SDK</span></div>
  <div className="diagram-connector"><span/><code>EIP-712 signed voucher</code><ArrowRight size={14} aria-hidden="true"/></div>
  <div className="diagram-node"><div className="diagram-node-icon"><Server size={23} aria-hidden="true"/></div><div><strong>API provider</strong><span>Verifies authorization · returns a response</span></div><span className="diagram-node-tag">API</span></div>
  <div className="diagram-connector"><span/><code>Collect vouchers → settle a batch</code><ArrowRight size={14} aria-hidden="true"/></div>
  <div className="diagram-settlement"><Layers3 size={22} aria-hidden="true"/><div><strong>Arc settlement</strong><span>AgentWallet → provider</span></div><span className="diagram-network">ON-CHAIN</span></div>
  <div className="diagram-footnote"><ShieldCheck size={14} aria-hidden="true"/><span>Funds stay in the wallet until settlement.</span></div>
 </figure>;
}

function BudgetExample() {
 return <figure className="budget-example" aria-labelledby="budget-example-title">
  <figcaption><span id="budget-example-title">Provider spending policy</span><span className="example-label">ILLUSTRATIVE DEMO</span></figcaption>
  <div className="budget-provider"><div className="diagram-node-icon"><Server size={20} aria-hidden="true"/></div><div><strong>Example API provider</strong><span>USDC allowance</span></div><span className="policy-enabled"><Check size={13} aria-hidden="true"/>Enabled</span></div>
  <div className="budget-amount"><strong>32.00 <span>/ 100.00 USDC</span></strong><span>Example cumulative authorization</span></div>
  <div className="budget-meter" role="img" aria-label="Illustrative usage: 32 of 100 USDC authorized"><span/></div>
  <dl className="budget-settings"><div><dt>Provider budget</dt><dd>100.00 USDC</dd></div><div><dt>Per-call limit</dt><dd>0.10 USDC</dd></div><div><dt>Agent signing key</dt><dd>Separate from owner</dd></div></dl>
  <p className="example-disclaimer">Example values to explain the policy. No live wallet or funds.</p>
 </figure>;
}

export function LandingFoundation(){
 return <div className="landing-redesign">
  <VeilBackground/>
  <section className="editorial-hero landing-container" aria-labelledby="landing-title">
   <Link href={routeHref('status')} className="hero-release"><span className="status-dot"/>Building on Arc Testnet<span className="release-divider"/>Developer preview<ArrowUpRight size={12} aria-hidden="true"/></Link>
   <p className="hero-overline">SLUICE / AGENTPAY PROTOCOL</p>
   <h1 id="landing-title">The payment layer<br/><span>for autonomous agents.</span></h1>
   <p className="hero-summary">Prefund a wallet. Set the spending rules.<br className="desktop-break"/> Let agents pay for APIs with signed off-chain vouchers.</p>
   <div className="editorial-hero-actions"><Link className="button button-primary" href={routeHref('docs-quickstart-agent')}>Start building<ArrowUpRight size={16} aria-hidden="true"/></Link><Link className="hero-text-link" href={routeHref('overview')}>Open dashboard<ArrowRight size={16} aria-hidden="true"/></Link></div>
   <p className="hero-caption"><ShieldCheck size={14} aria-hidden="true"/>Owner-controlled funds. Independent agent signing keys.</p>
  </section>
  <div className="landing-container protocol-lower">
   <section className="payment-flow-section" aria-labelledby="payment-flow-heading">
    <div className="protocol-section-copy payment-flow-copy"><div className="payment-flow-heading-group"><span className="section-index">01 / PAYMENT FLOW</span><h2 id="payment-flow-heading">How payments<br/>move.</h2></div><div className="payment-flow-description"><p>Authorize each API call off-chain. Settle payments together on Arc.</p><p>The agent signs a voucher within its spending policy. The provider verifies it, serves the request and collects vouchers for settlement.</p></div><Link className="editorial-link" href={routeHref('how')}>See how it works<ArrowUpRight size={15} aria-hidden="true"/></Link></div>
    <PaymentDiagram/>
   </section>
   <section className="policy-section" aria-labelledby="policy-heading">
    <div className="protocol-section-copy"><span className="section-index">02 / SPENDING CONTROL</span><h2 id="policy-heading">A wallet for the agent.<br/>Control for you.</h2><p>Give an agent room to work without giving it unrestricted access to your funds.</p><ul className="policy-benefits"><li><Check size={16} aria-hidden="true"/><span>Explicit budgets for each provider</span></li><li><Check size={16} aria-hidden="true"/><span>Per-call caps and daily spending limits</span></li><li><Check size={16} aria-hidden="true"/><span>Pause controls and signer rotation</span></li></ul><Link className="editorial-link" href={routeHref('security')}>Explore the security model<ArrowUpRight size={15} aria-hidden="true"/></Link></div>
    <BudgetExample/>
   </section>
   <section className="protocol-developer" aria-labelledby="developer-heading">
    <div className="protocol-section-copy"><span className="section-index">03 / THE PAYMENT PRIMITIVE</span><h2 id="developer-heading">An API call.<br/>A signed commitment.</h2><p>Each voucher binds a wallet, provider and token to a cumulative payment amount. Providers redeem valid authorizations on-chain.</p><ol className="integration-sequence"><li><span>01</span><div><strong>Quote the call</strong><p>The provider responds with a price.</p></div></li><li><span>02</span><div><strong>Authorize within policy</strong><p>The agent signs an EIP-712 voucher.</p></div></li><li><span>03</span><div><strong>Collect and settle</strong><p>The provider batches cumulative vouchers.</p></div></li></ol><Link className="editorial-link" href={routeHref('docs-concepts-vouchers')}>Read the voucher specification<ArrowUpRight size={15} aria-hidden="true"/></Link></div>
    <div className="protocol-code"><div className="protocol-code-heading"><span className="mono">SIGNED AUTHORIZATION</span><span>Solidity · V3</span></div><CodeBlock code={voucher} filename="AgentWalletV3.sol" language="Solidity" highlightLines={[5,6]}/><p><span className="status-dot"/>SDK and receipt integration in progress</p></div>
   </section>
   <section className="protocol-release-strip" aria-labelledby="release-heading"><div><span className="section-index">BUILT IN STAGES</span><h2 id="release-heading">Payment first. Trust next.</h2><Link className="editorial-link" href={routeHref('roadmap')}>View roadmap<ArrowUpRight size={15} aria-hidden="true"/></Link></div><ol><li><span className="release-state live">ON TESTNET</span><strong>Payment & multi-token contracts</strong><p>Prefunded wallets, budgets and settlement.</p></li><li><span className="release-state">IN PROGRESS</span><strong>Identity & trust</strong><p>Receipts, reputation and dispute integration.</p></li><li><span className="release-state planned">PLANNED</span><strong>Organization controls</strong><p>Shared budgets and approval workflows.</p></li></ol></section>
   <section className="protocol-close"><div><span className="section-index">BUILD ON SLUICE</span><h2>Your agent’s next call<br/>can be a paid one.</h2></div><div><Link className="button button-primary" href={routeHref('docs')}>Explore the docs<ArrowUpRight size={16} aria-hidden="true"/></Link><Link className="hero-text-link" href={routeHref('overview')}>Launch app<ArrowRight size={16} aria-hidden="true"/></Link></div></section>
  </div>
 </div>;
}
