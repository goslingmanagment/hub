import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CANONICALIZER_FAMILIES,
  familyForObservation,
  RAW_ONLY_OBSERVATION_KINDS,
} from "../apps/runtime/src/services/canonicalize/index.ts";

const ROOT = join(__dirname, "..");
const SCANNED_DIRS = ["apps/runtime/src", "packages/db/src"];

// Direct `insertObservation` writers for `operator` audit logs are intentionally
// outside the domain-event canonicalizer pipeline. Every other source written
// to `observations` must either be claimed by `CANONICALIZER_FAMILIES` or be
// explicitly listed in `RAW_ONLY_OBSERVATION_KINDS` with a rationale (BL-C3).
const TRACKED_SOURCES = new Set([
  "pull",
  "webhook",
  "client_capture",
  "ofapi_capture",
  "fansly_ws",
  "command_result",
]);

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (/\.(ts|mts)$/.test(entry)) {
      out.push(relative(ROOT, full));
    }
  }
  return out.sort();
}

function resolveSimpleConstants(content: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const match of content.matchAll(/(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*"([^"]+)"/g)) {
    map.set(match[1]!, [match[2]!]);
  }
  // Also extract `endpoint: "..."` entries from constant lookup maps (e.g. LINK_LIST_JOURNAL / LINK_USERS_JOURNAL).
  for (const match of content.matchAll(/endpoint:\s*"([^"]+)"/g)) {
    const existing = map.get("__INLINE_ENDPOINTS__") ?? [];
    existing.push(match[1]!);
    map.set("__INLINE_ENDPOINTS__", existing);
  }
  return map;
}

function collectWrittenObservationKinds(): Array<{ file: string; source: string; kind: string }> {
  const discovered: Array<{ file: string; source: string; kind: string }> = [];
  const files = SCANNED_DIRS.flatMap((dir) => walkSourceFiles(join(ROOT, dir)));

  for (const file of files) {
    const content = readFileSync(join(ROOT, file), "utf8");
    const constants = resolveSimpleConstants(content);

    // 1. Every `persistRawPayload(...)` writes `source: "pull", kind: <endpoint>`.
    if (content.includes("persistRawPayload(") && file !== "apps/runtime/src/services/sync/shared.ts") {
      for (const match of content.matchAll(/persistRawPayload\([\s\S]{0,600}?endpoint:\s*([^,\n]+)/g)) {
        const expr = match[1]!.trim();
        const branchExpr = expr.includes("?") ? expr.slice(expr.indexOf("?") + 1) : expr;
        const literals = [...branchExpr.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        if (literals.length > 0) {
          for (const kind of literals) {
            discovered.push({ file, source: "pull", kind });
          }
        } else if (constants.has(expr)) {
          for (const kind of constants.get(expr)!) {
            discovered.push({ file, source: "pull", kind });
          }
        } else if (expr.endsWith(".endpoint")) {
          for (const kind of constants.get("__INLINE_ENDPOINTS__") ?? []) {
            discovered.push({ file, source: "pull", kind });
          }
        }
      }
    }

    // 2. Direct `insertObservation(...)` calls with literal `source` and literal/local-constant `kind`.
    if (content.includes("insertObservation(")) {
      for (const match of content.matchAll(/insertObservation\([\s\S]{0,700}?\}/g)) {
        const block = match[0];
        const sourceMatch = block.match(/source:\s*"([^"]+)"/);
        if (!sourceMatch) continue;
        const source = sourceMatch[1]!;
        if (!TRACKED_SOURCES.has(source)) continue;
        const kindMatch = block.match(/kind:\s*([^,\n}]+)/);
        if (!kindMatch) continue;
        const kindExpr = kindMatch[1]!.trim();
        const literalMatch = kindExpr.match(/^"([^"]+)"$/);
        if (literalMatch) {
          discovered.push({ file, source, kind: literalMatch[1]! });
        } else if (constants.has(kindExpr)) {
          for (const kind of constants.get(kindExpr)!) {
            discovered.push({ file, source, kind });
          }
        }
      }
    }
  }

  return discovered;
}

describe("observation kinds canonicalizer ratchet (BL-C3)", () => {
  it("registers link_stats_tracking and link_stats_trial in CANONICALIZER_FAMILIES", () => {
    for (const kind of ["link_stats_tracking", "link_stats_trial"]) {
      const family = familyForObservation({ source: "pull", kind });
      expect(family, kind).not.toBeNull();
      expect(family?.lane).toBe("link_stats");
      expect(family?.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("ensures every written tracked observation kind is either canonicalized or explicitly allowlisted raw-only", () => {
    const written = collectWrittenObservationKinds();
    expect(written.length).toBeGreaterThan(0);

    const unclaimed: string[] = [];
    for (const entry of written) {
      const claimed = familyForObservation({ source: entry.source, kind: entry.kind }) !== null;
      const allowKey = `${entry.source}:${entry.kind}`;
      const allowlisted = Object.hasOwn(RAW_ONLY_OBSERVATION_KINDS, allowKey);
      if (!claimed && !allowlisted) {
        unclaimed.push(`${allowKey} (${entry.file})`);
      }
    }

    expect(
      unclaimed,
      "Unclaimed observation kinds found: register a family in CANONICALIZER_FAMILIES or document a raw-only rationale in RAW_ONLY_OBSERVATION_KINDS.",
    ).toEqual([]);
  });

  it("keeps RAW_ONLY_OBSERVATION_KINDS disjoint from CANONICALIZER_FAMILIES with non-empty rationales", () => {
    for (const [key, rationale] of Object.entries(RAW_ONLY_OBSERVATION_KINDS)) {
      const sep = key.indexOf(":");
      expect(sep, key).toBeGreaterThan(0);
      const source = key.slice(0, sep);
      const kind = key.slice(sep + 1);
      expect(rationale.trim().length, `${key} rationale`).toBeGreaterThan(10);
      const claimed = CANONICALIZER_FAMILIES.some(
        (family) => family.source === source && (family.kinds === null || family.kinds.includes(kind)),
      );
      expect(claimed, `${key} is already claimed by CANONICALIZER_FAMILIES — remove it from RAW_ONLY_OBSERVATION_KINDS`).toBe(false);
    }
  });
});
