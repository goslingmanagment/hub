import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

export type SyncChunkYieldReason = "request_budget" | "wall_clock";

export class SyncChunkBudget implements HttpRequestObserver {
  private readonly startedAt = Date.now();
  private requestCount = 0;

  constructor(
    readonly maxRequests = 5,
    readonly maxWallClockMs = 45_000,
  ) {}

  async onRequestEvent(event: HttpRequestEvent) {
    if (event.state === "started") {
      this.requestCount += 1;
    }
  }

  get elapsedMs() {
    return Date.now() - this.startedAt;
  }

  get totalRequests() {
    return this.requestCount;
  }

  hasRequestCapacity() {
    return this.requestCount < this.maxRequests;
  }

  hasWallClockCapacity() {
    return this.elapsedMs < this.maxWallClockMs;
  }

  shouldYield() {
    return !this.hasRequestCapacity() || !this.hasWallClockCapacity();
  }

  resolveYieldReason(): SyncChunkYieldReason | null {
    if (!this.hasRequestCapacity()) {
      return "request_budget";
    }

    if (!this.hasWallClockCapacity()) {
      return "wall_clock";
    }

    return null;
  }
}

export function composeRequestObservers(
  ...observers: Array<HttpRequestObserver | null | undefined>
): HttpRequestObserver | null {
  const activeObservers = observers.filter((observer): observer is HttpRequestObserver => Boolean(observer));
  if (activeObservers.length === 0) {
    return null;
  }

  return {
    async onRequestEvent(event) {
      await Promise.all(activeObservers.map((observer) => observer.onRequestEvent(event)));
    },
  };
}
