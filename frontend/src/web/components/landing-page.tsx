import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Wallet, KeyRound, SlidersHorizontal, ShieldCheck, Code2, Layers3 } from 'lucide-react';
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
const steps=[
 {icon:Wallet,title:'Fund a wallet',label:'01 / OWNER',detail:'Funds stay in the agent wallet.'},
 {icon:SlidersHorizontal,title:'Set the rules',label:'02 / POLICY',detail:'Scope spending to each provider.'},
 {icon:KeyRound,title:'Sign per call',label:'03 / OFF-CHAIN',detail:'Authorize payment with a voucher.'},
 {icon:Layers3,title:'Settle in batches',label:'04 / ARC',detail:'Providers redeem valid vouchers.'},
];
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
  <div className="landing-container">
   <section className="payment-rail" aria-label="Protocol payment flow"><div className="rail-top"><span className="mono">FROM WALLET TO SETTLEMENT</span><span>Off-chain authorization → on-chain settlement</span></div><div className="rail-steps">{steps.map(({icon:Icon,title,label,detail})=><div className="rail-step" key={title}><span className="rail-icon"><Icon size={22} strokeWidth={1.4} aria-hidden="true"/></span><span className="rail-step-label">{label}</span><h2>{title}</h2><p>{detail}</p></div>)}</div><div className="rail-bottom"><span className="status-dot"/><span>Protocol flow · SDK and receipt integration in progress</span></div></section>
   <section className="control-section" aria-labelledby="control-heading"><div className="editorial-heading"><span className="section-index">01 — CONTROL</span><h2 id="control-heading">Autonomy starts<br/>with boundaries.</h2><p>Give an agent the ability to pay while keeping ownership and spending controls in your hands.</p><Link className="editorial-link" href={routeHref('security')}>Explore the security model<ArrowUpRight size={15} aria-hidden="true"/></Link></div><div className="control-list">{[{icon:SlidersHorizontal,title:'A budget for every provider',text:'Set a maximum allowance and per-call cap. Each provider gets an explicit spending boundary.'},{icon:Wallet,title:'Your funds. Your wallet.',text:'Ownership stays separate from the signing key an agent uses for payment vouchers.'},{icon:KeyRound,title:'Control when circumstances change',text:'Pause a wallet, rotate the agent signer and reduce budgets with a settlement safety window.'}].map(({icon:Icon,title,text})=><article key={title}><Icon size={23} strokeWidth={1.4} aria-hidden="true"/><div><h3>{title}</h3><p>{text}</p></div></article>)}</div></section>
   <section className="developer-section" aria-labelledby="developer-heading"><div className="editorial-heading"><span className="section-index">02 — INTEGRATE</span><h2 id="developer-heading">Sign off-chain.<br/>Settle in batches.</h2><p>A cumulative payment voucher links a wallet, provider and token. Providers settle the signed authorization on-chain.</p><div className="developer-tags"><span><Code2 size={13} aria-hidden="true"/>EIP-712 signatures</span><span>TypeScript integration in progress</span></div><Link className="editorial-link" href={routeHref('docs-concepts-vouchers')}>Understand vouchers<ArrowUpRight size={15} aria-hidden="true"/></Link></div><div className="voucher-panel"><div className="voucher-panel-label"><span className="status-dot"/><span>VOUCHER / EIP-712</span></div><CodeBlock code={voucher} filename="AgentWalletV3.sol" language="Solidity" highlightLines={[5,6]}/><div className="voucher-footnote"><span>One cumulative amount. A monotonic nonce.</span><Link href={routeHref('docs-contracts-agent-wallet')}>Contract reference<ArrowUpRight size={12} aria-hidden="true"/></Link></div></div></section>
   <section className="protocol-roadmap" aria-labelledby="roadmap-heading"><div className="roadmap-heading"><div><span className="section-index">03 — DIRECTION</span><h2 id="roadmap-heading">From payment rails to trust.</h2></div><Link className="editorial-link" href={routeHref('roadmap')}>Full roadmap<ArrowUpRight size={15} aria-hidden="true"/></Link></div><div className="roadmap-lanes">{[{phase:'01',title:'Payment core',status:'Live on testnet',className:'live',text:'Prefunded wallets, provider budgets and voucher settlement.'},{phase:'02',title:'Multi-token contracts',status:'Live on testnet',className:'live',text:'V2 factory deployment recorded on Arc Testnet.'},{phase:'03',title:'Identity & trust',status:'In progress',className:'progress',text:'Registries, receipts, reputation and dispute integration.'},{phase:'04',title:'Organization controls',status:'Planned',className:'planned',text:'Shared budgets, approvals and organization workflows.'}].map(item=><article key={item.phase}><span className="phase-number">{item.phase}</span><span className={'phase-status '+item.className}><span/>{item.status}</span><h3>{item.title}</h3><p>{item.text}</p></article>)}</div></section>
   <section className="closing-section"><span className="section-index">START WITH A WALLET.</span><h2>Build agents<br/>that can <span>pay.</span></h2><div><Link className="button button-primary" href={routeHref('docs')}>Explore the docs<ArrowUpRight size={16} aria-hidden="true"/></Link><Link className="hero-text-link" href={routeHref('overview')}>Launch app<ArrowRight size={16} aria-hidden="true"/></Link></div><p>Arc Testnet · AgentPay protocol</p></section>
  </div>
 </div>;
}
