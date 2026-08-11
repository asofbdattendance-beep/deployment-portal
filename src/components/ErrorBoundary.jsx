import { Component } from 'react'
import { AlertTriangle } from 'lucide-react'

// Catches render errors anywhere below it so a single bad component can't
// white-screen the whole portal. Logs the error for debugging and offers a
// reload. Add a key to remount children after a crash if needed.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'Something went wrong' }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info)
  }

  handleReset = () => {
    this.setState({ hasError: false, message: '' })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f6f7fb', padding: '1rem' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '2rem', maxWidth: 420, textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.75rem' }}>
              <AlertTriangle size={28} style={{ color: '#b45309' }} />
            </div>
            <h1 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
            <p style={{ color: '#6b7280', fontSize: '0.9rem', marginBottom: '1.25rem' }}>
              {this.state.message}. Please try reloading the page.
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button onClick={this.handleReset} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                Try again
              </button>
              <button onClick={() => window.location.reload()} className="btn">
                Reload page
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
