import { Component, type ErrorInfo, type ReactNode } from "react";

/** A screen that throws shows its fallback; the frame around it stays. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[workboard] экран упал", error, info.componentStack);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
