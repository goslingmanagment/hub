import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  nextOfapiLinkStatsWindowAt,
  OFAPI_LINK_STATS_CRON,
  OFAPI_LINK_STATS_WINDOW_HOURS_UTC,
  OFAPI_LINK_STATS_WINDOW_INTERVAL_MS,
  OFAPI_LINK_STATS_WINDOW_MINUTE,
  ofapiLinkStatsWindowAt,
  previousOfapiLinkStatsWindowAt,
} from "../apps/runtime/src/services/ofapi-link-stats-windows.ts";

const HOUR_MS = 60 * 60 * 1000;

function windowOn(day: string, hour: number): Date {
  return new Date(`${day}T${String(hour).padStart(2, "0")}:${String(OFAPI_LINK_STATS_WINDOW_MINUTE).padStart(2, "0")}:00.000Z`);
}

describe("the link-series windows", () => {
  const hours = [...OFAPI_LINK_STATS_WINDOW_HOURS_UTC].sort((left, right) => left - right);
  const first = hours[0]!;
  const last = hours[hours.length - 1]!;

  it("are the cron the schedule runs on", () => {
    expect(OFAPI_LINK_STATS_CRON).toBe("45 4,16 * * *");
    expect(OFAPI_LINK_STATS_CRON).toBe(`${OFAPI_LINK_STATS_WINDOW_MINUTE} ${hours.join(",")} * * *`);
  });

  it("an instant belongs to the latest window that has opened", () => {
    for (const hour of hours) {
      const opens = windowOn("2026-10-08", hour);
      expect(ofapiLinkStatsWindowAt(opens)).toEqual(opens);
      expect(ofapiLinkStatsWindowAt(new Date(opens.getTime() + 21_083))).toEqual(opens);
      // A late attempt — a retry, a run after a rebind — still names it.
      expect(ofapiLinkStatsWindowAt(new Date(opens.getTime() + 3 * HOUR_MS))).toEqual(opens);
    }
  });

  it("the stretch before the day's first window belongs to yesterday's last", () => {
    const beforeFirst = new Date(windowOn("2026-10-08", first).getTime() - 1);
    expect(ofapiLinkStatsWindowAt(beforeFirst)).toEqual(windowOn("2026-10-07", last));
    expect(ofapiLinkStatsWindowAt(new Date("2026-10-08T00:00:00.000Z"))).toEqual(windowOn("2026-10-07", last));
    // Month and year boundaries are plain UTC arithmetic.
    expect(ofapiLinkStatsWindowAt(new Date("2027-01-01T00:00:00.000Z"))).toEqual(windowOn("2026-12-31", last));
  });

  it("next and previous walk the same grid", () => {
    let windowAt = windowOn("2026-10-08", first);
    const day: Date[] = [];
    for (let step = 0; step < hours.length; step += 1) {
      day.push(windowAt);
      const next = nextOfapiLinkStatsWindowAt(windowAt);
      expect(next.getTime()).toBeGreaterThan(windowAt.getTime());
      expect(previousOfapiLinkStatsWindowAt(next)).toEqual(windowAt);
      // Every instant up to the next opening still belongs to this window.
      expect(ofapiLinkStatsWindowAt(new Date(next.getTime() - 1))).toEqual(windowAt);
      windowAt = next;
    }
    expect(day).toEqual(hours.map((hour) => windowOn("2026-10-08", hour)));
    expect(windowAt).toEqual(windowOn("2026-10-09", first));
  });

  it("one interval is the longest gap between two windows", () => {
    const gaps = hours.map((hour, index) =>
      ((hours[index + 1] ?? first + 24) - hour) * HOUR_MS);
    expect(OFAPI_LINK_STATS_WINDOW_INTERVAL_MS).toBe(Math.max(...gaps));
    expect(OFAPI_LINK_STATS_WINDOW_INTERVAL_MS).toBe(12 * HOUR_MS);
  });
});

describe("page_link_stat_runs_attempts.sql (every attempt of the link series is a row)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations")
    .filter((file) => file.endsWith("_page_link_stat_runs_attempts.sql"));
  const migration = found[0] ?? "";
  const text = found.length === 1 ? readFileSync(`packages/db/migrations/${migration}`, "utf8") : "";
  const sql = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("exists once, after every migration already on main, inside the runner's transaction", () => {
    expect(found).toHaveLength(1);
    expect(migration > "0251_page_dm_thread_unavailability.sql").toBe(true);
    // `set local` needs the runner's transaction.
    expect(text.startsWith("-- agency-hub:no-transaction")).toBe(false);
    expect(sql.trimStart().startsWith("set local lock_timeout = '5s';")).toBe(true);
  });

  it("only widens: four columns the previous image never names, and two more statuses", () => {
    expect(sql).toContain(
      "alter table page_link_stat_runs add column if not exists reason text, "
        + "add column if not exists window_at timestamptz, "
        + "add column if not exists attempt smallint not null default 1, "
        + "add column if not exists ofapi_account_id text;",
    );
    expect(sql).toContain(
      "check (status in ('complete', 'partial', 'truncated', 'failed', 'skipped')) not valid;",
    );
    expect(sql).toContain("validate constraint page_link_stat_runs_status_check;");
    // The one constraint it drops is the one it puts back wider; nothing else
    // is dropped, renamed or deleted, and the snapshots are not touched.
    expect(sql.match(/\bdrop\b/g)).toHaveLength(1);
    expect(sql).toContain("drop constraint if exists page_link_stat_runs_status_check;");
    expect(sql).not.toMatch(/\b(rename|truncate|delete)\b/);
    expect(sql).not.toContain("page_link_stat_snapshots");
  });

  it("backfills the account only on rows that have none", () => {
    expect(sql.match(/\bupdate\b/g)).toHaveLength(1);
    expect(sql).toContain("update page_link_stat_runs r set ofapi_account_id = matched.account_id");
    expect(sql).toContain("where run.ofapi_account_id is null");
    expect(sql).toContain("having count(*) = 1");
  });

  it("allows application rollback: the previous image runs unchanged on the wider table", () => {
    const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain(`"${migration}"`);
  });
});
