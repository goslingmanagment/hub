export class FanslyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
    readonly responseSnippet?: string,
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
