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
