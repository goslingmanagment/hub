import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isoDateTime, revenueInstantSchema } from "../packages/contracts/src/index.ts";

// zod 4.5 made z.iso.datetime() require seconds (RFC 3339). Every date-time
// field of this API accepted them optional, so the contracts pin zod 4.3's
// pattern through isoDateTime(). This file fails if a zod upgrade stops
// honouring the given pattern, at parse time or in the emitted schema.

/** The pattern zod 4.3.6 emitted for `z.iso.datetime()`, as published in the
 *  committed OpenAPI before the upgrade (ofapi actions' `scheduledDate`). */
const ZOD_43_UTC_PATTERN = "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$";

describe("isoDateTime", () => {
  it("accepts seconds, fractions and minute precision with Z, as zod 4.3 did", () => {
    const schema = isoDateTime();
    for (const value of ["2026-10-10T12:00Z", "2026-10-10T12:00:59Z", "2026-10-10T12:00:59.123Z", "2024-02-29T00:00Z"]) {
      expect(schema.safeParse(value).success, value).toBe(true);
    }
    for (const value of ["2026-10-10T12:00", "2026-10-10T12:00+03:00", "2026-02-30T12:00Z", "2025-02-29T00:00Z", "2026-10-10 12:00Z", "2026-10-10T24:00Z"]) {
      expect(schema.safeParse(value).success, value).toBe(false);
    }
  });

  it("accepts an offset when asked, seconds still optional", () => {
    const schema = isoDateTime({ offset: true });
    for (const value of ["2026-10-10T12:00Z", "2026-10-10T12:00+03:00", "2026-10-10T12:00:00-05:30", "2026-10-10T12:00:00.5Z"]) {
      expect(schema.safeParse(value).success, value).toBe(true);
    }
    for (const value of ["2026-10-10T12:00", "2026-10-10T12:00+3:00", "2026-10-10T12:00+24:00"]) {
      expect(schema.safeParse(value).success, value).toBe(false);
    }
    // The revenue bounds keep their extra refine on top.
    expect(revenueInstantSchema.safeParse("2026-10-10T12:00+03:00").success).toBe(true);
    expect(revenueInstantSchema.safeParse("2026-10-10T12:00").success).toBe(false);
  });

  it("emits zod 4.3's pattern, so the published OpenAPI pattern is unchanged", async () => {
    expect(z.toJSONSchema(isoDateTime())).toMatchObject({ type: "string", format: "date-time", pattern: ZOD_43_UTC_PATTERN });
    const openapi = await readFile("reference/agency-hub.openapi.json", "utf8");
    expect(openapi).toContain(JSON.stringify(ZOD_43_UTC_PATTERN));
  });

  it("is the only way a contract declares a date-time", async () => {
    const { readdir } = await import("node:fs/promises");
    const dir = "packages/contracts/src";
    const offenders: string[] = [];
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".ts") || file === "primitives.ts") continue;
      const source = await readFile(`${dir}/${file}`, "utf8");
      if (/\.datetime\(/.test(source.replace(/^\s*(\/\/|\*).*$/gm, ""))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
