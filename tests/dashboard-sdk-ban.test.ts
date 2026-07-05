import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Kernel Stage 20: the dashboard talks to the API only through @kernel/sdk.
// The old hand-rolled client is deleted; this gate keeps direct fetch and any
// client.js resurrection out of src/api (linter-independent, same mechanism as
// the contracts auth gate — the dashboard tree is not ESLint-covered).

const API_DIR = path.resolve("apps/dashboard/src/api");

describe("dashboard SDK adoption gate", () => {
  const files = readdirSync(API_DIR).filter((name) => name.endsWith(".ts"));

  it("has no direct fetch in src/api", () => {
    const offenders = files.filter((name) =>
      /\bfetch\s*\(/.test(readFileSync(path.join(API_DIR, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("has no resurrected hand-rolled client", () => {
    expect(files).not.toContain("client.ts");
    const offenders = files.filter((name) =>
      /from\s+"\.\/client(\.js)?"/.test(readFileSync(path.join(API_DIR, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every domain module goes through ./sdk.js", () => {
    const exempt = new Set(["sdk.ts", "queries.ts"]);
    const offenders = files.filter((name) => {
      if (exempt.has(name)) {
        return false;
      }
      return !readFileSync(path.join(API_DIR, name), "utf8").includes('from "./sdk.js"');
    });
    expect(offenders).toEqual([]);
  });
});
