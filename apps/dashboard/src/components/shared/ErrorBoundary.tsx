import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
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

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center p-6">
          <div role="alert" className="max-w-sm rounded-xl border border-border bg-card p-6 text-center">
            <h1 className="text-lg font-bold text-text-primary">Не удалось открыть страницу</h1>
            <p className="mt-2 text-sm text-text-muted">
              Произошла ошибка интерфейса. Попробуйте загрузить страницу заново.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90"
            >
              Перезагрузить
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
