import { z } from "zod";

const integer = z.string().regex(/^-?\d{1,20}$/);
const id = z.string().regex(/^\d{1,16}$/)
  .refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const timestamp = z.iso.datetime({ offset: true });
const fan = z.string().min(1).max(256);

export const earningsAuditScopeSchema = z.object({
  version: z.literal(1), accountId: id, page: z.string().min(1).max(256),
  from: timestamp, to: timestamp, asOf: timestamp,
  snapshot: z.string().max(4096), observationCount: id, upperObservationId: id,
  projectionCount: id, upperProjectionId: id, eventHighSeq: id,
  projectionHighSeq: id.nullable(),
  partitions: z.array(z.object({
    name: z.string().max(128), bound: z.string().max(512).nullable(), attached: z.boolean(),
    detachedRows: id.nullable(),
  })).max(1000),
});
export type EarningsAuditScope = z.infer<typeof earningsAuditScopeSchema>;

export const observationCursorSchema = z.object({ receivedAt: timestamp.nullable(), id });
export const projectionCursorSchema = z.object({ fanId: id, window: z.string().max(256) });
export const earningsObservationSchema = z.object({
  id, kind: z.enum(["fan_earnings_stats", "fan_earnings_monthly"]),
  receivedAt: timestamp, observedAt: timestamp.nullable(), parseVersion: z.number().int().nonnegative(),
  storage: z.enum([
    "inline", "cas", "object_missing", "scope_mismatch", "codec_mismatch", "body_missing", "body_limit",
  ]),
  status: z.enum([
    "available", "object_missing", "scope_mismatch", "codec_mismatch", "body_missing",
    "body_limit", "copy_disagreement", "shape_limit", "compressed_body",
  ]),
  payload: z.unknown(),
});
export type EarningsObservation = z.infer<typeof earningsObservationSchema>;

const scalarMoney = z.number().finite().nullable();
export const earningsProjectionSchema = z.object({
  id, fanId: id, fan: fan.nullable(), window: z.string().max(256),
  grossMills: integer, netMills: integer.nullable(), currency: z.string().max(3),
  observedAt: timestamp, sourceEventId: integer, sourceObservationId: id,
  event: z.object({
    id, accountSeq: id, observationId: id, fan: fan.nullable(),
    window: z.string().max(256).nullable(), grossMills: scalarMoney, netMills: scalarMoney,
    schemaVersion: z.number().int(),
  }).nullable(),
  observation: z.object({
    id, receivedAt: timestamp,
    kind: z.enum(["fan_earnings_stats", "fan_earnings_monthly"]),
    parseVersion: z.number().int().nonnegative(),
  }).nullable(),
});
export type EarningsProjection = z.infer<typeof earningsProjectionSchema>;

export const earningsAuditPageSchema = z.discriminatedUnion("operation", [
  z.object({
    scope: earningsAuditScopeSchema, operation: z.literal("observations"),
    after: observationCursorSchema, next: observationCursorSchema.nullable(),
    exhausted: z.boolean(), rows: z.array(earningsObservationSchema).max(100),
  }),
  z.object({
    scope: earningsAuditScopeSchema, operation: z.literal("projection"),
    after: projectionCursorSchema, next: projectionCursorSchema.nullable(),
    exhausted: z.boolean(), rows: z.array(earningsProjectionSchema).max(100),
  }),
]);
export type EarningsAuditPage = z.infer<typeof earningsAuditPageSchema>;

/** Cursor comparisons retain Postgres microseconds; the v7 parser uses JS milliseconds. */
export function timestampMicros(value: string): bigint {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("Invalid earnings audit timestamp");
  const fraction = value.match(/\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return BigInt(millis) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3));
}

export interface ExpectedEarnings {
  fan: string;
  window: string;
  grossMills: string;
  netMills: string;
  observedAt: string;
  observationId: string;
}

export function earningsKey(fanRef: string, window: string) {
  return JSON.stringify([fanRef, window]);
}
