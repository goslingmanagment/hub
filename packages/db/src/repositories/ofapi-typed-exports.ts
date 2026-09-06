import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import type { OfapiTypedExportProfile } from "@agency_hub_core/shared";

export interface OfapiVisitorMetrics {
  date: string; totalVisitors: number | null; guestVisitors: number | null; userVisitors: number | null; subscriberVisitors: number | null;
  avgViewDuration: string | null; chartDuration: string | null;
  availability: "complete" | "partial" | "unavailable" | "ineligible";
}
export async function upsertOfapiProfileVisitorsDaily(db: Database, input: OfapiVisitorMetrics & { pageId: number; source: "export" | "rest_total" | "rest_users" | "rest_guests"; observationId: number; observationReceivedAt: Date; exportJobId?: string; observedAt: Date }) {
  await db.execute(sql`insert into ofapi_profile_visitors_daily(page_id,day,source,total_visitors,guest_visitors,user_visitors,subscriber_visitors,avg_view_duration,chart_duration,availability,observation_id,observation_received_at,export_job_id,observed_at)
    values(${input.pageId},${input.date}::date,${input.source},${input.totalVisitors},${input.guestVisitors},${input.userVisitors},${input.subscriberVisitors},${input.avgViewDuration},${input.chartDuration},${input.availability},${input.observationId},${input.observationReceivedAt},${input.exportJobId ?? null}::uuid,${input.observedAt})
    on conflict(page_id,day,source) do update set total_visitors=excluded.total_visitors,guest_visitors=excluded.guest_visitors,user_visitors=excluded.user_visitors,subscriber_visitors=excluded.subscriber_visitors,
      avg_view_duration=excluded.avg_view_duration,chart_duration=excluded.chart_duration,availability=excluded.availability,observation_id=excluded.observation_id,observation_received_at=excluded.observation_received_at,export_job_id=excluded.export_job_id,observed_at=excluded.observed_at
    where ofapi_profile_visitors_daily.observed_at<=excluded.observed_at`);
}
export async function listOfapiProfileVisitorsDaily(db: Database, input: { pageId: number; from: string; to: string; source: "export" | "rest"; visitorType?: "total" | "users" | "guests" }) {
  const rows = await db.execute<{ date: string; source: "export" | "rest" | null; total_visitors: string | null; guest_visitors: string | null; user_visitors: string | null; subscriber_visitors: string | null; avg_view_duration: string | null; chart_duration: string | null; availability: OfapiVisitorMetrics["availability"] | null; observed_at: Date | string | null; observation_id: string | null }>(sql`
    select days.day::date::text date,case when m.source like 'rest_%' then 'rest' else m.source end source,m.total_visitors,m.guest_visitors,m.user_visitors,m.subscriber_visitors,m.avg_view_duration,m.chart_duration,m.availability,m.observed_at,m.observation_id
    from generate_series(${input.from}::date,${input.to}::date,interval '1 day') as days(day)
    left join ofapi_profile_visitors_daily m on m.page_id=${input.pageId} and m.day=days.day::date and m.source=${input.source === "rest" ? `rest_${input.visitorType ?? "total"}` : "export"} order by days.day`);
  const number = (value: string | null) => value === null ? null : Number(value);
  return rows.rows.map(row => ({ date: row.date, source: row.source ?? "missing" as const, totalVisitors: number(row.total_visitors), guestVisitors: number(row.guest_visitors), userVisitors: number(row.user_visitors), subscriberVisitors: number(row.subscriber_visitors), avgViewDuration: row.avg_view_duration, chartDuration: row.chart_duration,
    durationUnit: "vendor_unspecified" as const, availability: row.availability ?? "missing" as const, observedAt: row.observed_at === null ? null : new Date(row.observed_at).toISOString(), observationId: number(row.observation_id) }));
}
export async function listOfapiTypedExportRows(db: Database, input: { jobId: string; offset: number; limit: number }) {
  const rows = await db.execute<{ data: Record<string, string | null> }>(sql`select data from ofapi_typed_export_rows where export_job_id=${input.jobId}::uuid order by row_key limit ${input.limit} offset ${input.offset}`);
  return rows.rows.map(row => row.data);
}
export async function insertOfapiTypedExportRow(db: Database, input: { jobId: string; pageId: number; profile: OfapiTypedExportProfile; rowKey: string; data: Record<string, string | null>; observationId: number; observationReceivedAt: Date }) {
  await db.execute(sql`insert into ofapi_typed_export_rows(export_job_id,row_key,profile,page_id,data,observation_id,observation_received_at)
    values(${input.jobId}::uuid,${input.rowKey},${input.profile},${input.pageId},${JSON.stringify(input.data)}::jsonb,${input.observationId},${input.observationReceivedAt}) on conflict(export_job_id,row_key) do nothing`);
}
