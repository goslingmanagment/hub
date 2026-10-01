export const API_TIMEOUT_MS: number;
export function githubApi(
  endpoint: string,
  options?: {
    env?: Readonly<Record<string, string | undefined>>;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    timeoutMs?: number;
  },
): Promise<unknown>;
