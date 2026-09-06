// WP-F0(c)(i) / §9.2 — the permanent observation-kind coverage ratchet.
//
// It makes the BL-C3 class of mistake fail CI at the PR that introduces it: a
// journaled `observations.kind` that no canonicalizer family ever claims,
// invisible to the health-floor registry, parse debt forever.
//
// TWO HALVES, and the second is the one that makes this a ratchet rather than a
// self-consistent list:
//
//   (1) COVERAGE — every registered kind is claimed by a family, by a
//       registered off-sweep claimant, by a justified dynamic rule, or by the
//       raw-only allowlist; and no allowlist entry is orphaned.
//   (2) CENSUS — the registry is compared against what the TREE actually
//       writes, by grepping the write seams. Without this half, a new kind
//       lands in code and the registry simply never hears about it.
//
// The guarantee is "CI-enforced registry", NOT "structurally impossible": the
// typed write seam was deferred (A28-7), so `tsc` cannot reject an unregistered
// literal. That limitation is stated here rather than implied.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  claimObservationKind,
  DYNAMIC_OBSERVATION_KIND_RULES,
  OFF_SWEEP_OBSERVATION_CLAIMANTS,
  RAW_ONLY_OBSERVATION_KINDS,
  WRITTEN_OBSERVATION_KINDS,
  type WrittenObservationKind,
} from "../apps/runtime/src/services/observation-kinds.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";

const ROOT = join(__dirname, "..");

function grep(pattern: string, paths: string[]): string[] {
  try {
    return execFileSync("grep", ["-rhoE", pattern, "--include=*.ts", ...paths], {
      cwd: ROOT,
      encoding: "utf8",
    }).split("\n").filter((line) => line.trim() !== "");
  } catch {
    // grep exits 1 on no match; an empty census is a legitimate answer.
    return [];
  }
}

/** Every string literal on a line that assigns an observation-kind seam. This
 *  is line-based on purpose: `endpoint: input.kind === "tracking" ? "a" : "b"`
 *  (the BL-C3 writer, verbatim) has no `endpoint: "literal"` to match. */
function seamLiterals(seam: string, paths: string[]): Set<string> {
  const found = new Set<string>();
  for (const line of grep(`${seam}: *[^,;]*`, paths)) {
    for (const match of line.matchAll(/"([^"\\]+)"/g)) {
      found.add(match[1]!);
    }
  }
  return found;
}

const registered = new Set(WRITTEN_OBSERVATION_KINDS.map((entry) => entry.kind));

/**
 * Literals the line-based census sweeps up that are NOT observation kinds. The
 * census is deliberately over-broad — it must catch
 * `endpoint: input.kind === "tracking" ? "link_stats_tracking" : "link_stats_trial"`,
 * which has no `endpoint: "literal"` to match — so the price is a short,
 * justified exclusion list. Every entry names what it really is.
 */
const CENSUS_NON_KIND_LITERALS = new Map<string, string>([
  [
    "tracking",
    "ofapi-link-stats-sync.ts: the ternary CONDITION (`input.kind === \"tracking\"`), not "
    + "the endpoint it selects — both branches (link_stats_tracking/link_stats_trial) are "
    + "registered.",
  ],
]);

/**
 * The files that call `insertObservation` directly, pinned. A new direct writer
 * can use ANY string as a kind, so this list is what forces its author through
 * observation-kinds.ts — the same device tests/retention-deleters.test.ts uses
 * for SQL deletes. It is also the scope the namespaced-kind census greps, so
 * `kind:` discriminators elsewhere in the tree (notification incidents use
 * `kind: "ofapi_burn_rate"` and mean something else) cannot pollute it.
 */
