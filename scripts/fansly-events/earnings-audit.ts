import {
  FANSLY_EARNINGS_CANONICALIZER_VERSION, parseFanslyEarningsObservation,
} from "../../apps/runtime/src/services/canonicalize/fansly-earnings.ts";
import { compareEarnings, projectorCaughtUp } from "./earnings-audit-compare.ts";
import {
  earningsAuditPageSchema, earningsAuditScopeSchema, earningsKey, timestampMicros,
  type EarningsAuditScope, type EarningsObservation, type EarningsProjection,
  type ExpectedEarnings,
} from "./earnings-audit-types.ts";

const MAX_KEYS = 200_000;
const MAX_SAMPLES = 100;

export class EarningsAudit {
  readonly scope: EarningsAuditScope;
  private readonly expected = new Map<string, ExpectedEarnings>();
  private readonly outcomes: Record<string, number> = {};
  private readonly observations: Record<string, number> = {};
  private readonly samples: Array<{
    outcome: string; expected?: ExpectedEarnings; actual?: EarningsProjection; differences?: string[];
  }> = [];
  private observationCount = 0;
  private projectionCount = 0;
  private legacySources = 0;
  private parseDebt = 0;
  private observationsDone = false;
  private projectionDone = false;
  private observationCursor: { receivedAt: string | null; id: string } = { receivedAt: null, id: "0" };
  private projectionCursor = { fanId: "0", window: "" };

  constructor(scope: unknown) {
    this.scope = earningsAuditScopeSchema.parse(scope);
  }

  accept(input: unknown) {
    const page = earningsAuditPageSchema.parse(input);
    if (JSON.stringify(page.scope) !== JSON.stringify(this.scope)) {
      throw new Error("Earnings audit pages belong to different scopes or snapshots");
    }
    if (page.rows.length === 0 && !page.exhausted) throw new Error("Empty nonterminal audit page");
    if (page.operation === "observations") {
      if (this.observationsDone || JSON.stringify(page.after) !== JSON.stringify(this.observationCursor)) {
        throw new Error("Discontinuous earnings observation pages");
      }
      for (const row of page.rows) {
        const prior = this.observationCursor;
        if (prior.receivedAt !== null && (
          timestampMicros(row.receivedAt) < timestampMicros(prior.receivedAt)
          || (timestampMicros(row.receivedAt) === timestampMicros(prior.receivedAt)
            && BigInt(row.id) <= BigInt(prior.id)))) {
          throw new Error("Unordered earnings observations");
        }
        if (BigInt(row.id) > BigInt(this.scope.upperObservationId)
          || timestampMicros(row.receivedAt) < timestampMicros(this.scope.from)
          || timestampMicros(row.receivedAt) >= timestampMicros(this.scope.to)) {
          throw new Error("Earnings observation outside the frozen cohort");
        }
        this.observe(row);
        this.observationCursor = { receivedAt: row.receivedAt, id: row.id };
      }
      this.checkNext(page.next, page.rows.length === 0 ? null : this.observationCursor);
      this.observationsDone = page.exhausted;
    } else {
      if (!this.observationsDone || this.projectionDone
        || JSON.stringify(page.after) !== JSON.stringify(this.projectionCursor)) {
        throw new Error("Discontinuous earnings projection pages");
      }
      for (const row of page.rows) {
        const prior = this.projectionCursor;
        if (BigInt(row.fanId) < BigInt(prior.fanId)
          || (row.fanId === prior.fanId && row.window <= prior.window)
          || BigInt(row.id) > BigInt(this.scope.upperProjectionId)) {
          throw new Error("Unordered earnings projection");
        }
        this.compare(row);
        this.projectionCursor = { fanId: row.fanId, window: row.window };
      }
      this.checkNext(page.next, page.rows.length === 0 ? null : this.projectionCursor);
      this.projectionDone = page.exhausted;
    }
  }

