import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  acceptanceIncidentKeys,
  ACCEPTANCE_CHECKS,
  ACCEPTANCE_LATENCY_SLOS,
  ACCEPTANCE_RULES,
  ACCEPTANCE_SLO_RESOURCES,
} from "../apps/runtime/src/sync/switch/acceptance-rules.ts";
import {
  FAMILY_BUDGETS,
  FANSLY_LEGACY_OPERATION_ROUTES,
  FANSLY_ROUTE_FAMILY_IDS,
  FANSLY_ROUTES,
  familyOfRoute,
  routeBudget,
} from "../apps/runtime/src/sync/fansly/routes.ts";
import { ACCEPTANCE_SQL_PATH } from "./helpers/sync-acceptance-fixtures.ts";

// step3-accept.sql v2 (step 3b A6: "SQL and runtime use the same route
// mapping, window, count/recovery/inconclusive rules and SLO tails") keeps its
// own copy of the route table, the legacy operation map and every number of
// the acceptance — psql cannot import the code. This pins each copy to the
// code; tests/sync-switch-acceptance.integration.test.ts runs both on the
// shared fixtures.

const script = readFileSync(ACCEPTANCE_SQL_PATH, "utf8");

function psqlVariables(): Map<string, string> {
  const variables = new Map<string, string>();
  for (const match of script.matchAll(/^\\set (\w+) (\S+)$/gm)) variables.set(match[1]!, match[2]!);
  return variables;
}

/** The rows of the VALUES list that ends with `) as t(<columns>)`. */
function valuesRows(columns: string): string[][] {
  const end = script.indexOf(`) as t(${columns})`);
  expect(end, `a VALUES list "as t(${columns})"`).toBeGreaterThan(0);
  const start = script.lastIndexOf("(values", end);
  return script
    .slice(start + "(values".length, end)
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line.startsWith("("))
    .map((line) => line.slice(1, -1).split(",").map((cell) => cell.trim().replace(/^'(.*)'$/, "$1")));
}

describe("step3-accept.sql v2 against the code", () => {
  it("sets every number of the acceptance as the code has it", () => {
    const variables = psqlVariables();
    const expected: Record<string, number> = {
      window_ms: ACCEPTANCE_RULES.windowMs,
      min_samples: ACCEPTANCE_RULES.minSamples,
      media_start_ms: ACCEPTANCE_RULES.mediaStartMs,
      budget_w1_ms: ACCEPTANCE_RULES.budgetWindowsMs[0]!,
      budget_w2_ms: ACCEPTANCE_RULES.budgetWindowsMs[1]!,
      budget_slack: ACCEPTANCE_RULES.budgetSlackSends,
      first_hold_ms: ACCEPTANCE_RULES.firstHoldMs,
      slowdown_factor: ACCEPTANCE_RULES.slowdownFactor,
      slowdown_floor_share: ACCEPTANCE_RULES.slowdownFloorShare,
      network_failures_to_hold: ACCEPTANCE_RULES.networkFailuresToHold,
      alert_clean_ms: ACCEPTANCE_RULES.alertCleanMs,
      lookback_ms: ACCEPTANCE_RULES.lookbackMs,
      send_window_ms: ACCEPTANCE_RULES.sendWindowMs,
      mismatch_share: ACCEPTANCE_RULES.mismatchShare,
      unconfirmed_after_ms: ACCEPTANCE_RULES.unconfirmedAfterMs,
    };
    for (const slo of ACCEPTANCE_LATENCY_SLOS) expected[`${slo.name}_s`] = slo.boundSeconds;
    expect(ACCEPTANCE_RULES.budgetWindowsMs).toHaveLength(2);
    for (const [name, value] of Object.entries(expected)) {
      expect({ name, value: Number(variables.get(name)) }).toEqual({ name, value });
    }
  });

  it("carries the route table of fansly/routes.ts: every route, its family and its budget", () => {
    const rows = valuesRows("route, wire, family, ceiling, current");
    const expected = [...FANSLY_ROUTES.values()].map((spec) => {
      const budget = routeBudget(spec.route);
      return [spec.route, String(spec.wire !== null), familyOfRoute(spec.route) ?? "null", String(budget.ceilingPerMin), String(budget.currentPerMin)];
    });
    expect(rows.sort()).toEqual(expected.sort());
  });

  it("carries the family budgets", () => {
    expect(valuesRows("family, ceiling, current").sort()).toEqual(
      FANSLY_ROUTE_FAMILY_IDS.map((family) => [family, String(FAMILY_BUDGETS[family].ceilingPerMin), String(FAMILY_BUDGETS[family].currentPerMin)]).sort(),
    );
  });

  it("carries the legacy operation map, complete", () => {
    expect(valuesRows("operation, route").sort()).toEqual(Object.entries(FANSLY_LEGACY_OPERATION_ROUTES).sort());
  });

  it("judges the SLOs the code judges: name, order, bound variable, measure, resource", () => {
    const spec = valuesRows("name, ord, bound_s, measure");
    expect(spec).toEqual(ACCEPTANCE_LATENCY_SLOS.map((slo) => [
      slo.name, String(ACCEPTANCE_CHECKS.indexOf(slo.name) + 1), `:${slo.name}_s`, slo.measure,
    ]));
    for (const slo of ACCEPTANCE_LATENCY_SLOS) {
      if (!("resource" in slo)) continue;
      expect(script).toContain(`select page_id, '${slo.name}', latency_s from wk where resource = '${slo.resource}'`);
    }
    expect(script).toContain(`k.resource in (${ACCEPTANCE_SLO_RESOURCES.map((resource) => `'${resource}'`).join(", ")})`);
  });

  it("reads the engine's latches under the keys the code builds: alert 1, and a route's own incident by its prefix", () => {
    // `fansly_sync_engine:7:page_stopped` → 'fansly_sync_engine:' || w.page_id || ':page_stopped'
    const sqlKey = (key: string) => `'${key.replace(":7:", ":' || w.page_id || ':")}'`;
    const keys = acceptanceIncidentKeys(7);
    expect(script.split(`n.incident_key = ${sqlKey(keys.pageStopped)}`)).toHaveLength(2);
    expect(script.split(`c.incident_key = ${sqlKey(keys.pageStopped)}`)).toHaveLength(2);
    expect(script).toContain(`starts_with(n.incident_key, ${sqlKey(keys.routePrefix)})`);
    expect(script).toContain(`length(n.incident_key) > length(${sqlKey(keys.routePrefix)})`);
    // No other way to leave an incident to the route rule (an error code never decides it).
    expect(script).not.toMatch(/error_code\s*!?~/);
  });

  it("names every check of the code, in its order", () => {
    for (const [index, name] of ACCEPTANCE_CHECKS.entries()) {
      const ord = index + 1;
      const named = new RegExp(`(\\b${ord}( as ord)?, '${name}'|'${name}', ${ord}\\b|'ord', ${ord}, 'check', '${name}')`);
      expect({ name, found: named.test(script) }).toEqual({ name, found: true });
    }
  });

  it("is read-only and ends with the verdict as JSON", () => {
    expect(script).not.toMatch(/\b(insert|update|delete|truncate|create|drop|alter)\s+(into|from|table|or|index|\w+\s+set)\b/i);
    expect(script.trimEnd().endsWith("\\echo :verdicts")).toBe(true);
  });
});
