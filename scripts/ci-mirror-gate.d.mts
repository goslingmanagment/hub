/** Returns the endpoint's JSON, or a promise of it. */
export type GitHubReadApi = (endpoint: string) => unknown;
export type MirroredGate = { runId: string; url: string };
export type HeadState = { working: string[]; newest: { id: number; html_url?: string; conclusion?: string | null } | null };
export type MirrorOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  waitMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
};
export const GATE_CHECK_NAME: string;
export const FINGERPRINT_CHECK_NAME: string;
export const CI_WORKFLOW_PATH: string;
export const CHECK_RUNS_QUERY: string;
export const MIRROR_WAIT_MS: number;
export const MIRROR_POLL_MS: number;
export function runIdOf(checkRun: unknown): string;
export function readHead(options: {
  repo: string;
  headSha: string;
  currentRunId: string | undefined;
  api: GitHubReadApi;
}): Promise<HeadState>;
export function mirrorEarlierGate(
  env: Readonly<Record<string, string | undefined>>,
  api: GitHubReadApi,
  options?: MirrorOptions,
): Promise<MirroredGate>;