  private checkNext(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Earnings audit cursor does not match its final row");
    }
  }

  private observe(row: EarningsObservation) {
    this.observationCount += 1;
    if (row.parseVersion !== FANSLY_EARNINGS_CANONICALIZER_VERSION) this.parseDebt += 1;
    if (row.status !== "available") {
      this.count(this.observations, row.status);
      return;
    }
    const parsed = parseFanslyEarningsObservation({
      id: Number(row.id), accountId: Number(this.scope.accountId), platform: "fansly",
      source: "pull", producer: "audit", kind: row.kind, payload: row.payload,
      receivedAt: new Date(row.receivedAt), observedAt: row.observedAt ? new Date(row.observedAt) : null,
    });
    if (parsed.rejection) {
      this.count(this.observations, parsed.rejection.code);
      return;
    }
    this.count(this.observations, parsed.events.length === 0 ? "empty" : "valid");
    for (const event of parsed.events) {
      const fan = event.fanIdentityRef;
      const window = event.data.window;
      if (!fan || typeof window !== "string") throw new Error("Unexpected earnings parser output");
      const key = earningsKey(fan, window);
      const candidate: ExpectedEarnings = {
        fan, window, grossMills: String(event.data.grossMills), netMills: String(event.data.netMills),
        observedAt: event.occurredAt.toISOString(), observationId: row.id,
      };
      const previous = this.expected.get(key);
      if (!previous || candidate.observedAt > previous.observedAt
        || (candidate.observedAt === previous.observedAt
          && BigInt(candidate.observationId) > BigInt(previous.observationId))) {
        this.expected.set(key, candidate);
      }
      if (this.expected.size > MAX_KEYS) throw new Error("Earnings audit key limit exceeded");
    }
  }

  private compare(actual: EarningsProjection) {
    this.projectionCount += 1;
    const key = actual.fan === null ? null : earningsKey(actual.fan, actual.window);
    const expected = key === null ? undefined : this.expected.get(key);
    if (key !== null) this.expected.delete(key);
    const { outcome, differences, legacy } = compareEarnings(this.scope, actual, expected);
    if (legacy) this.legacySources += 1;
    this.count(this.outcomes, outcome);
    if (outcome !== "matched" && this.samples.length < MAX_SAMPLES) {
      this.samples.push({ outcome, ...(expected ? { expected } : {}), actual, differences });
    }
  }

  private count(target: Record<string, number>, name: string) {
    target[name] = (target[name] ?? 0) + 1;
  }

  report() {
    if (!this.observationsDone || !this.projectionDone
      || this.observationCount !== Number(this.scope.observationCount)
      || this.projectionCount !== Number(this.scope.projectionCount)) {
      throw new Error("Earnings audit export is incomplete");
    }
    const outcomes = { ...this.outcomes };
    const samples = [...this.samples];
    const missing = projectorCaughtUp(this.scope) ? "missing" : "projection_pending";
    for (const expected of this.expected.values()) {
      this.count(outcomes, missing);
      if (samples.length < MAX_SAMPLES) samples.push({ outcome: missing, expected });
    }
    const unknownObservations = Object.entries(this.observations)
      .filter(([key]) => key !== "empty" && key !== "valid")
      .reduce((total, [, count]) => total + count, 0);
    return {
      scope: this.scope, parserVersion: FANSLY_EARNINGS_CANONICALIZER_VERSION,
      observations: this.observations, observationCount: this.observationCount,
      projectionCount: this.projectionCount, parseDebt: this.parseDebt, legacySources: this.legacySources,
      projectorCaughtUp: projectorCaughtUp(this.scope), outcomes, samples,
      verified: this.observationCount > 0 && projectorCaughtUp(this.scope)
        && this.parseDebt === 0 && unknownObservations === 0
        && this.scope.partitions.every(partition => partition.attached || partition.detachedRows === "0")
        && (outcomes.matched ?? 0) > 0
        && Object.entries(outcomes).every(([key, count]) => key === "matched" || count === 0),
      uncovered: [
        "Only the retained observation range in this database snapshot was compared",
        "Empty arrays do not identify a fan/window or certify a refresh",
        "No per-fan freshness, quiet-correction latency or HTTP savings were measured",
        "No provider calls, replay, rebuild or repair were performed",
      ],
    };
  }
}
