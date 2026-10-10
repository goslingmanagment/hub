// Fault injection: armed through `POST /faults`, consumed by the listeners.
// Each fault applies to the next matching event(s) of its kind and is removed
// once its count is used up (count -1 = until cleared).

export const FAULT_KINDS = [
  // TCP/TLS front (:443), per connection; tlsStall may match by SNI host.
  "tcpDelay",
  "tlsStall",
  // HTTP requests (h1 and h2); match by host / pathPrefix / rid / method.
  "h1_408_on_reuse",
  "h2RefusedStream",
  "h2Goaway",
  "resetAfterHeaders",
  "delayResponse",
  "closeAfterResponse",
  // SOCKS5 (:1080); socksConnectDelay and socksRefuse may match by host.
  "socksConnectDelay",
  "socksAuthFail",
  "socksRefuse",
  // Toggles, applied at once and never stored.
  "socksDown",
  "socksUp",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

/** Kinds that need `ms`. */
const DELAY_KINDS = new Set<FaultKind>(["tcpDelay", "tlsStall", "delayResponse", "socksConnectDelay"]);
export const TOGGLE_KINDS = new Set<FaultKind>(["socksDown", "socksUp"]);

/**
 * Match fields each kind can see when it is applied. A field the event cannot
 * offer would never match, so it is rejected up front instead.
 */
const MATCHABLE: Record<FaultKind, ReadonlyArray<keyof FaultMatch>> = {
  tcpDelay: [], // before TLS: nothing known yet
  tlsStall: ["host"], // SNI from the ClientHello
  h1_408_on_reuse: ["host", "pathPrefix", "rid", "method"],
  h2RefusedStream: ["host", "pathPrefix", "rid", "method"],
  h2Goaway: ["host", "pathPrefix", "rid", "method"],
  resetAfterHeaders: ["host", "pathPrefix", "rid", "method"],
  delayResponse: ["host", "pathPrefix", "rid", "method"],
  closeAfterResponse: ["host", "pathPrefix", "rid", "method"],
  socksConnectDelay: ["host"], // the CONNECT target
  socksAuthFail: [], // auth precedes CONNECT
  socksRefuse: ["host"],
  socksDown: [],
  socksUp: [],
};

export interface FaultMatch {
  /** Host without port, case-insensitive: :authority/Host, SNI, or the SOCKS target. */
  host?: string;
  /** Prefix of the request target (path + query). */
  pathPrefix?: string;
  /** Exact value of the `rid` query parameter. */
  rid?: string;
  /** HTTP method, case-insensitive. */
  method?: string;
}

export interface Fault {
  id: string;
  kind: FaultKind;
  match: FaultMatch;
  /** Applications left; -1 = until cleared. */
  count: number;
  ms: number | null;
  code: number | null;
  /** How many times it has been applied so far. */
  hits: number;
}

/** What an event offers for matching; absent fields never match a constraint. */
export interface FaultContext {
  host?: string | null;
  path?: string | null;
  rid?: string | null;
  method?: string | null;
}

export interface FaultSpec {
  kind: FaultKind;
  match: FaultMatch;
  count: number;
  ms: number | null;
  code: number | null;
}

/** Validate a `POST /faults` body; throws an Error with a readable message. */
export function parseFaultSpec(body: unknown): FaultSpec {
  if (typeof body !== "object" || body === null) throw new Error("body must be a JSON object");
  const raw = body as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string" || !(FAULT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of ${FAULT_KINDS.join(", ")}`);
  }
  const match: FaultMatch = {};
  if (raw.match !== undefined && raw.match !== null) {
    if (typeof raw.match !== "object") throw new Error("match must be an object");
    for (const [key, value] of Object.entries(raw.match as Record<string, unknown>)) {
      if (key !== "host" && key !== "pathPrefix" && key !== "rid" && key !== "method") {
        throw new Error(`unknown match field ${key}`);
      }
      if (typeof value !== "string") throw new Error(`match.${key} must be a string`);
      if (!MATCHABLE[kind as FaultKind].includes(key)) {
        const allowed = MATCHABLE[kind as FaultKind];
        throw new Error(`${kind} cannot match by ${key} (${allowed.length ? `only ${allowed.join(", ")}` : "no match fields"})`);
      }
      match[key] = value;
    }
  }
  const count = raw.count === undefined ? 1 : raw.count;
  if (typeof count !== "number" || !Number.isInteger(count) || (count < 1 && count !== -1)) {
    throw new Error("count must be a positive integer or -1");
  }
  let ms: number | null = null;
  if (raw.ms !== undefined) {
    if (typeof raw.ms !== "number" || !Number.isFinite(raw.ms) || raw.ms < 0) throw new Error("ms must be a number ≥ 0");
    ms = raw.ms;
  } else if (DELAY_KINDS.has(kind as FaultKind)) {
    throw new Error(`${kind} needs ms`);
  }
  let code: number | null = null;
  if (raw.code !== undefined) {
    if (typeof raw.code !== "number" || !Number.isInteger(raw.code) || raw.code < 0) throw new Error("code must be an integer ≥ 0");
    code = raw.code;
  }
  return { kind: kind as FaultKind, match, count, ms, code };
}

export class FaultStore {
  #faults: Fault[] = [];
  #nextId = 1;

  add(spec: FaultSpec): Fault {
    const fault: Fault = { id: `f${this.#nextId++}`, hits: 0, ...spec };
    this.#faults.push(fault);
    return { ...fault };
  }

  list(): Fault[] {
    return this.#faults.map((fault) => ({ ...fault }));
  }

  clear(): number {
    const n = this.#faults.length;
    this.#faults = [];
    return n;
  }

  remove(id: string): boolean {
    const before = this.#faults.length;
    this.#faults = this.#faults.filter((fault) => fault.id !== id);
    return this.#faults.length !== before;
  }

  /**
   * Consume the oldest armed fault of `kind` that matches `ctx`: count it as
   * applied, drop it when used up, and return a snapshot (or null).
   */
  take(kind: FaultKind, ctx: FaultContext): Fault | null {
    const index = this.#faults.findIndex((fault) => fault.kind === kind && matches(fault.match, ctx));
    if (index < 0) return null;
    const fault = this.#faults[index]!;
    fault.hits += 1;
    if (fault.count > 0) {
      fault.count -= 1;
      if (fault.count === 0) this.#faults.splice(index, 1);
    }
    return { ...fault };
  }
}

function matches(match: FaultMatch, ctx: FaultContext): boolean {
  if (match.host !== undefined && !sameHost(match.host, ctx.host)) return false;
  if (match.pathPrefix !== undefined && !ctx.path?.startsWith(match.pathPrefix)) return false;
  if (match.rid !== undefined && ctx.rid !== match.rid) return false;
  if (match.method !== undefined && (ctx.method ?? "").toUpperCase() !== match.method.toUpperCase()) return false;
  return true;
}

function sameHost(want: string, got: string | null | undefined): boolean {
  if (!got) return false;
  return want.toLowerCase().replace(/\.$/, "") === got.toLowerCase().replace(/\.$/, "");
}
