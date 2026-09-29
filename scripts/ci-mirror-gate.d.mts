/** Returns the endpoint's JSON, or a promise of it. */
export type CheckRunsApi = (endpoint: string) => unknown;
export type MirroredGate = { runId: string; url: string };
export const GATE_CHECK_NAME: string;
export const CHECK_RUNS_QUERY: string;
export function runIdOf(checkRun: unknown): string;
export function findEarlierGate(options: {
  repo: string;
  headSha: string;
  currentRunId: string | undefined;
  api: CheckRunsApi;
}): Promise<MirroredGate | null>;
export function mirrorEarlierGate(
  env: Readonly<Record<string, string | undefined>>,
  api: CheckRunsApi,
): Promise<MirroredGate>;
