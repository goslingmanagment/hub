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

// The other half of decision #199: the brand proves a REPOSITORY minted the
// witness, but nothing structural proved the repository had actually queried the
// store it named. `loadAgentPersonIdentityExtras` minted `fans` beside three
// statements that read `fan_username_aliases`, `page_fan_aliases`, `fan_flags`
// and `page_fans` and never touched `fans`. It reached the wire harmlessly only
// because its one caller (#3) runs after `findAgentPersonIdentity`, which does
// read `fans` — that is luck, not a law. This pin is the law.

describe("agent read plane: every static witness names a store its SQL reads", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../packages/db/src/repositories/agent-read.ts", import.meta.url)),
    "utf8",
  );

  /** `witnessesFor(...)` / `witnessFor(...)` spans, paren-matched. */
  function witnessCalls(body: string): Array<{ start: number; end: number; args: string }> {
    const calls: Array<{ start: number; end: number; args: string }> = [];
    const opener = /witness(?:es)?For\(/g;
    let match = opener.exec(body);
    while (match !== null) {
      let depth = 1;
      let index = opener.lastIndex;
      while (index < body.length && depth > 0) {
        const character = body[index];
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        index += 1;
      }
      calls.push({ start: match.index, end: index, args: body.slice(opener.lastIndex, index - 1) });
      match = opener.exec(body);
    }
    return calls;
  }

  const functions = source
    .split(/\nexport (?:async )?function /)
    .slice(1)
    .map((chunk) => ({ name: chunk.slice(0, chunk.indexOf("(")), body: chunk }));

  let checkedPlanes = 0;
  const failures: string[] = [];
  for (const fn of functions) {
    const calls = witnessCalls(fn.body);
    if (calls.length === 0) {
      continue;
    }
    // The witness call itself names the planes, so it must not count as its own
    // evidence: search the function with those spans removed.
    let sql = fn.body;
    for (const call of [...calls].reverse()) {
      sql = sql.slice(0, call.start) + sql.slice(call.end);
    }
    // Comments are not evidence either. A doc comment explaining WHY a store is
    // not read would otherwise satisfy the search for that store's name.
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    for (const call of calls) {
      for (const literal of call.args.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
        const plane = literal[1]!;
        checkedPlanes += 1;
        // Word-boundary: `page_fans` must NOT satisfy a witness for `fans`,
        // which is exactly how the bug hid.
        if (!new RegExp(`(?<![A-Za-z0-9_])${plane}(?![A-Za-z0-9_])`).test(sql)) {
          failures.push(`${fn.name} witnesses "${plane}" but its SQL never names it`);
        }
      }
    }
  }

  it("holds for every statically named plane in the agent-read repository", () => {
    expect(failures).toEqual([]);
    // A refactor that made every witness list dynamic would leave the loop above
    // asserting nothing at all.
    expect(checkedPlanes).toBeGreaterThanOrEqual(15);
  });

  it("keeps `fans` out of loadAgentPersonIdentityExtras specifically", () => {
    const start = source.indexOf("export async function loadAgentPersonIdentityExtras");
    const end = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, end);
    expect(body).toContain("page_fans");
    expect(body).not.toMatch(/witnessesFor\(\[\s*\n\s*"fans"/);
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
