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
