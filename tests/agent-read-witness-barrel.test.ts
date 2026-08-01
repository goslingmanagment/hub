import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as db from "@agency_hub_core/db";

// Bucket 6 pin: the witness CONSTRUCTOR must be unreachable from a handler.
//
// `capture.planes[].state = "read"` is a claim about what a response is built on,
// and an agent reasons about the difference between "we looked and found nothing"
// and "we never looked". Review round 1 found four handlers minting that claim for
// stores they had not queried, because the mint helper was re-exported through the
// package barrel. These assertions fail the build if it comes back.

describe("agent read plane: the witness constructor stays repository-internal", () => {
  it("the db barrel exports NO witness mint helper", () => {
    for (const forbidden of ["mintPlaneReadWitness", "witnessFor", "witnessesFor", "storeDerivedWitness", "proofWitness"]) {
      expect(Object.keys(db), forbidden).not.toContain(forbidden);
    }
  });

  it("the barrel re-exports the witness module as a TYPE-only export", () => {
    // A `export *` here would put the constructors back on the barrel without
    // anyone noticing, so the source line itself is pinned.
    const barrel = readFileSync(
      fileURLToPath(new URL("../packages/db/src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(barrel).toContain('export type { PlaneReadWitness } from "./repositories/agent-read-witness.ts";');
    expect(barrel).not.toContain('export * from "./repositories/agent-read-witness.ts"');
  });

  it("no runtime file imports the witness module directly", () => {
    const root = fileURLToPath(new URL("../apps/runtime/src", import.meta.url));
    const offenders = listTypeScriptFiles(root).filter((file) =>
      readFileSync(file, "utf8").includes("agent-read-witness"));
    expect(offenders).toEqual([]);
  });
});

function listTypeScriptFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}
