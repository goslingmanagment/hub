import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A screen that throws shows its fallback; the frame around it stays. A new
 * `resetKey` (the next address) tries the screen again without remounting it
 * when it did not fail: a screen's own state lives as long as its route.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode; resetKey?: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[workboard] экран упал", error, info.componentStack);
  }

  override componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
