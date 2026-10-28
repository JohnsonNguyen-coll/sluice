import { SluiceMark } from './logo';
import Link from 'next/link';
import type { ReactNode, ButtonHTMLAttributes } from 'react';
import { ArrowUpRight, ArrowRight, ShieldCheck, Layers3 } from 'lucide-react';
import { routeHref } from '../lib/routes';

export function Brand() {
  return <Link className="brand" href={routeHref('home')} aria-label="Sluice home"><span className="brand-mark" aria-hidden="true"><SluiceMark /></span>Sluice<span className="brand-protocol">AGENTPAY</span></Link>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Button({ children, variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <button {...props} className={`button button-${variant} ${props.className || ''}`}>{children}</button>;
}
export function ButtonLink({ href, children, variant = 'primary' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <Link className={`button button-${variant}`} href={href}>{children}<ArrowRight size={15} aria-hidden="true" /></Link>;
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <div className={`card ${className}`}>{children}</div>; }
export function Callout({ children, title = 'Implementation status', tone = 'note' }: { children: ReactNode; title?: string; tone?: 'note' | 'warn' | 'tip' }) {
  return <aside className={`callout callout-${tone}`}><ShieldCheck size={18} aria-hidden="true" /><div><strong>{title}</strong><div>{children}</div></div></aside>;
}
export function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <header className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="lede">{description}</p>{children}</header>;
}
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <section className="empty-state"><span className="empty-icon" aria-hidden="true"><Layers3 size={26} /></span><h2>{title}</h2><p>{description}</p>{action}</section>;
}
export function Skeleton({ className = '' }: { className?: string }) { return <div className={`skeleton ${className}`} aria-hidden="true" />; }
export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint: string }) { return <Card><p className="muted small">{label}</p><div className="stat-value">{children}</div><p className="small muted">{hint}</p></Card>; }
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="text-link">{children}<ArrowUpRight size={14} aria-hidden="true" /></a>; }
export function Timeline({ items }: { items: { title: string; detail: string; status: string }[] }) { return <ol className="timeline">{items.map(item => <li key={item.title}><span className="timeline-dot" /><div><h3>{item.title}</h3><p>{item.detail}</p></div><Badge>{item.status}</Badge></li>)}</ol>; }
export function Stepper({ steps, active = 0 }: { steps: string[]; active?: number }) { return <ol className="stepper">{steps.map((step, index) => <li key={step} aria-current={index === active ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol>; }
