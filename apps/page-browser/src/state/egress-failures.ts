// The exit's refusals, counted for Hub (`state.egressFailures`): what an
// audit could find only by going through the connection journal by hand.
//
// - The page's SOCKS5 failing a tunnel (egress/socks5.ts): by how (`kind`), at
//   which step of its exchange, its reply (REP; null: none) and the class of
//   the host the tunnel was for.
// - The rules extension blocking a request (net::ERR_BLOCKED_BY_CLIENT): by the
//   class of its host, the self-test's own probes apart (they are blocked on
//   purpose).
//
// Counted since the operator started (`sinceWall`); each entry keeps its last
// instant and host. A host is no secret (the journal keeps it too); nothing of
// a request but its host is kept. Every key is of a closed vocabulary; at
// most `EGRESS_FAILURE_ENTRIES_MAX` entries a list all the same — a new one
// past that is not counted.

import { EGRESS_FAILURE_ENTRIES_MAX, type EgressFailures, type EgressHostClass, type SocksFailureKind, type SocksStep } from "../rpc/protocol.ts";
import type { HostClass } from "../egress/hosts.ts";

// The protocol's classes are the map's (policy/operations.ts).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const SAME_CLASSES: Same<HostClass, EgressHostClass> = true;
void SAME_CLASSES;

/** A host as it is kept: at most 255 characters. */
const HOST_MAX = 255;

interface Counted {
  count: number;
  lastAtWall: number;
  lastHost: string;
}

export class EgressFailureCounts {
  readonly #sinceWall: number;
  readonly #now: () => number;
  readonly #socks = new Map<string, EgressFailures["socks"][number]>();
  readonly #dnr = new Map<string, EgressFailures["dnr"][number]>();

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#sinceWall = this.#now();
  }

  /** The page's SOCKS5 failed a tunnel to `host`. */
  socks(failure: { kind: SocksFailureKind; step: SocksStep; rep: number | null; cls: HostClass; host: string }): void {
    const rep = failure.rep !== null && Number.isInteger(failure.rep) && failure.rep >= 1 && failure.rep <= 255 ? failure.rep : null;
    this.#count(this.#socks, `${failure.kind}|${failure.step}|${rep ?? ""}|${failure.cls}`, { kind: failure.kind, step: failure.step, rep, cls: failure.cls }, failure.host);
  }

  /** The rules extension blocked a request to `host`; `probe`: the
   *  self-test's own. */
  dnr(failure: { cls: HostClass; probe: boolean; host: string }): void {
    this.#count(this.#dnr, `${failure.cls}|${failure.probe}`, { cls: failure.cls, probe: failure.probe }, failure.host);
  }

  snapshot(): EgressFailures {
    return { sinceWall: this.#sinceWall, socks: [...this.#socks.values()].map((e) => ({ ...e })), dnr: [...this.#dnr.values()].map((e) => ({ ...e })) };
  }

  #count<E extends Counted>(map: Map<string, E>, key: string, made: Omit<E, keyof Counted>, host: string): void {
    const lastAtWall = this.#now();
    const lastHost = host.slice(0, HOST_MAX);
    const found = map.get(key);
    if (found !== undefined) {
      found.count += 1;
      found.lastAtWall = lastAtWall;
      found.lastHost = lastHost;
    } else if (map.size < EGRESS_FAILURE_ENTRIES_MAX) {
      map.set(key, { ...made, count: 1, lastAtWall, lastHost } as E);
    }
  }
}
