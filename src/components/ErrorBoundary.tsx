import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * React Error Boundary for graceful failure handling.
 * Catches JavaScript errors in child components and displays fallback UI.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error)
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack)
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div style={{
          padding: 40,
          textAlign: 'center',
          color: '#ff6b6b',
          backgroundColor: '#1a1a1a',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center'
        }}>
          <h1 style={{ marginBottom: 16 }}>Something went wrong</h1>
          <p style={{ color: '#888', marginBottom: 24, maxWidth: 500 }}>
            The application encountered an unexpected error.
            You can try reloading or resetting the application state.
          </p>
          <pre style={{
            backgroundColor: '#2a2a2a',
            padding: 16,
            borderRadius: 8,
            maxWidth: '80%',
            overflow: 'auto',
            textAlign: 'left',
            fontSize: 12,
            marginBottom: 24
          }}>
            {this.state.error?.message || 'Unknown error'}
          </pre>
          <div style={{ display: 'flex', gap: 16 }}>
            <button onClick={this.handleReset}>
              Try Again
            </button>
            <button onClick={() => window.location.reload()}>
              Reload App
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
