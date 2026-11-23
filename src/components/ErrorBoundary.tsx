import React, { Component, type ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[Surround X][Error Boundary Caught]', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = window.location.pathname;
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#010a08] text-slate-100">
          <div className="glass-panel max-w-md w-full rounded-2xl p-6 sm:p-8 text-center flex flex-col items-center gap-4 border border-rose-500/30 shadow-2xl">
            <div className="w-12 h-12 rounded-2xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-300">
              <AlertCircle className="w-6 h-6" aria-hidden="true" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold text-white">Studio Recovery Mode</h2>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                {this.state.error?.message || 'An unexpected runtime error occurred in the audio processing pipeline.'}
              </p>
            </div>
            <button
              type="button"
              onClick={this.handleReset}
              className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cyan-500 text-[#021210] font-semibold text-xs hover:bg-cyan-400 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>Restart Studio</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