const DIRECT_WRITERS = [
  // The insert primitive itself and the CAS dual-write that wraps it. Neither
  // mints a kind of its own — both are handed one by a caller above.
  "packages/db/src/repositories/observations.ts",
  "apps/runtime/src/services/capture-cas-dual-write.ts",
  // Real kind writers.
  "packages/db/src/repositories/ofapi-capture.ts",
  "packages/db/src/repositories/ofapi-message-coverage.ts",
  "apps/runtime/src/services/auth.ts",
  "apps/runtime/src/services/dm-corrections-lineage-intake.ts",
  "apps/runtime/src/services/ingest-observations.ts",
  "apps/runtime/src/services/observations-rejournal.ts",
  "apps/runtime/src/services/ofapi-smart-links.ts",
  "apps/runtime/src/services/ofapi-command-executor.ts",
  "apps/runtime/src/services/ofapi-binding-refresh.ts",
  "apps/runtime/src/services/ofapi-credential-policy.ts",
  "apps/runtime/src/services/ofapi-export-artifact.ts",
  "apps/runtime/src/services/ofapi-typed-exports.ts",
  "apps/runtime/src/services/ofapi-read-gateway-capture.ts",
  "apps/runtime/src/services/ofapi-webhook-capture.ts",
  "apps/runtime/src/services/sync/shared.ts",
];

