import { describe, expect, it } from "vitest";

import { DEPLOY_SCRIPT, ROLLBACK_BROWSER_GATE, rollbackBrowserGateFunction, runRollbackBrowserGate } from "./helpers/deploy-browser-rollback-gate.ts";

// The deploy's rollback refuses to return to an image older than the page
// transport (0277) while a page is on its browser or leaving it (Project
// Browser PR 14, Astra's review, P1): such an image would send through Node
// beside the page's browser, whose site socket outlives the engine's link.
// The gate runs for real in bash (tests/helpers/deploy-browser-rollback-gate.ts);
// its SQL runs on Postgres in tests/page-browser-db.integration.test.ts.

const BEFORE_0277 = ["0275_page_browsers.sql", "0276_page_browser_intake.sql"];

describe("deploy rollback gate: no page on its browser under an image that predates the page transport", () => {
  it("a rollback target that knows the transport (0277 was applied before this deploy) is not asked", () => {
    const run = runRollbackBrowserGate({ applied: [...BEFORE_0277, "0277_sync_pages_transport.sql"], answer: "3" });
    expect(run.status).toBe(0);
    expect(run.commands).toEqual([]);
    expect(run.stderr).toContain("gate passed");
  });

  it("a rollback to an image older than 0277: asked read-only; no page on its browser or leaving it — the rollback goes on", () => {
    const run = runRollbackBrowserGate({ applied: BEFORE_0277, answer: "0" });
    expect(run.status).toBe(0);
    expect(run.commands).toHaveLength(1);
    expect(run.sql).toBe("BEGIN READ ONLY;\nSELECT count(*)\nFROM sync_pages\nWHERE transport <> 'node'\n   OR browser_leave_generation IS NOT NULL;\nCOMMIT;\n");
    expect(run.stderr).toContain("No page is on its browser or leaving it");
  });

  it("names only the columns the schema has: the transport without 0278; nothing asked without 0277", () => {
    const transportOnly = runRollbackBrowserGate({ applied: BEFORE_0277, after: [...BEFORE_0277, "0277_sync_pages_transport.sql"], answer: "0" });
    expect(transportOnly.status).toBe(0);
    expect(transportOnly.sql).toBe("BEGIN READ ONLY;\nSELECT count(*)\nFROM sync_pages\nWHERE transport <> 'node';\nCOMMIT;\n");
    const none = runRollbackBrowserGate({ applied: BEFORE_0277, after: BEFORE_0277, answer: "5" });
    expect(none.status).toBe(0);
    expect(none.commands).toEqual([]);
  });

  it("a page on its browser or leaving it: the rollback is refused", () => {
    const run = runRollbackBrowserGate({ applied: BEFORE_0277, answer: "2" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2 page(s) are on their browser, or leaving it");
    expect(run.stderr).not.toContain("gate passed");
  });

  it("fails closed: the database out of reach, or an answer that is not a count", () => {
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
    expect(body.slice(gate, body.indexOf("fi", gate))).toContain("return 0");
    // The baseline it reads is the one the rollback decision reads.
    expect(rollbackBrowserGateFunction()).toContain('grep -Fxq "0277_sync_pages_transport.sql" "$SCHEMA_BEFORE_FILE"');
  });

  it("the migrations it guards are on the rollback-compatible list", () => {
    const compatible = DEPLOY_SCRIPT.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0] ?? "";
    expect(compatible).toContain('"0277_sync_pages_transport.sql"');
    expect(compatible).toContain('"0278_sync_pages_browser_leave.sql"');
  });
});
