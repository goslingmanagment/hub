// Stage 4 fleet-verify support: the desktop sends x-client-version (Proposal
// 4.1) but nothing in core recorded it — fastify's default serializers do not
// log headers, so the stage's exit check ("0.1.29 from every active machine
// in core logs") had NO data source. This observer logs one line per
// (version, remote address) per process lifetime; the exit check greps
// "Desktop client version observed" and counts distinct addresses per version.

interface ClientVersionObservation {
  version: string;
  remoteAddress: string;
  firstSeenAt: Date;
  requests: number;
}

// Bounded: a hostile/buggy client can't grow this without bound. At agency
// scale (a handful of machines × a few versions) the cap is never approached.
const MAX_TRACKED_KEYS = 1000;

const seen = new Map<string, ClientVersionObservation>();

export function recordClientVersionObservation(input: {
  version: unknown;
  remoteAddress: string | undefined;
  logger: { info: (obj: Record<string, unknown>, msg: string) => void };
}) {
  if (typeof input.version !== "string") {
    return;
  }
  const version = input.version.trim();
  if (version.length === 0 || version.length > 64) {
    return;
  }
  const remoteAddress = input.remoteAddress ?? "unknown";
  const key = `${version}|${remoteAddress}`;
  const existing = seen.get(key);
  if (existing) {
    existing.requests += 1;
    return;
  }
  if (seen.size >= MAX_TRACKED_KEYS) {
    return;
  }
  seen.set(key, {
    version,
    remoteAddress,
    firstSeenAt: new Date(),
    requests: 1,
  });
  input.logger.info(
    { clientVersion: version, remoteAddress },
    "Desktop client version observed",
  );
}

export function snapshotClientVersionObservations(): ClientVersionObservation[] {
  return Array.from(seen.values()).map((entry) => ({ ...entry }));
}

export function resetClientVersionObservationsForTests() {
  seen.clear();
}