describe("(1) coverage — every written kind is owned by something", () => {
  it("registers no kind twice", () => {
    expect(registered.size).toBe(WRITTEN_OBSERVATION_KINDS.length);
  });

  it("claims every written kind, and names WHO claims it", () => {
    const unclaimed: string[] = [];
    for (const entry of WRITTEN_OBSERVATION_KINDS) {
      const claim = claimObservationKind(entry);
      if (!claim.claimed) {
        unclaimed.push(`${entry.kind} (written by ${entry.writer})`);
      }
    }
    expect(unclaimed, "unclaimed observation kinds — add a family or a justified allowlist entry")
      .toEqual([]);
  });

  it("every allowlist entry is a written kind, justified, and not already family-claimed", () => {
    for (const row of RAW_ONLY_OBSERVATION_KINDS) {
      // Orphan check, direction 1: an allowlist entry for a kind nothing writes
      // is dead weight that makes the list look more considered than it is.
      expect(registered.has(row.kind), `${row.kind}: allowlisted but never written`).toBe(true);
      // A justification is the whole point of the allowlist.
      expect(row.justification.length, `${row.kind}: justification too thin`)
        .toBeGreaterThan(40);
      // Orphan check, direction 2: if a family DOES claim it, the allowlist
      // entry is stale and must be deleted, not left as a second opinion.
      const entry = WRITTEN_OBSERVATION_KINDS.find((item) => item.kind === row.kind)!;
      const familyClaim = CANONICALIZER_FAMILIES.some((family) =>
        family.source === entry.source
        && (family.kinds === null || family.kinds.includes(entry.kind))
      );
      expect(familyClaim, `${row.kind}: claimed by a family AND allowlisted`).toBe(false);
      const offSweep = OFF_SWEEP_OBSERVATION_CLAIMANTS.some((claimant) =>
        claimant.kinds.includes(row.kind)
      );
      expect(offSweep, `${row.kind}: claimed off-sweep AND allowlisted`).toBe(false);
    }
    expect(new Set(RAW_ONLY_OBSERVATION_KINDS.map((row) => row.kind)).size)
      .toBe(RAW_ONLY_OBSERVATION_KINDS.length);
  });

  it("keeps the four deliberately off-registry Fansly replay kinds claimed, not allowlisted", () => {
    // The trap §9.2 names: these four ARE parsed, by a family that is absent
    // from CANONICALIZER_FAMILIES on purpose. Allowlisting them would record
    // "nobody parses this", which is false.
    for (const kind of ["followers", "subscribers", "dm_conversations", "account_me"]) {
      const entry = WRITTEN_OBSERVATION_KINDS.find((item) => item.kind === kind)!;
      expect(entry, kind).toBeDefined();
      expect(claimObservationKind(entry)).toMatchObject({
        claimed: true,
        by: "off_sweep",
        id: "FANSLY_REPLAY_FAMILY",
      });
    }
  });

  it("handles the runtime-minted `${endpoint}:failed` family by an explicit rule", () => {
    const rule = DYNAMIC_OBSERVATION_KIND_RULES.find((item) => item.id === "endpoint:failed");
    expect(rule, "the :failed family must be an explicit rule, not an omission").toBeDefined();
    expect(rule!.justification.length).toBeGreaterThan(40);
    // It is per-ENDPOINT, so no static list can hold it…
    expect(rule!.matches("dm_messages:failed")).toBe(true);
    expect(rule!.matches("posts:failed")).toBe(true);
    // …but it is not a wildcard either: the endpoint half must be a kind this
    // registry knows, or an unregistered lane could hide behind a suffix.
    expect(rule!.matches("some_new_lane:failed")).toBe(false);
    expect(rule!.matches("dm_messages")).toBe(false);
  });

  it("allowlists the vendor-named webhook kinds as claimed, and the unknown-desktop bucket as dynamic", () => {
    // The webhook events ARE typed by a family; what is impossible to type is
    // the SEAM (`kind: acceptedEnvelope.event`), so an unregistered vendor
    // event still fails this ratchet at runtime even though tsc cannot see it.
    const webhook = WRITTEN_OBSERVATION_KINDS.find((entry) => entry.kind === "messages.received")!;
    expect(claimObservationKind(webhook)).toMatchObject({ claimed: true, by: "family" });

    const desktopUnknown = DYNAMIC_OBSERVATION_KIND_RULES
      .find((rule) => rule.id === "desktop.unknown:<kind>");
    expect(desktopUnknown).toBeDefined();
    expect(desktopUnknown!.matches("desktop.unknown:whatever_the_client_sent")).toBe(true);
    expect(desktopUnknown!.matches("desktop.ai_spend")).toBe(false);
  });

  it("every dynamic rule and off-sweep claimant carries a written reason", () => {
    for (const rule of DYNAMIC_OBSERVATION_KIND_RULES) {
      expect(rule.writer.length, rule.id).toBeGreaterThan(0);
      expect(rule.justification.length, rule.id).toBeGreaterThan(40);
    }
    for (const claimant of OFF_SWEEP_OBSERVATION_CLAIMANTS) {
      expect(claimant.kinds.length, claimant.id).toBeGreaterThan(0);
      expect(claimant.justification.length, claimant.id).toBeGreaterThan(40);
    }
  });

  it("FAILS on a fake unclaimed kind (the ratchet actually bites)", () => {
    const fake: WrittenObservationKind = {
      kind: "fansly_totally_new_lane",
      source: "pull",
      writer: "tests/observation-kind-coverage.test.ts (synthetic)",
    };
    expect(claimObservationKind(fake)).toEqual({ claimed: false });
    // …and the suffix trick does not rescue it either.
    expect(claimObservationKind({ ...fake, kind: "fansly_totally_new_lane:failed" }))
      .toEqual({ claimed: false });
  });
});

