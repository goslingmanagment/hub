import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Kernel Stage 27 ratchet: raw float math over money-ish operands must only
// ever decrease — the codec (packages/shared/src/money.ts) is the one home
// for unit conversions. The pattern is deliberately broad (it counts some
// time/percent math); the BUDGET is what enforces trajectory, not the regex.

const ROOT = join(__dirname, "..");
const PATTERN = String.raw`Math\.round\(.*(1000|[Pp]rice|[Aa]mount|[Mm]ills)`;
const SCOPES = ["apps/runtime/src", "apps/dashboard/src", "packages"];

describe("money float-site ratchet", () => {
  it("raw money float sites stay at or below the recorded budget", () => {
    const { budget } = JSON.parse(
      readFileSync(join(ROOT, "scripts/money-float-budget.json"), "utf8"),
    ) as { budget: number };

    let count = 0;
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      let output = "";
      try {
        output = execFileSync(
          "grep",
          ["-rnE", PATTERN, "--include=*.ts", scope],
          { cwd: ROOT, encoding: "utf8" },
        );
      } catch {
        continue; // grep exit 1 = no matches in this scope
      }
      for (const line of output.split("\n")) {
        if (line.trim() === "" || line.includes("money.ts") || line.includes("/tests/") || line.includes("money-ratchet")) {
          continue;
        }
        count += 1;
        offenders.push(line.split(":").slice(0, 2).join(":"));
      }
    }

    expect(
      count,
      `money float sites (${count}) exceed the budget (${budget}); route new conversions through the codec — offenders:\n${offenders.join("\n")}`,
    ).toBeLessThanOrEqual(budget);
  });

  it("toMills never comes back", () => {
    for (const scope of SCOPES) {
      let output = "";
      try {
        output = execFileSync(
          "grep",
          ["-rnE", String.raw`\btoMills\(`, "--include=*.ts", scope],
          { cwd: ROOT, encoding: "utf8" },
        );
      } catch {
        continue;
      }
      const hits = output.split("\n").filter((line) =>
        line.trim() !== "" && !line.includes("dollarsToMills(") && !line.includes("microUsdToMills("),
      );
      expect(hits, `toMills was deleted in Stage 27; use a source-named constructor:\n${hits.join("\n")}`).toEqual([]);
    }
  });
});
