'use client';
import { WalletControl as ConnectKitButton } from './web/components/wallet-control'
import { useAccount } from 'wagmi'
import { AlertTriangle, Wallet, Database, Activity, Shield, Zap, ExternalLink } from 'lucide-react'
import { ErrorBoundary } from './components/ErrorBoundary'
import {
  CHAIN_NAME,
  FACTORY_ADDRESS,
  FACTORY_CONFIGURED,
  USDC_ADDRESS,
  CONFIG_WARNINGS,
  shortenAddress,
  buildExplorerAddressUrl,
} from './sluice-config'

// ─── Top-level app wrapped in error boundary ────────────────────────────────

export default function App() {
  return (
    <ErrorBoundary>
      <SluiceDashboard />
    </ErrorBoundary>
  )
}

// ─── Fonts ───────────────────────────────────────────────────────────────────

const FONT_LINK = null

// ─── Dashboard ───────────────────────────────────────────────────────────────

function SluiceDashboard() {
  const { address, isConnected } = useAccount()

  return (
    <>
      {FONT_LINK}
      <div
        className="min-h-dvh"
        style={{
          background: 'linear-gradient(135deg, #070d1a 0%, #0b1120 60%, #0d1528 100%)',
          fontFamily: "'DM Sans', system-ui, sans-serif",
          color: '#e2e8f0',
        }}
      >
        {/* ── Topbar ── */}
        <header
          style={{
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            background: 'rgba(11,17,32,0.8)',
            backdropFilter: 'blur(12px)',
            position: 'sticky',
            top: 0,
            zIndex: 50,
          }}
        >
          <div
            style={{
              maxWidth: 1200,
              margin: '0 auto',
              padding: '0 24px',
              height: 60,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            {/* Logo */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, #1e40af, #3b82f6)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Zap size={16} color="#fff" strokeWidth={2.5} />
              </div>
              <span
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 700,
                  fontSize: 18,
                  letterSpacing: '-0.02em',
                  color: '#f1f5f9',
                }}
              >
                Sluice
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#3b82f6',
                  background: 'rgba(59,130,246,0.12)',
                  border: '1px solid rgba(59,130,246,0.25)',
                  borderRadius: 4,
                  padding: '2px 6px',
                }}
              >
                AgentPay
              </span>
            </div>

            {/* Chain pill + connect */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#64748b',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 20,
                  padding: '4px 10px',
                }}
              >
                {CHAIN_NAME}
              </div>
              <ConnectKitButton />
            </div>
          </div>
        </header>

        {/* ── Config warnings ── */}
        {CONFIG_WARNINGS.length > 0 && (
          <div
            style={{
              background: 'rgba(245,158,11,0.08)',
              borderBottom: '1px solid rgba(245,158,11,0.2)',
            }}
          >
            <div
              style={{
                maxWidth: 1200,
                margin: '0 auto',
                padding: '10px 24px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <AlertTriangle size={14} color="#f59e0b" />
              <span style={{ fontSize: 13, color: '#fbbf24', fontWeight: 500 }}>
                Dashboard running in read-only mode.
              </span>
              {CONFIG_WARNINGS.map((w) => (
                <code
                  key={w}
                  style={{
                    fontSize: 12,
                    color: '#fcd34d',
                    background: 'rgba(245,158,11,0.12)',
                    border: '1px solid rgba(245,158,11,0.25)',
                    borderRadius: 4,
                    padding: '1px 6px',
                    fontFamily: "'JetBrains Mono', Menlo, monospace",
                  }}
                >
                  Missing config: {w}
                </code>
              ))}
            </div>
          </div>
        )}

        {/* ── Main content ── */}
        <main style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px' }}>
          {isConnected && address ? (
            <ConnectedView address={address} />
          ) : (
            <DisconnectedView />
          )}
        </main>
      </div>
    </>
  )
}

// ─── Disconnected state ───────────────────────────────────────────────────────

