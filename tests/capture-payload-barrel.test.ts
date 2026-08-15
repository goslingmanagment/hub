import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as db from "@agency_hub_core/db";

// The capture payload body reader stays repository-internal, same law as the
// agent-read witness mint helpers (tests/agent-read-witness-barrel.test.ts).
//
// `loadPayloadBody(db, { bucketMonth, objectId })` is addressed by an object id,
// and an object id carries none of the authorization the ENVELOPE carries: one
// payload object can be shared by several envelopes, and a `restricted_ai` body
// is addressed exactly like an ordinary one. On the package barrel it would be a
// public unauthorized read of any body in the store, straight past the envelope
// seam in apps/runtime/src/services/payload-reader.ts. These assertions fail the
// build if it comes back.

const barrelPath = fileURLToPath(new URL("../packages/db/src/index.ts", import.meta.url));
const barrel = readFileSync(barrelPath, "utf8");

describe("capture payloads: the body reader stays off the package barrel", () => {
  it("the db barrel exports NO body reader", () => {
    for (const forbidden of ["loadPayloadBody", "loadBodyRow", "loadCapturePayloadBody"]) {
      expect(Object.keys(db), forbidden).not.toContain(forbidden);
    }
  });

  it("the barrel re-exports the repository selectively, never with a star", () => {
    // A `export *` here would put the body reader back on the barrel without
    // anyone noticing, so the source line itself is pinned.
    expect(barrel).not.toContain('export * from "./repositories/capture-payloads.ts"');
    expect(barrel).toContain('} from "./repositories/capture-payloads.ts";');
  });

  it("still exports the writer, the metadata reader, the vocabularies and the classifier", () => {
    for (const required of [
      "putPayloadObject",
      "getPayloadObject",
      "classifyCapturePayloadScope",
      "capturePayloadBucketMonth",
      "CAPTURE_PAYLOAD_ACCESS_CLASSES",
      "CAPTURE_PAYLOAD_ERASURE_DOMAINS",
      "CAPTURE_PAYLOAD_LANES",
      "CAPTURE_PAYLOAD_STORAGE_TIERS",
    ]) {
      expect(Object.keys(db), required).toContain(required);
    }
  });
});
