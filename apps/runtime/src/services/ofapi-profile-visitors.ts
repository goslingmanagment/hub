import { recordOfapiTypedFacts } from "./projections/ofapi-typed-exports.ts";
import type { Database } from "@agency_hub_core/db";
import { BadRequestError } from "./errors.ts";
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** A REST chart is certified as daily only for an explicitly requested single day. */
export async function materializeOfapiProfileVisitorsRest(db: Database, input: {
  pageId: number; accountId: string; startDate: string; endDate: string; type: "total" | "users" | "guests";
  body: unknown; observationId: number; observationReceivedAt: Date;
}) {
  const requestedDay = input.startDate.slice(0, 10);
  if (requestedDay !== input.endDate.slice(0, 10)) throw new BadRequestError("Daily visitors require one-day REST windows");
  const data = record(record(input.body)?.data);
  if (!data || typeof data.isAvailable !== "boolean" || typeof data.hasStats !== "boolean") throw new BadRequestError("Visitor availability evidence is missing");
  const chart = record(data.chart); const visitors = Array.isArray(chart?.visitors) ? chart.visitors : [];
  const valid = visitors.flatMap(value => { const row = record(value); return row && typeof row.date === "string" && row.date.slice(0, 10) === requestedDay && typeof row.count === "number" && Number.isSafeInteger(row.count) && row.count >= 0 ? [row.count] : []; });
  if (data.isAvailable && data.hasStats && (visitors.length !== 1 || valid.length !== 1)) throw new BadRequestError("Visitor chart does not prove one daily bucket");
  const durations = Array.isArray(chart?.duration) ? chart.duration : [];
  const duration = durations.length === 1 ? record(durations[0]) : null;
  const value = data.isAvailable && data.hasStats ? valid[0] ?? null : null;
  await recordOfapiTypedFacts(db, input.pageId, [{ row: null, source: `rest_${input.type}`, observationId: input.observationId, observationReceivedAt: input.observationReceivedAt.toISOString(), metrics: { date: requestedDay, totalVisitors: input.type === "total" ? value : null, guestVisitors: input.type === "guests" ? value : null, userVisitors: input.type === "users" ? value : null, subscriberVisitors: null,
    avgViewDuration: null, chartDuration: data.isAvailable && data.hasStats && duration && typeof duration.date === "string" && duration.date.slice(0, 10) === requestedDay && typeof duration.count === "number" && Number.isFinite(duration.count) ? String(duration.count) : null,
    availability: data.isEligible === false ? "ineligible" : !data.isAvailable || !data.hasStats ? "unavailable" : "partial", } }], input.observationId, input.observationReceivedAt);
}
