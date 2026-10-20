import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Raw float math over money-ish operands lives only in the codec
// (packages/shared/src/money.ts). The pattern is deliberately broad (it also
// counts time/percent math), so the budget is per file: a new site names its
// file, and a site that is not money is allowed by raising that file's number.

const ROOT = join(__dirname, "..");
const PATTERN = String.raw`Math\.round\(.*(1000|[Pp]rice|[Aa]mount|[Mm]ills)`;
const SCOPES = ["apps/runtime/src", "apps/dashboard/src", "packages"];

/** grep's matching lines in one scope. Exit 1 is "no match"; any other
 * failure (exit 2: a bad pattern, an unreadable file) throws instead of
 * reading as a clean scope. */
function grepScope(pattern: string, scope: string): string {
  try {
    return execFileSync("grep", ["-rnE", pattern, "--include=*.ts", scope], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return "";
    throw error;
  }
}

describe("money float-site ratchet", () => {
  it("raw money float sites stay within their file's budget", () => {
    const { files: budget } = JSON.parse(
      readFileSync(join(ROOT, "scripts/money-float-budget.json"), "utf8"),
    ) as { files: Record<string, number> };

    const sites = new Map<string, string[]>();
    for (const scope of SCOPES) {
      for (const line of grepScope(PATTERN, scope).split("\n")) {
        if (line.trim() === "" || line.includes("money.ts") || line.includes("/tests/") || line.includes("money-ratchet")) {
          continue;
        }
        const file = line.slice(0, line.indexOf(":"));
        sites.set(file, [...(sites.get(file) ?? []), line]);
      }
    }

    const over = [...sites].filter(([file, lines]) => lines.length > (budget[file] ?? 0));
    expect(
      over.map(([file, lines]) => `${file}: ${lines.length} site(s), budget ${budget[file] ?? 0}\n  ${lines.join("\n  ")}`),
      "New raw Math.round over money: convert through a constructor from packages/shared/src/money.ts; "
        + "if the site is not money (seconds, percent), raise that file's number in scripts/money-float-budget.json.",
    ).toEqual([]);
  });

  it("toMills never comes back", () => {
    for (const scope of SCOPES) {
      const hits = grepScope(String.raw`\btoMills\(`, scope).split("\n").filter((line) =>
        line.trim() !== "" && !line.includes("dollarsToMills(") && !line.includes("microUsdToMills("),
      );
      expect(hits, `toMills was deleted in Stage 27; use a source-named constructor:\n${hits.join("\n")}`).toEqual([]);
    }
  });

  it("never reads a grep failure as a clean scope", () => {
    expect(grepScope(PATTERN, "scripts/money-float-budget.json")).toBe("");
    expect(() => grepScope("(", "packages")).toThrow();
  });
});
