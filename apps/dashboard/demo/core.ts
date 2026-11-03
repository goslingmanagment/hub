/**
 * The dashboard's demo mode: the console without a hub behind it.
 *
 * `pnpm dev:demo` serves the dashboard with every API call answered from
 * the fixtures in `demo/fixtures/` — an invented agency, its models, pages,
 * fans and team. Nothing here is real data and nothing leaves the machine.
 *
 * A fixture is typed by its operation's response (`KernelOperationResponse`),
 * so `pnpm --dir apps/dashboard typecheck:demo` holds it to the contract,
 * and the demo server validates every answer against the route's schema at
 * run time as well — a stale fixture shows up as a console warning and a
 * failed request, never as a silently wrong screen.
 */
import type { KernelOperationKey, KernelOperationResponse } from "@agency_hub_core/contracts";

export type DemoRole = "owner" | "team_lead" | "chatter";

export interface DemoRequest {
  /** Path parameters, decoded. */
  params: Record<string, string>;
  /** Query parameters; a repeated key becomes an array. */
  query: Record<string, string | string[]>;
  /** The parsed JSON body of a write, or null. */
  body: unknown;
  /** The moment the request arrived: every date in a fixture is relative to it. */
  now: Date;
  /** Whom the demo console shows: switch with /__demo/role?as=team_lead. */
  role: DemoRole;
}

/** An answer with a status other than 200 (an error, a 201, an empty 204).
 *  Recognised by its brand, not by `instanceof`: the server loads the fixtures
 *  through Vite's module graph, so this class exists there twice. */
export class DemoReply {
  readonly demoReply = true;
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export function isDemoReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

export type DemoHandler<K extends KernelOperationKey> = (
  request: DemoRequest,
) => KernelOperationResponse<K> | DemoReply;

export type DemoHandlers = { [K in KernelOperationKey]?: DemoHandler<K> };

/** An error body in the hub's shape (`errorResponseSchema`). */
export function demoError(statusCode: number, error: string, message: string): DemoReply {
  return new DemoReply(statusCode, { error, message, statusCode });
}

export function queryString(request: DemoRequest, key: string): string | undefined {
  const value = request.query[key];
  return Array.isArray(value) ? value[0] : value;
}

export function queryNumber(request: DemoRequest, key: string, fallback: number): number {
  const value = Number(queryString(request, key));
  return Number.isFinite(value) ? value : fallback;
}

// --- Deterministic randomness: the same screen shows the same numbers on
// every reload, and two screens about the same fan agree. ---

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32, seeded by a string. */
export function rng(seed: string): () => number {
  let state = hashString(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function between(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

export function intBetween(random: () => number, min: number, max: number): number {
  return Math.floor(between(random, min, max + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("demo: pick from an empty list");
  return item;
}

/** A heavy-tailed amount: most fans spend little, a few spend a lot. */
export function spendTail(random: () => number, median: number, spread = 1.1): number {
  const normal = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  return Math.max(0, median * Math.exp(normal * spread));
}

// --- Money and time ---

/** Dollars to the wire's integer mills ($0.001). */
export function mills(dollars: number): number {
  return Math.round(dollars * 1000);
}

/** Dollars to micro-USD (AI spend). */
export function microUsd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgo(now: Date, days: number, hourUtc?: number): Date {
  const date = new Date(now.getTime() - days * DAY_MS);
  if (hourUtc !== undefined) date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

export function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export function iso(date: Date): string {
  return date.toISOString();
}

/** YYYY-MM-DD of a date in UTC. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The last `count` days, oldest first, as UTC YYYY-MM-DD. */
export function lastDays(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, index) => isoDay(daysAgo(now, count - 1 - index)));
}

/** Days in a console period ("today" | "7d" | "30d" | "90d" | "180d" | "all"). */
export function periodDays(period: string | undefined, fallback = 7): number {
  switch (period) {
    case "today": return 1;
    case "7d": return 7;
    case "30d": return 30;
    case "90d": return 90;
    case "180d": return 180;
    case "all": return 365;
    default: return fallback;
  }
}
