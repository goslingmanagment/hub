import { describe, expect, it } from "vitest";

import { sanitizePostgresText } from "@agency_hub_core/shared";

import { defaultCaptureCodec, type CaptureCodec } from "../apps/runtime/src/sync/engine/commit.ts";
import { fanslyCaptureCodec } from "../apps/runtime/src/sync/fansly/capture.ts";
import { replaceJournalLoneSurrogates } from "../apps/runtime/src/sync/fansly/lib/journal-lone-surrogates.ts";

// Scratch (bug hunt 2026-10-09, reviewer `design`). The engine journals every
// 2xx body into `observations.payload` (jsonb) through `defaultCaptureCodec`.
// jsonb refuses the `\u0000` escape (prod: `select '{"a":"x\u0000y"}'::jsonb`
// → "unsupported Unicode escape sequence … \u0000 cannot be converted to text").
// The WS path replaces U+0000 (`sanitizePostgresText`, PR #349); the REST
// journal path replaces lone surrogates only. A body carrying a NUL in any
// string is therefore written as `\u0000` and the capture transaction fails —
// deterministically, on every retry.
describe("journal codec and U+0000", () => {
  const body = { success: true, response: [{ id: "1", content: "hi\u0000there" }] };
  const prepare = defaultCaptureCodec.prepare as CaptureCodec["prepare"];

  it("the WS text sanitizer replaces a NUL", () => {
    expect(sanitizePostgresText("hi\u0000there")).toBe("hi�there");
  });

  it("the REST journal sanitizer leaves a NUL in place", () => {
    const { value, replaced } = replaceJournalLoneSurrogates(body);
    expect(replaced).toBe(0);
    expect(JSON.stringify(value)).toContain("\\u0000");
  });

  it("the capture codec hands jsonb a body with the \\u0000 escape", () => {
    const journal = prepare({
      spec: "messages.page" as never,
      kind: "dm_messages",
      response: body,
      contractAccepted: true,
      request: { spec: "messages.page", params: {} } as never,
      module: {} as never,
    });
    // This is the string the driver sends for the jsonb parameter.
    expect(JSON.stringify(journal)).toContain("\\u0000");
  });

  it("so does the codec production runs (sync/main.ts → fanslyCaptureCodec)", () => {
    const journal = fanslyCaptureCodec.prepare({
      spec: "messages.page" as never,
      kind: "dm_messages",
      response: body,
      contractAccepted: true,
      request: { spec: "messages.page", params: {} } as never,
      ownRef: "1",
      module: {} as never,
    });
    expect(JSON.stringify(journal)).toContain("\\u0000");
  });
});
