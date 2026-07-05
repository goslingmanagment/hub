// Kernel Stage 21: the event-stream v2 resume cursor. Opaque on the wire —
// base64url JSON `{v: 2, w: {<accountId>: <highSeq>, …}}`, the per-account
// high-water map. Shared by the server (modules/events) and the SDK helper so
// both ends agree byte-for-byte; clients never construct or inspect it.

export type DomainEventWatermarks = ReadonlyMap<number, number>;

export type DecodedDomainEventCursor =
  | { ok: true; watermarks: Map<number, number> }
  | { ok: false; reason: string };

function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function fromBase64Url(text: string): string | null {
  try {
    const decoded = Buffer.from(text, "base64url");
    // Round-trip guard: base64url decoding never throws on garbage, it just
    // truncates — re-encoding catches non-canonical input.
    if (decoded.toString("base64url") !== text.replace(/=+$/, "")) {
      return null;
    }
    return decoded.toString("utf8");
  } catch {
    return null;
  }
}

export function encodeDomainEventCursor(watermarks: DomainEventWatermarks): string {
  const w: Record<string, number> = {};
  // Sorted keys → deterministic encoding (cursor equality is comparable in tests).
  for (const accountId of [...watermarks.keys()].sort((a, b) => a - b)) {
    w[String(accountId)] = watermarks.get(accountId)!;
  }
  return toBase64Url(JSON.stringify({ v: 2, w }));
}

export function decodeDomainEventCursor(text: string): DecodedDomainEventCursor {
  const json = fromBase64Url(text);
  if (json === null) {
    return { ok: false, reason: "not_base64url" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object" };
  }
  const candidate = parsed as { v?: unknown; w?: unknown };
  if (candidate.v !== 2) {
    return { ok: false, reason: "unknown_version" };
  }
  if (typeof candidate.w !== "object" || candidate.w === null || Array.isArray(candidate.w)) {
    return { ok: false, reason: "missing_watermarks" };
  }
  const watermarks = new Map<number, number>();
  for (const [key, value] of Object.entries(candidate.w as Record<string, unknown>)) {
    const accountId = Number(key);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { ok: false, reason: "invalid_account_id" };
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return { ok: false, reason: "invalid_watermark" };
    }
    watermarks.set(accountId, value);
  }
  return { ok: true, watermarks };
}
