import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEPLOY_SCRIPT,
  ROLLBACK_BROWSER_GATE,
  ROLLBACK_IMAGE,
  rollbackBrowserGateFunction,
  runRollbackBrowserGate,
} from "./helpers/deploy-browser-rollback-gate.ts";

// The deploy's rollback refuses to return to an image whose engine does not
// know the page transport while a page is on its browser or leaving it
// (Project Browser PR 14, Astra's reviews, P1): such an image would send
// through Node beside the page's browser, whose site socket outlives the
// engine's link. What the target can do is read from the image itself (its
// label `agency-hub.sync-page-transport`), never inferred from the schema's
// history: after a failed deploy that rolled back, the migrations stay
// applied while the old image runs, and are in the next deploy's baseline.
// The gate runs for real in bash (tests/helpers/deploy-browser-rollback-gate.ts);
// its SQL runs on Postgres in tests/page-browser-db.integration.test.ts.

const BEFORE_0277 = ["0275_page_browsers.sql", "0276_page_browser_intake.sql"];
const WITH_BOTH = [...BEFORE_0277, "0277_sync_pages_transport.sql", "0278_sync_pages_browser_leave.sql"];
const LABEL = "agency-hub.sync-page-transport";
const COUNT = "BEGIN READ ONLY;\nSELECT count(*)\nFROM sync_pages\nWHERE transport <> 'node'\n   OR browser_leave_generation IS NOT NULL;\nCOMMIT;\n";

describe("deploy rollback gate: no page on its browser under an image that does not know the page transport", () => {
  it("Astra's baseline — the migrations already applied before this deploy, the rollback target an old image: the pages are asked about, and one on its browser refuses the rollback", () => {
    // Deploy 1 applied 0277/0278 and rolled back (every page on Node): the old
    // image runs on the migrated schema. Deploy 2 has both in its baseline.
    const refused = runRollbackBrowserGate({ applied: WITH_BOTH, after: WITH_BOTH, label: "", answer: "1" });
    expect(refused.status).toBe(1);
    expect(refused.images).toEqual([`image inspect --format {{ index .Config.Labels "${LABEL}" }} ${ROLLBACK_IMAGE}`]);
    expect(refused.sql).toBe(COUNT);
    expect(refused.stderr).toContain("1 page(s) are on their browser, or leaving it");
    expect(refused.stderr).toContain(`does not know the page transport (no label ${LABEL} at level 1)`);
    expect(refused.stderr).not.toContain("gate passed");
    // Every page plainly on Node: the old image may run them all.
    const allowed = runRollbackBrowserGate({ applied: WITH_BOTH, after: WITH_BOTH, label: "", answer: "0" });
    expect(allowed.status).toBe(0);
    expect(allowed.sql).toBe(COUNT);
    expect(allowed.stderr).toContain("No page is on its browser or leaving it");
  });

  it("a rollback target whose label says it knows the page transport is not asked about the pages, whatever the schema's history", () => {
    for (const applied of [BEFORE_0277, WITH_BOTH]) {
      const run = runRollbackBrowserGate({ applied, after: WITH_BOTH, label: "1", answer: "3" });
      expect(run.status).toBe(0);
      expect(run.images).toHaveLength(1);
      expect(run.sql).toBeNull();
      expect(run.stderr).toContain(`The rollback image knows the page transport (${LABEL}=1)`);
      expect(run.stderr).toContain("gate passed");
    }
    // A later level knows it too.
    expect(runRollbackBrowserGate({ applied: WITH_BOTH, after: WITH_BOTH, label: "2", answer: "3" }).status).toBe(0);
  });

  it("no label, an empty one, a lower level or anything that is no level: an image that does not know the transport", () => {
    for (const label of ["", "<no value>", "0", "yes", "1.5", "-1"]) {
      const run = runRollbackBrowserGate({ applied: BEFORE_0277, label, answer: "2" });
      expect(run.status, label).toBe(1);
      expect(run.sql, label).toBe(COUNT);
      expect(run.stderr, label).toContain("2 page(s) are on their browser, or leaving it");
    }
  });

  it("names only the columns the schema has now: the transport without 0278; without 0277 no page can stand off Node and nothing is asked", () => {
    const transportOnly = runRollbackBrowserGate({ applied: BEFORE_0277, after: [...BEFORE_0277, "0277_sync_pages_transport.sql"], answer: "0" });
    expect(transportOnly.status).toBe(0);
    expect(transportOnly.sql).toBe("BEGIN READ ONLY;\nSELECT count(*)\nFROM sync_pages\nWHERE transport <> 'node';\nCOMMIT;\n");
    const none = runRollbackBrowserGate({ applied: BEFORE_0277, after: BEFORE_0277, answer: "5", imageFails: true });
    expect(none.status).toBe(0);
    expect(none.commands).toEqual([]);
  });

  it("fails closed: the rollback image cannot be read, the database is out of reach, or its answer is no count", () => {
    const unread = runRollbackBrowserGate({ applied: WITH_BOTH, after: WITH_BOTH, imageFails: true, answer: "0" });
    expect(unread.status).toBe(1);
    expect(unread.sql).toBeNull();
    expect(unread.stderr).toContain(`The rollback image ${ROLLBACK_IMAGE} cannot be read`);
    expect(runRollbackBrowserGate({ applied: BEFORE_0277, remoteFails: true }).status).toBe(1);
    expect(runRollbackBrowserGate({ applied: BEFORE_0277, answer: "ERROR: relation does not exist" }).status).toBe(1);
    expect(runRollbackBrowserGate({ applied: BEFORE_0277, answer: "" }).status).toBe(1);
  });

  it("the rollback asks it before it rolls anything back, and skips the rollback when it refuses", () => {
    const rollback = DEPLOY_SCRIPT.slice(DEPLOY_SCRIPT.indexOf("rollback_remote_stack() {"));
    const body = rollback.slice(0, rollback.indexOf("\n}\n"));
    const gate = body.indexOf(`if ! ${ROLLBACK_BROWSER_GATE}; then`);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf('log "Rolling back remote stack to ${ROLLBACK_IMAGE_TAG}"'));
    expect(body.slice(gate, body.indexOf("\n  fi\n", gate))).toContain("return 0");
    // Never from the baseline: what the target can do is the image's to say.
    expect(rollbackBrowserGateFunction()).not.toContain("SCHEMA_BEFORE_FILE");
    expect(rollbackBrowserGateFunction()).toContain('"$ROLLBACK_IMAGE_TAG"');
  });

  it("the runtime image says its level in the label the gate reads, at the level the gate needs", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
    const level = runtime.match(new RegExp(`^LABEL ${LABEL.replaceAll(".", "\\.")}="(\\d+)"$`, "m"))?.[1];
    expect(level).toBeDefined();
    const gate = rollbackBrowserGateFunction();
    expect(gate).toContain(`local label="${LABEL}"`);
    const needed = gate.match(/^ {2}local needed=(\d+)$/m)?.[1];
    expect(needed).toBeDefined();
    expect(Number(level)).toBeGreaterThanOrEqual(Number(needed));
  });

  it("the migrations it guards are on the rollback-compatible list", () => {
    const compatible = DEPLOY_SCRIPT.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0] ?? "";
    expect(compatible).toContain('"0277_sync_pages_transport.sql"');
    expect(compatible).toContain('"0278_sync_pages_browser_leave.sql"');
  });
});
