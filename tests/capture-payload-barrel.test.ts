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

  // Decision #222. The reference liveness lock is not a read, it is a LOCK, and
  // it means nothing unless it is held until the envelope insert that stamps the
  // reference commits. The only two callers that can honour that are the two
  // envelope writers inside packages/db; a runtime caller holding it for the
  // length of some other transaction would fence the erasure for no reason, and
  // one calling it and then inserting separately would believe a proof it does
  // not have. Off the barrel, so neither is reachable.
  it("the reference liveness lock stays repository-internal", () => {
    expect(Object.keys(db)).not.toContain("lockCapturePayloadRefAlive");
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

  // G5 slice 2. The seam needs SOME way to reach a body, and this is it: the
  // ENVELOPE-authorized reader. It is barrel-safe for the reason the bare one is
  // not — it cannot be called without naming the envelope class the reference
  // was read off, and that name is load-bearing (it decides which
  // representation the reference may resolve to, and refuses the others).
  it("exports the envelope-authorized reader, and it demands the envelope", () => {
    expect(Object.keys(db)).toContain("readEnvelopeCapturePayload");
    expect(Object.keys(db)).toContain("readEnvelopeCapturePayloadBatch");
    expect(Object.keys(db)).toContain("CAPTURE_PAYLOAD_ENVELOPE_KINDS");
    expect(db.CAPTURE_PAYLOAD_ENVELOPE_KINDS).toEqual(["observation", "raw_payload"]);
    // The source line is pinned too: dropping `envelope` from the input would
    // turn this back into a bare-ref body reader without renaming anything.
    const repository = readFileSync(
      fileURLToPath(new URL("../packages/db/src/repositories/capture-payloads.ts", import.meta.url)),
      "utf8",
    );
    expect(repository).toContain(
      "input: { envelope: CapturePayloadEnvelopeKind; ref: CapturePayloadRef },",
    );
    expect(repository).toContain(
      "input: { envelope: CapturePayloadEnvelopeKind; refs: readonly CapturePayloadRef[] },",
    );
  });

  // G5 slice 3b. The erasure needs to know WHICH bodies contain a subject, and
  // the tempting shape — "hand the erasure module the bodies and let it look" —
  // would be a bare-ref body reader with a sympathetic name, i.e. exactly what
  // the pin above exists to prevent. It is barrel-safe because it never returns
  // a body: the subject match is decided in SQL and only metadata crosses the
  // boundary. These assertions fail the build if that inverts.
  it("the erasure catalog plane is exported, and it hands back metadata, never a body", () => {
    for (const required of [
      "capturePayloadErasureSubject",
      "scanCapturePayloadObjectsForErasureSubject",
      "countCapturePayloadByteObjectsInErasureScope",
      "deleteUnreferencedCapturePayloadObjects",
    ]) {
      expect(Object.keys(db), required).toContain(required);
    }

    const erasureRepository = readFileSync(
      fileURLToPath(
        new URL("../packages/db/src/repositories/capture-payload-erasure.ts", import.meta.url),
      ),
      "utf8",
    );
    // The match row carries identity and size — no `body`, in any shape.
    expect(erasureRepository).toContain("export interface CapturePayloadErasureMatch");
    expect(erasureRepository).not.toMatch(/^\s*(body|json|bytes)\??:/m);
    // …and the reason is stated in the file, so a later editor meets the rule
    // before the code.
    expect(erasureRepository).toContain("IT RETURNS NO BODY");
    // It also may not smuggle one out through the internal reader.
    expect(erasureRepository).not.toContain("loadPayloadBody");
  });
});
