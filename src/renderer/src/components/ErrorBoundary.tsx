import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

/**
 * Catches renderer crashes and shows a recoverable fallback instead of a
 * blank white screen. The user can reload with Ctrl+R to attempt recovery.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] React render error:', error, info.componentStack)
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: undefined })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-[#0F0F0F] text-[#E8E8E8]">
          <div className="max-w-md text-center px-6">
            <div className="text-3xl mb-4">⚠️</div>
            <h1 className="text-lg font-semibold mb-2">Something went wrong</h1>
            <p className="text-sm text-[#888] mb-4 font-mono">
              {this.state.error?.message ?? 'The renderer encountered an unexpected error.'}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReload}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[#6B9FD4]/15 hover:bg-[#6B9FD4]/25 text-[#6B9FD4] transition-colors"
              >
                Reload (Ctrl+R)
              </button>
              <button
                onClick={this.handleReset}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[#2d2d2d] hover:bg-[#3f3f3f] text-[#b0b0b0] transition-colors"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
