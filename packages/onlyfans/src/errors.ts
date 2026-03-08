export class OnlyMonsterApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly responseSnippet?: string,
  ) {
    super(message);
    this.name = "OnlyMonsterApiError";
  }
}
