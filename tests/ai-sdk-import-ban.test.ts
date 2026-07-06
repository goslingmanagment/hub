import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Kernel Stage 29: vendor AI SDK imports are gateway-only, so spend,
// budgets, and the restricted capture class cannot be bypassed. The ESLint
// wall enforces it at edit time; this pin makes the boundary a test.
const SANCTIONED_SDK_IMPORTERS = [
  "apps/runtime/src/services/ai-gateway-anthropic-provider.ts",
];

describe("vendor AI SDK import ban (Stage 29)", () => {
  it("only the gateway provider imports @anthropic-ai/sdk", () => {
    const root = join(__dirname, "..");
    let output: string;
    try {
      output = execFileSync(
        "grep",
        [
          "-rlE",
          "from \"@anthropic-ai/sdk\"|require\\(\"@anthropic-ai/sdk\"\\)",
          "--include=*.ts",
          "apps/runtime/src",
          "packages",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      output = "";
    }
    const found = output.split("\n").filter((line) => line.trim() !== "").sort();
    expect(found).toEqual([...SANCTIONED_SDK_IMPORTERS].sort());
  });
});
