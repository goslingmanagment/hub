type Job = { id?: number; name: string; status: string; conclusion: string; started_at?: string; completed_at?: string;
  steps?: { name: string; conclusion: string }[] };
export function summarizeRun(run: { id: number; name: string; html_url?: string; event: string;
  conclusion: string; run_attempt?: number }, jobs: Job[]): {
  mode: string; runner_minutes: number; cancelled_minutes: number; attempt: number;
};
export function summarizeAttempts(run: Parameters<typeof summarizeRun>[0], attempts: Job[][]): ReturnType<typeof summarizeRun> & {
  attempts: ReturnType<typeof summarizeRun>[];
};
