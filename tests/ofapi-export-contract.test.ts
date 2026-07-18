import { describe, expect, it } from "vitest";

import {
  parseOfapiExportCsvTimestamp,
} from "../apps/runtime/src/services/ofapi-export-artifact.ts";
import {
  effectiveOfapiExportEndDate,
} from "../apps/runtime/src/services/ofapi-export-quotes.ts";

describe("OFAPI export date contract", () => {
  it("widens only an exact UTC midnight to the inclusive end of that day", () => {
    expect(effectiveOfapiExportEndDate("2026-07-16T00:00:00.000Z")?.toISOString())
      .toBe("2026-07-16T23:59:59.999Z");
    expect(effectiveOfapiExportEndDate("2026-07-16T12:34:56.789Z")?.toISOString())
      .toBe("2026-07-16T12:34:56.789Z");
  });

  it("rejects normalized impossible CSV timestamps", () => {
    expect(() => parseOfapiExportCsvTimestamp(
      "2026-02-30 10:00:00",
      "onlyfans_created_at",
    )).toThrow("CSV onlyfans_created_at is invalid");
    expect(() => parseOfapiExportCsvTimestamp(
      "2026-02-28 24:00:00",
      "onlyfans_created_at",
    )).toThrow("CSV onlyfans_created_at is invalid");
  });

  it("accepts exact ordinary and leap-day CSV timestamps", () => {
    expect(parseOfapiExportCsvTimestamp(
      "2026-02-28 23:59:59",
      "onlyfans_created_at",
    )?.toISOString()).toBe("2026-02-28T23:59:59.000Z");
    expect(parseOfapiExportCsvTimestamp(
      "2028-02-29 00:00:00",
      "onlyfans_created_at",
    )?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});
