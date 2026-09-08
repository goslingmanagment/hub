export class FanslyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
    readonly responseSnippet?: string,
    /** The provider's own `Retry-After` deadline from the terminal response,
     * absolute and unclamped (both header forms). The in-process loop can only
     * sleep up to `MAX_RETRY_DELAY_MS`, so a longer deadline travels here to
     * the durable retry (`classifyTaskFailure` → page-sync `retry_at`) rather
     * than being silently shortened. Diagnostic state on the throwable only:
     * it is not part of any client wire (`PersistedSyncError` allowlists the
     * ledger fields, and no SSE frame or incident reads it). */
    readonly retryAfterAt: Date | null = null,
  ) {
    super(message);
    this.name = "FanslyApiError";
  }
}

// W3.1 (decision #124): belt guard behind the page-context fail-closed check.
// The adapter refuses to build a direct dispatcher for platform traffic — a
// Fansly request without a proxy would ride the shared VPS IP (model-ban
// class risk). Deliberately NOT a FanslyApiError: no HTTP status, and the
// executor must classify it as a blocker, never a provider retry.
export class FanslyProxyMissingError extends Error {
  constructor(message = "Fansly egress requires the page's proxy; direct dispatch is refused (fail-closed)") {
    super(message);
    this.name = "FanslyProxyMissingError";
  }
}
