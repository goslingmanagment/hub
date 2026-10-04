import { z } from "zod";

/**
 * The Spenders statistics as the chat extension froze them (its contracts v1,
 * packages/contracts/src/hub/spenders.ts: StatsQuerySchema, SpendersStatsSchema),
 * restated here. The answer's schema is stricter than the hub's own response
 * schema (instants by pattern, tokens of 1 to 64 characters, counts never
 * negative), and a body it refused would be lost on the client.
 */
const frozenInstant = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
const frozenToken = z.string().min(1).max(64);
const frozenCount = z.number().int().min(0);
/** Signed whole mills within the safe-integer range. */
const frozenMills = z.number().int();

const frozenMoneyWindow = z.object({
  grossMills: frozenMills,
  purchasesGrossMills: frozenMills,
  adjustmentsMills: frozenMills,
  creatorNetMills: frozenMills,
  purchaseCount: frozenCount,
  payerCount: frozenCount,
});
const frozenSilenceBucket = z.object({ fans: frozenCount, lifetimeGrossMills: frozenMills });

export const frozenClientSpenderStatsSchema = z.object({
  pageLabel: z.string(),
  metricVersion: z.number().int().min(1),
  moneyUnit: z.literal("USD-mills"),
  basis: z.literal("gross"),
  timeZone: z.string(),
  from: z.string(),
  to: z.string(),
  asOf: frozenInstant,
  projectionAsOf: frozenInstant.nullable(),
  includedStates: z.array(frozenToken),
  coverage: z.object({ state: frozenToken, reasons: z.array(frozenToken) }),
  days: z.array(z.object({
    date: z.string(),
    grossMills: frozenMills,
    purchasesGrossMills: frozenMills,
    adjustmentsMills: frozenMills,
    creatorNetMills: frozenMills,
    purchaseCount: frozenCount,
    byState: z.record(frozenToken, frozenMills),
  })),
  totals: z.object({
    today: frozenMoneyWindow,
    d7: frozenMoneyWindow,
    prev7: frozenMoneyWindow,
    d30: frozenMoneyWindow,
    d7DeltaPct: z.number().nullable(),
  }),
  avgCheckMills: frozenMills.nullable(),
  tiers: z.array(z.object({
    key: frozenToken,
    label: z.string(),
    minMills: frozenMills.nullable(),
    maxMills: frozenMills.nullable(),
    members: frozenCount,
    windowPayers: frozenCount,
    windowGrossMills: frozenMills,
  })),
  silence: z.object({ d8to21: frozenSilenceBucket, over21: frozenSilenceBucket, unknown: frozenSilenceBucket }),
  newPayers: z.object({ count: frozenCount, firstPurchaseKnown: z.boolean() }),
  queueSummary: z.object({ total: frozenCount, unknown: frozenCount }),
});

/** The zone names the client may send (its TimeZoneSchema): at most 64 characters of this pattern. */
export const FROZEN_CLIENT_TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
