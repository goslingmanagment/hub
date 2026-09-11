import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  inset?: boolean;
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error rendering dashboard:", error, info);
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className={`flex ${this.props.inset ? "min-h-[240px]" : "min-h-screen"} items-center justify-center p-6`}>
          <div className="max-w-sm rounded-xl border border-border bg-card p-6 text-center">
            <h1 className="text-lg font-bold text-text-primary">Не удалось открыть раздел</h1>
            <p className="mt-2 text-sm text-text-muted">
              Попробуйте обновить страницу{this.props.inset ? " или откройте другой раздел через меню" : ""}.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90"
            >
              Обновить страницу
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
