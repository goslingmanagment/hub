// A write's fingerprint, as the operator computes it over what it would let
// go (wall posts PR 7): the engine records the command's fingerprint before
// the send (`fanslyWriteFingerprint`, packages/fansly/src/wire/publish.ts),
// and the operator releases a Hub write only when the request Chrome holds —
// its method, its real URL and the bytes of its body — has the same one. The
// engine never loads this app and this app loads no package: the form is
// mirrored here, and tests/page-browser-hub-requests.test.ts holds the two
// equal.
//
// sha256 hex of the version, the method, the host's class (`api` — the API;
// `upload` — the upload API, mediav2), the path with its query, and the
// sha256 of the body's bytes, one per line.

import { createHash } from "node:crypto";

import { WRITES } from "../rpc/protocol.ts";

export type WriteHostClass = "api" | "upload";

export function writeFingerprint(input: { method: string; host: WriteHostClass; pathAndQuery: string; body: Buffer | string }): string {
  const bodySha256 = createHash("sha256").update(input.body).digest("hex");
  const lines = [WRITES.fingerprint, input.method, input.host, input.pathAndQuery, bodySha256];
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
