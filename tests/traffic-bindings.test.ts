import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { planTrafficIntervals, type TrafficIntervalRow } from "@agency_hub_core/db";
import { parseTrafficInstant } from "@agency_hub_core/shared";

import {
  parseTrafficBindingsFile,
  TRAFFIC_BINDINGS_FILE_FORMAT,
  TrafficBindingsFileError,
} from "../apps/runtime/src/services/traffic-bindings.ts";

const at = (value: string) => new Date(value);

describe("parseTrafficInstant", () => {
  it("reads a bare date as 00:00 Moscow and an ISO instant as given", () => {
    expect(parseTrafficInstant("2026-09-16").toISOString()).toBe("2026-09-15T21:00:00.000Z");
    expect(parseTrafficInstant("2026-04-01T13:31:01Z").toISOString()).toBe("2026-04-01T13:31:01.000Z");
    expect(parseTrafficInstant("2026-04-01T16:31:01+03:00").toISOString()).toBe("2026-04-01T13:31:01.000Z");
  });

  it("refuses a local time without a zone and an impossible date", () => {
    expect(() => parseTrafficInstant("2026-04-01T13:31:01")).toThrow(/ISO instant with Z or an offset/);
    expect(() => parseTrafficInstant("2026-02-30")).toThrow();
    expect(() => parseTrafficInstant("yesterday")).toThrow();
  });

  it("refuses an impossible ISO instant instead of rolling it over (with Z and with an offset)", () => {
    // `new Date` alone reads 2026-02-30T00:00:00Z as 2026-03-02 and T24:00 as the next day.
    for (const value of [
      "2026-02-30T00:00:00Z",
      "2026-02-30T10:00:00+03:00",
      "2026-02-29T10:00:00Z", // 2026 is not a leap year
      "2026-04-31T00:00:00-05:00",
      "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T23:60:00Z",
      "2026-01-01T23:59:60+03:00",
      "2026-01-01T10:00:00+24:00",
    ]) {
      expect(() => parseTrafficInstant(value), value).toThrow(/no such date or time/);
    }
    expect(parseTrafficInstant("2028-02-29T23:59:59.5-01:30").toISOString()).toBe("2028-03-01T01:29:59.500Z");
  });
});

