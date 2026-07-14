import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("generated contract artifact gate", () => {
  it("fails CI when the runtime health contract hash is stale", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toMatch(
      /pnpm contracts:generate\n\s+git diff --exit-code[^\n]*packages\/contracts\/src\/contract-hash\.ts/,
    );
    expect(workflow).toMatch(/git diff --exit-code[^\n]*reference\/agency-hub\.openapi\.json/);
    expect(workflow).toMatch(/git diff --exit-code[^\n]*packages\/sdk/);
  });
});
