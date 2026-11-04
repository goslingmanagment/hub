import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Going to another screen clears the error. */
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/** A broken screen does not take the menu with it: this sits inside `<main>`. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) this.setState({ hasError: false });
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
        <div role="alert" className="status-panel empty">
          <h1 className="empty-title">Не удалось открыть экран</h1>
          <p className="empty-text">Произошла ошибка интерфейса. Загрузите экран заново.</p>
          <div className="empty-actions">
            <button type="button" onClick={this.handleReload} className="btn btn-sm">
              Перезагрузить
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