describe("parseTrafficBindingsFile", () => {
  const file = (body: Record<string, unknown>) => JSON.stringify({ format: TRAFFIC_BINDINGS_FILE_FORMAT, ...body });

  it("reads contractors, channels with their terms, and bindings", () => {
    const change = parseTrafficBindingsFile(file({
      comment: ["built read-only from traffic-control"],
      contractors: [{ key: "coraline-red", title: "Coraline Red" }],
      channels: [{
        key: "lora.porntoki",
        title: "Порнтоки",
        note: null,
        contractors: [
          { contractor: "coraline-red", validFrom: "2026-04-01T13:31:01Z", validTo: "2026-09-16", validFromBasis: "assumed_link_created" },
          { contractor: "coraline-red", validFrom: "2026-09-16", validTo: null, validFromBasis: "confirmed", note: "pack 2" },
        ],
      }],
      bindings: [
        { page: "lora-vip-of", kind: "trial", link: 11170786, channel: "lora.porntoki", validFrom: "2026-04-01", validFromBasis: "confirmed" },
      ],
    }));
    expect(change.contractors).toEqual([{ key: "coraline-red", title: "Coraline Red" }]);
    expect(change.channels).toEqual([{ key: "lora.porntoki", title: "Порнтоки", note: null }]);
    expect(change.terms).toEqual([
      {
        channelKey: "lora.porntoki", contractorKey: "coraline-red",
        validFrom: at("2026-04-01T13:31:01Z"), validTo: at("2026-09-15T21:00:00Z"), validFromBasis: "assumed_link_created",
      },
      {
        channelKey: "lora.porntoki", contractorKey: "coraline-red",
        validFrom: at("2026-09-15T21:00:00Z"), validTo: null, validFromBasis: "confirmed", note: "pack 2",
      },
    ]);
    // A numeric link id is read as its digits; an absent validTo is open;
    // an absent note keeps the stored one (no `note` key at all).
    expect(change.bindings).toEqual([{
      pageLabel: "lora-vip-of", linkKind: "trial", linkId: "11170786", channelKey: "lora.porntoki",
      validFrom: at("2026-03-31T21:00:00Z"), validTo: null, validFromBasis: "confirmed",
    }]);
  });

  it("never defaults the start basis: a dated row without it is refused", () => {
    expect(() => parseTrafficBindingsFile(file({
      bindings: [{ page: "lora-vip-of", kind: "trial", link: "1", channel: "lora.x", validFrom: "2026-04-01" }],
    }))).toThrow(/bindings\[0\]\.validFromBasis: required/);
    expect(() => parseTrafficBindingsFile(file({
      channels: [{ key: "lora.x", title: "X", contractors: [{ contractor: "a", validFrom: "2026-04-01", validFromBasis: "guessed" }] }],
    }))).toThrow(/channels\[0\]\.contractors\[0\]\.validFromBasis: required/);
  });

  it("refuses unknown fields, a wrong format, bad keys and bad kinds", () => {
    expect(() => parseTrafficBindingsFile(file({ contractors: [{ key: "a", title: "A", vendor: "x" }] })))
      .toThrow(/contractors\[0\]: unknown field\(s\) vendor/);
    expect(() => parseTrafficBindingsFile(JSON.stringify({ format: "v0" }))).toThrow(TrafficBindingsFileError);
    expect(() => parseTrafficBindingsFile(file({ channels: [{ key: "porntoki", title: "P" }] })))
      .toThrow(/channels\[0\]\.key/);
    expect(() => parseTrafficBindingsFile(file({
      bindings: [{ page: "p", kind: "smart", link: "1", channel: "lora.x", validFrom: "2026-04-01", validFromBasis: "confirmed" }],
    }))).toThrow(/bindings\[0\]\.kind/);
    expect(() => parseTrafficBindingsFile(file({
      bindings: [{ page: "p", kind: "trial", link: "abc", channel: "lora.x", validFrom: "2026-04-01", validFromBasis: "confirmed" }],
    }))).toThrow(/bindings\[0\]\.link/);
    expect(() => parseTrafficBindingsFile("{")).toThrow(/not JSON/);
  });
});

