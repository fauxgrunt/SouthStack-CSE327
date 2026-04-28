import { Component, ErrorInfo, ReactNode } from "react";
import { logger } from "../utils/logger";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * ErrorBoundary - Catches React errors and displays fallback UI
 * Prevents entire app from crashing due to component errors
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error("React Error Boundary caught an error", error, {
      component: "ErrorBoundary",
      data: errorInfo,
    });
    if (typeof this.props.onError === "function") {
      try {
        this.props.onError(error);
      } catch (e) {
        // swallow errors from onError handler
      }
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 via-slate-900 to-gray-900 text-white flex items-center justify-center p-8">
          <div className="max-w-2xl w-full bg-slate-900/50 backdrop-blur-md rounded-lg p-8 border border-red-500/50 shadow-xl">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-red-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-red-400">
                  Something went wrong
                </h1>
                <p className="text-gray-400 mt-1">
                  An unexpected error occurred in the application
                </p>
              </div>
            </div>

            {this.state.error && (
              <div className="bg-gray-950/70 rounded-lg p-4 mb-6 font-mono text-sm">
                <div className="text-red-400 font-semibold mb-2">
                  Error Details:
                </div>
                <div className="text-gray-300 whitespace-pre-wrap break-all">
                  {this.state.error.message}
                </div>
                {this.state.error.stack && (
                  <details className="mt-4">
                    <summary className="text-gray-400 cursor-pointer hover:text-gray-300">
                      Stack Trace
                    </summary>
                    <pre className="text-xs text-gray-500 mt-2 overflow-auto max-h-48">
                      {this.state.error.stack}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <div className="flex gap-4">
              <button
                onClick={this.handleReset}
                className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-medium transition-colors"
              >
                Reload Application
              </button>
              <button
                onClick={() => window.history.back()}
                className="bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-lg font-medium transition-colors"
              >
                Go Back
              </button>
            </div>

            <div className="mt-6 p-4 bg-blue-900/20 border border-blue-500/30 rounded-lg">
              <p className="text-sm text-blue-300">
                <strong>Tip:</strong> If this error persists, try clearing your
                browser cache or using a different browser. For WebGPU-related
                errors, ensure you're using Chrome/Edge 113+.
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
