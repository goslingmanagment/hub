import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("CI runner-minute budget", () => {
  it("keeps the complete PR gate on one runner and skips only the main duplicate", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain(`  quality:
    name: Quality Gate
    runs-on: ubuntu-latest
    timeout-minutes: 60
`);
    expect(workflow).toContain(`      - name: Sync-critical DB/schema/network/API tests
        if: github.event_name != 'push'
        run: pnpm test:sync-critical`);
    expect(workflow).not.toContain("\n  static:");
    expect(workflow).not.toContain("\n  integration:");
    expect(workflow).not.toMatch(/^\s+needs:/m);
    expect(workflow).not.toMatch(/^\s+matrix:/m);
    expect(workflow).not.toContain("--shard=");
  });
});
