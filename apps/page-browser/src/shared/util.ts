// Clock and log helpers shared by the processes of the page container.

/** CLOCK_MONOTONIC in milliseconds (libuv's hrtime on Linux). Every process
 *  on the host reads the same clock, and Chrome's `timing.requestTime` (base
 *  TimeTicks, seconds) is on it too: admission deadlines are absolute values
 *  of this clock. */
export function monoMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export type LogFields = Record<string, unknown>;

/** One JSON line per event on stdout. Never pass secrets in `fields`. */
export function makeLog(component: string): (event: string, fields?: LogFields) => void {
  return (event, fields) => {
    const line = JSON.stringify({ t: new Date().toISOString(), mono: Math.round(monoMs() * 1000) / 1000, c: component, e: event, ...fields });
    process.stdout.write(`${line}\n`);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got ${raw})`);
  return value;
}

export function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}