function DisconnectedView() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100dvh - 120px)',
        textAlign: 'center',
        gap: 0,
      }}
    >
      {/* Hero */}
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          background: 'linear-gradient(135deg, rgba(30,64,175,0.4), rgba(59,130,246,0.2))',
          border: '1px solid rgba(59,130,246,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 24,
        }}
      >
        <Wallet size={32} color="#60a5fa" />
      </div>

      <h1
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: '-0.03em',
          color: '#f1f5f9',
          margin: '0 0 12px',
        }}
      >
        Connect your wallet
      </h1>
      <p
        style={{
          fontSize: 16,
          color: '#64748b',
          maxWidth: 400,
          lineHeight: 1.6,
          margin: '0 0 36px',
        }}
      >
        View agent wallets, manage budgets, track settlements, and monitor protocol activity.
      </p>

      <ConnectKitButton />

      {/* Feature pills */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          marginTop: 48,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        {[
          { icon: <Database size={13} />, label: 'Budget management' },
          { icon: <Activity size={13} />, label: 'Settlement history' },
          { icon: <Shield size={13} />, label: 'Signer rotation' },
        ].map(({ icon, label }) => (
          <div
            key={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 20,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 12,
              color: '#94a3b8',
            }}
          >
            <span style={{ color: '#60a5fa' }}>{icon}</span>
            {label}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Connected state ──────────────────────────────────────────────────────────

function ConnectedView({ address }: { address: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Page header */}
      <div>
        <h2
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: '#f1f5f9',
            margin: '0 0 4px',
          }}
        >
          Dashboard
        </h2>
        <p style={{ fontSize: 14, color: '#64748b', margin: 0 }}>
          Connected as{' '}
          <code
            style={{
              fontFamily: "'JetBrains Mono', Menlo, monospace",
              fontSize: 13,
              color: '#93c5fd',
            }}
          >
            {shortenAddress(address)}
          </code>
        </p>
      </div>

      {/* Protocol info cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16,
        }}
      >
        <InfoCard
          label="Factory Contract"
          icon={<Database size={15} color="#60a5fa" />}
          status={FACTORY_CONFIGURED ? 'live' : 'missing'}
        >
          {FACTORY_CONFIGURED && FACTORY_ADDRESS ? (
            <a
              href={buildExplorerAddressUrl(FACTORY_ADDRESS)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: '#60a5fa',
                textDecoration: 'none',
                fontFamily: "'JetBrains Mono', Menlo, monospace",
                fontSize: 13,
              }}
            >
              {shortenAddress(FACTORY_ADDRESS)}
              <ExternalLink size={11} />
            </a>
          ) : (
            <span style={{ color: '#f59e0b', fontSize: 13 }}>
              Set NEXT_PUBLIC_FACTORY_ADDRESS to enable
            </span>
          )}
        </InfoCard>

        <InfoCard
          label="USDC Token"
          icon={<Zap size={15} color="#60a5fa" />}
          status={USDC_ADDRESS ? 'live' : 'missing'}
        >
          {USDC_ADDRESS ? (
            <a
              href={buildExplorerAddressUrl(USDC_ADDRESS)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: '#60a5fa',
                textDecoration: 'none',
                fontFamily: "'JetBrains Mono', Menlo, monospace",
                fontSize: 13,
              }}
            >
              {shortenAddress(USDC_ADDRESS)}
              <ExternalLink size={11} />
            </a>
          ) : (
            <span style={{ color: '#ef4444', fontSize: 13 }}>Not available on this chain</span>
          )}
        </InfoCard>

        <InfoCard
          label="Network"
          icon={<Activity size={15} color="#60a5fa" />}
          status="live"
        >
          <span style={{ fontSize: 13, color: '#94a3b8' }}>{CHAIN_NAME}</span>
        </InfoCard>
      </div>

      {/* Role panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <RolePanel
          title="Agent Owner"
          description="Manage your agent wallet: deposit USDC, set provider budgets, rotate signer keys, and monitor daily spend."
          icon={<Shield size={18} color="#60a5fa" />}
          actions={['Deposit / Withdraw', 'Set Provider Budget', 'Pause / Rotate Signer', 'View Activity']}
          disabled={!FACTORY_CONFIGURED}
          disabledReason="Factory address required"
        />
        <RolePanel
          title="Provider"
          description="Track revenue, view unsettled exposure, inspect settlement history, and generate integration snippets."
          icon={<Activity size={18} color="#a78bfa" />}
          accentColor="#7c3aed"
          actions={['Revenue Overview', 'Unsettled Exposure', 'Settlement History', 'Integration Snippet']}
          disabled={!FACTORY_CONFIGURED}
          disabledReason="Factory address required"
        />
      </div>

      {/* Deploy prompt when factory not configured */}
      {!FACTORY_CONFIGURED && (
        <div
          style={{
            background: 'rgba(30,64,175,0.08)',
            border: '1px solid rgba(59,130,246,0.2)',
            borderRadius: 12,
            padding: '20px 24px',
            display: 'flex',
            gap: 16,
            alignItems: 'flex-start',
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: 'rgba(59,130,246,0.15)',
              border: '1px solid rgba(59,130,246,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Database size={16} color="#60a5fa" />
          </div>
          <div>
            <p
              style={{
                fontWeight: 600,
                color: '#93c5fd',
                fontSize: 14,
                margin: '0 0 6px',
              }}
            >
              Deploy AgentWalletFactory to get started
            </p>
            <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 12px', lineHeight: 1.6 }}>
              Run the deploy script, then set <code style={{ fontFamily: 'monospace', color: '#93c5fd' }}>NEXT_PUBLIC_FACTORY_ADDRESS</code> in your{' '}
              <code style={{ fontFamily: 'monospace', color: '#93c5fd' }}>.env</code> file to enable full dashboard functionality.
            </p>
            <code
              style={{
                display: 'block',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 12,
                color: '#7dd3fc',
                fontFamily: "'JetBrains Mono', Menlo, monospace",
                lineHeight: 1.7,
              }}
            >
              forge script contracts/script/Deploy.s.sol \<br />
              {'  '}--rpc-url $RPC_URL --broadcast
            </code>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared card components ───────────────────────────────────────────────────

function InfoCard({
  label,
  icon,
  status,
  children,
}: {
  label: string
  icon: React.ReactNode
  status: 'live' | 'missing'
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: '16px 20px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {icon}
          <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {label}
          </span>
        </div>
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: status === 'live' ? '#22c55e' : '#f59e0b',
            boxShadow: `0 0 6px ${status === 'live' ? '#22c55e' : '#f59e0b'}66`,
          }}
        />
      </div>
      {children}
    </div>
  )
}

function RolePanel({
  title,
  description,
  icon,
  actions,
  accentColor = '#1d4ed8',
  disabled,
  disabledReason,
}: {
  title: string
  description: string
  icon: React.ReactNode
  actions: string[]
  accentColor?: string
  disabled?: boolean
  disabledReason?: string
}) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: '20px',
        opacity: disabled ? 0.7 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: `${accentColor}1a`,
            border: `1px solid ${accentColor}44`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </div>
        <span
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 600,
            fontSize: 16,
            color: '#f1f5f9',
          }}
        >
          {title}
        </span>
      </div>

      <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.6, margin: '0 0 16px' }}>
        {description}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {actions.map((action) => (
          <div
            key={action}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
              fontSize: 13,
              color: disabled ? '#475569' : '#94a3b8',
              cursor: disabled ? 'not-allowed' : 'default',
            }}
          >
            <span>{action}</span>
            {disabled ? (
              <span style={{ fontSize: 11, color: '#f59e0b' }}>{disabledReason}</span>
            ) : (
              <span style={{ fontSize: 11, color: '#334155' }}>Coming soon</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