describe("(2) census — the registry is compared against what the tree writes", () => {
  it("knows every sync-seam endpoint literal in the tree", () => {
    // `endpoint:` on RawPayloadInsertRow is the seam BL-C3 went through and the
    // one this initiative's ~27-30 new Fansly kinds will arrive on.
    const census = seamLiterals("endpoint", [
      "apps/runtime/src/services/sync",
      "apps/runtime/src/services/ofapi-link-stats-sync.ts",
    ]);
    const unregistered = [...census]
      .filter((kind) => !registered.has(kind) && !CENSUS_NON_KIND_LITERALS.has(kind));
    expect(unregistered, "sync-seam kinds written but not registered").toEqual([]);
    // Non-vacuous: the census must actually have found the lanes.
    expect(census.has("dm_messages")).toBe(true);
    expect(census.has("link_stats_tracking")).toBe(true);
    expect(census.has("fan_earnings_monthly")).toBe(true);
  });

  it("knows every OF capture-plane observationKind literal", () => {
    // Scoped to the capture plane: `observationKind` is also a field name on an
    // unrelated agent-read audit descriptor, which is not an observations.kind.
    const census = seamLiterals("observationKind", [
      "apps/runtime/src/services/ofapi-capture-jobs.ts",
      "apps/runtime/src/services/ofapi-capture-transport.ts",
      "apps/runtime/src/services/ofapi-export-quotes.ts",
      "packages/db/src/repositories/ofapi-capture.ts",
    ]);
    const unregistered = [...census].filter((kind) => !registered.has(kind));
    expect(unregistered, "OF capture kinds written but not registered").toEqual([]);
    expect(census.has("ofapi.chat_messages_page.v1")).toBe(true);
  });

  it("knows every namespaced kind literal any direct insertObservation writer uses", () => {
    // The OF seam is UNTYPED (A28-7 deferred typing it), so this grep is the
    // whole compile-time-substitute for it. Namespaced prefixes are greppable
    // without drowning in unrelated `kind:` discriminators.
    // Scoped to the files that actually call insertObservation (pinned by the
    // next test): `kind:` is a common discriminator elsewhere — notification
    // incidents use `kind: "ofapi_burn_rate"` and mean something else entirely.
    const census = new Set<string>();
    for (const line of grep('kind: *"(ofapi|desktop|harvest|command)[^"]*"', DIRECT_WRITERS)) {
      const match = /"([^"]+)"/.exec(line);
      if (match) {
        census.add(match[1]!);
      }
    }
    const unregistered = [...census].filter((kind) => !registered.has(kind));
    expect(unregistered, "namespaced observation kinds written but not registered").toEqual([]);
    expect(census.size).toBeGreaterThan(5);
  });

  it("registers EVERY subscribed OFAPI webhook event as a written webhook kind", () => {
    // The seam is `kind: acceptedEnvelope.event` (ofapi-webhook-capture.ts), so
    // the SUBSCRIPTION list is the census: every event we ask the vendor to
    // deliver becomes an observations.kind the moment it arrives. Three of them
    // (users.typing, chat_queue.updated, chat_queue.finished) were subscribed
    // and journaled while unregistered — invisible to the health-floor registry,
    // exactly the BL-C3 shape. This pin makes the next edit of
    // OFAPI_WEBHOOK_EVENTS fail CI until the kind is registered AND owned.
    const webhookKinds = new Set(
      WRITTEN_OBSERVATION_KINDS.filter((entry) => entry.source === "webhook")
        .map((entry) => entry.kind),
    );
    const unregistered = OFAPI_WEBHOOK_EVENTS.filter((event) => !webhookKinds.has(event));
    expect(
      unregistered,
      "subscribed OFAPI webhook events that no WRITTEN_OBSERVATION_KINDS entry registers — "
        + "the capture writer journals kind = the vendor event name, so each one IS a "
        + "written kind",
    ).toEqual([]);

    // Registration alone is not the guarantee: each must also be OWNED (family,
    // off-sweep, dynamic rule, or a justified raw-only entry).
    for (const event of OFAPI_WEBHOOK_EVENTS) {
      const entry = WRITTEN_OBSERVATION_KINDS.find((item) =>
        item.source === "webhook" && item.kind === event
      )!;
      expect(claimObservationKind(entry), event).toMatchObject({ claimed: true });
    }

    // Non-vacuous: the subscription list must actually have been imported.
    expect(OFAPI_WEBHOOK_EVENTS.length).toBeGreaterThan(15);
    expect(OFAPI_WEBHOOK_EVENTS).toContain("users.typing");
  });

  it("pins the set of files that write observations.kind directly", () => {
    const found = execFileSync("grep", [
      "-rlE",
      "insertObservation\\(",
      "--include=*.ts",
      "apps/runtime/src",
      "packages/db/src",
    ], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() !== "")
      .sort();

    expect(found).toEqual([...DIRECT_WRITERS].sort());
  });
});
