import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Sluice ErrorBoundary]', error, info)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b1120',
          padding: '24px',
          fontFamily: 'DM Sans, system-ui, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: '100%',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 16,
            padding: '32px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'rgba(239,68,68,0.15)',
                border: '1px solid rgba(239,68,68,0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div>
              <p style={{ color: '#ef4444', fontWeight: 600, margin: 0, fontSize: 15 }}>
                Something went wrong
              </p>
              <p style={{ color: '#94a3b8', fontSize: 12, margin: 0 }}>
                Sluice encountered an unexpected error
              </p>
            </div>
          </div>

          <pre
            style={{
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 8,
              padding: '12px 16px',
              color: '#fca5a5',
              fontSize: 12,
              lineHeight: 1.6,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: '0 0 20px',
              fontFamily: 'JetBrains Mono, Menlo, monospace',
            }}
          >
            {error.message}
          </pre>

          <button
            onClick={() => this.setState({ error: null })}
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              background: '#1e3a5f',
              border: '1px solid rgba(99,179,237,0.3)',
              color: '#e2e8f0',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}
