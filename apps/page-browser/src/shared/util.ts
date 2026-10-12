// Clock, log and environment helpers shared by the processes of the page
// container: the CDP holder, the operator and the watchdog.

import { scrub } from "./secrets.ts";

/** CLOCK_MONOTONIC in milliseconds (libuv's hrtime on Linux). Every process
 *  on the host reads the same clock, and Chrome's `timing.requestTime` (base
 *  TimeTicks, seconds) is on it too: admission deadlines are absolute values
 *  of this clock, never remainders (plan §4.2, step 4). */
export function monoMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function wallMs(): number {
  return Date.now();
}

export type LogFields = Record<string, unknown>;
export type Logger = (event: string, fields?: LogFields) => void;

let sink: (line: string) => void = (line) => {
  process.stdout.write(`${line}\n`);
};

/** Where log lines go (stdout; s6 hands it to the container's log). Tests
 *  capture it; null restores stdout. */
export function setLogSink(next: ((line: string) => void) | null): void {
  sink =
    next ??
    ((line) => {
      process.stdout.write(`${line}\n`);
    });
}

/** One JSON line per event. Never pass a secret in `fields`: a registered one
 *  is cut out of the line anyway (shared/secrets.ts). */
export function makeLog(component: string): Logger {
  return (event, fields) => {
    const line = JSON.stringify({ t: new Date().toISOString(), mono: Math.round(monoMs()), c: component, e: event, ...fields });
    sink(scrub(line));
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What of a URL may be logged or journaled: an HTTP(S) or WS(S) URL's
 *  scheme, host, port and path — never its credentials, query or fragment,
 *  where tokens travel — and of any other URL only its scheme (a `data:` URL
 *  is its own payload). */
export function urlForLog(url: string): { scheme: string; host: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { scheme: "", host: "", path: "" };
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!["http", "https", "ws", "wss"].includes(scheme)) return { scheme, host: "", path: "" };
  return { scheme, host: parsed.host.toLowerCase(), path: parsed.pathname };
}

/** urlForLog as one string: "https://host/path", or "data:" for the rest. */
export function urlForLogLine(url: string): string {
  const { scheme, host, path } = urlForLog(url);
  if (scheme === "") return "";
  return host === "" ? `${scheme}:` : `${scheme}://${host}${path}`;
}