describe("planTrafficIntervals (one key's history; the caller holds its lock)", () => {
  const row = (id: number, target: string, from: string, to: string | null, basis: TrafficIntervalRow["validFromBasis"] = "confirmed"): TrafficIntervalRow => ({
    id, target, validFrom: at(from), validTo: to === null ? null : at(to), validFromBasis: basis, note: null,
  });
  const want = (target: string, from: string, to: string | null, basis: TrafficIntervalRow["validFromBasis"] = "confirmed") => ({
    target, validFrom: at(from), validTo: to === null ? null : at(to), validFromBasis: basis,
  });

  it("refuses two closed intervals that overlap, not only two open rows", () => {
    const plan = planTrafficIntervals("link L", [row(1, "lora.a", "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z")], [
      want("lora.b", "2026-01-05T00:00:00Z", "2026-01-15T00:00:00Z"),
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatch(/overlaps/);
  });

  it("refuses overlaps inside the file too", () => {
    const plan = planTrafficIntervals("link L", [], [
      want("lora.a", "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z"),
      want("lora.b", "2026-01-09T00:00:00Z", null),
    ]);
    expect(plan.conflicts).toEqual([expect.stringMatching(/overlaps/)]);
  });

  it("accepts adjacent intervals: the end is exclusive", () => {
    const plan = planTrafficIntervals("link L", [], [
      want("lora.a", "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z"),
      want("lora.b", "2026-01-10T00:00:00Z", null),
    ]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions.map((a) => a.action)).toEqual(["create", "create"]);
  });

  it("closes the open row the file names with an end, and creates the next", () => {
    const plan = planTrafficIntervals("link L", [row(7, "lora.a", "2026-01-01T00:00:00Z", null, "assumed_link_created")], [
      want("lora.a", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "assumed_link_created"),
      want("lora.b", "2026-02-01T00:00:00Z", null),
    ]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions[0]).toMatchObject({ action: "close", id: 7, after: { validTo: at("2026-02-01T00:00:00Z") } });
    expect(plan.actions[1]).toMatchObject({ action: "create", row: { target: "lora.b", validTo: null } });
  });

  it("an import that names the same row again changes nothing; a new basis is an update", () => {
    const stored = [row(3, "lora.a", "2026-01-01T00:00:00Z", null, "assumed_link_created")];
    expect(planTrafficIntervals("link L", stored, [want("lora.a", "2026-01-01T00:00:00Z", null, "assumed_link_created")]))
      .toEqual({ actions: [{ action: "unchanged", id: 3, row: stored[0] }], conflicts: [] });
    const confirmed = planTrafficIntervals("link L", stored, [want("lora.a", "2026-01-01T00:00:00Z", null, "confirmed")]);
    expect(confirmed.conflicts).toEqual([]);
    expect(confirmed.actions[0]).toMatchObject({ action: "update", after: { validFromBasis: "confirmed" } });
  });

  it("never reopens or moves a closed row, and never takes an empty interval", () => {
    const stored = [row(4, "lora.a", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")];
    expect(planTrafficIntervals("link L", stored, [want("lora.a", "2026-01-01T00:00:00Z", null)]).conflicts)
      .toEqual([expect.stringMatching(/is closed; an import does not reopen or move it/)]);
    expect(planTrafficIntervals("link L", stored, [want("lora.a", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z")]).conflicts)
      .toEqual([expect.stringMatching(/is closed/)]);
    expect(planTrafficIntervals("link L", [], [want("lora.a", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z")]).conflicts)
      .toEqual([expect.stringMatching(/ends before it starts/)]);
  });

  it("an open row that a new open row would overlap is a conflict, not an implicit close", () => {
    const plan = planTrafficIntervals("link L", [row(1, "lora.a", "2026-01-01T00:00:00Z", null)], [
      want("lora.b", "2026-02-01T00:00:00Z", null),
    ]);
    expect(plan.conflicts).toEqual([expect.stringMatching(/lora\.a \[2026-01-01T00:00:00\.000Z, open\) overlaps lora\.b/)]);
  });
});

describe("traffic_link_bindings.sql (link → channel → contractor, dated)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations").filter((file) => file.endsWith("_traffic_link_bindings.sql"));
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
    expect(text.startsWith("-- agency-hub:no-transaction")).toBe(false);
    expect(sql.trimStart().startsWith("set local lock_timeout = '5s';")).toBe(true);
  });

  it("only creates four new tables: no existing table is altered, nothing dropped or written", () => {
    const created = [...sql.matchAll(/create table if not exists (\w+)/g)].map((match) => match[1]);
    expect(created).toEqual([
      "traffic_contractors", "traffic_channels", "traffic_channel_contractors", "traffic_link_bindings",
    ]);
    // Every statement is a `set local`, a `create` or a `comment on`: no
    // alter, drop, rename, truncate, delete, update or insert.
    const statements = sql
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.map((statement) => statement.split(" ")[0]).filter((verb) => !["set", "create", "comment"].includes(verb!)))
      .toEqual([]);
    expect(statements.filter((statement) => statement.startsWith("create ")).every((statement) =>
      /^create (table|unique index|index) if not exists traffic_/.test(statement))).toBe(true);
  });

  it("states the start basis on both dated tables, with no default", () => {
    expect(sql.match(/valid_from_basis text not null,/g)).toHaveLength(2);
    expect(sql.match(/check \(valid_from_basis in \('confirmed', 'assumed_link_created'\)\)/g)).toHaveLength(2);
    expect(sql).not.toMatch(/valid_from_basis text not null default/);
  });

  it("keeps the open-row unique indexes as the backstop of one channel per link and one contractor per channel", () => {
    expect(sql).toContain(
      "create unique index if not exists traffic_link_bindings_open_uniq on traffic_link_bindings "
        + "(platform_account_id, link_kind, platform_link_id) where valid_to is null;",
    );
    expect(sql).toContain(
      "create unique index if not exists traffic_channel_contractors_open_uniq on traffic_channel_contractors "
        + "(channel_id) where valid_to is null;",
    );
  });

  it("allows application rollback: the previous image never names the new tables", () => {
    const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain(`"${migration}"`);
  });
});
