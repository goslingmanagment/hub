// The operator's watchdog (plan §4.9): the operator touches its heartbeat
// file every second; an operator that has been up for 5 s and whose
// heartbeat is older than 5 s is hung — its control part, or all of it —
// and gets SIGKILL. Its proxy dies with it, so the exit closes; s6 starts a
// new operator, which learns about the paused requests from the holder.

export interface OperatorStatus {
  up: boolean;
  /** Seconds since the operator (re)started, as s6 counts. */
  upForS: number;
  pid: number | null;
}

export interface WatchdogInput {
  status: OperatorStatus;
  /** The heartbeat file's age in ms; null when there is no file. */
  heartbeatAgeMs: number | null;
  thresholdMs: number;
}

export function shouldKill(input: WatchdogInput): boolean {
  const { status, heartbeatAgeMs, thresholdMs } = input;
  if (!status.up || status.pid === null) return false;
  // A new operator has not had the time to beat yet.
  if (status.upForS * 1000 < thresholdMs) return false;
  return heartbeatAgeMs === null || heartbeatAgeMs > thresholdMs;
}

/** `s6-svstat -o up,pid,updownfor`: "true 123 42". */
export function parseStatus(line: string): OperatorStatus {
  const [up, pid, updownfor] = line.trim().split(/\s+/);
  const pidNumber = Number(pid);
  return { up: up === "true", pid: Number.isInteger(pidNumber) && pidNumber > 0 ? pidNumber : null, upForS: Number(updownfor) || 0 };
}
