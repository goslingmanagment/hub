import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routeSchemas } from "@agency_hub_core/contracts";
import { CONSOLE_ONLY_READS, teamLeadRefusal } from "../apps/runtime/src/services/team-lead-reads.ts";

// Hub is the owner's (products plan §2.2): a team lead keeps every dashboard-session read Workboard calls and none of
// the console's alone. The table is recomputed here from the contract and Workboard's code (with packages/ui, which it
// draws with), so a console read added later is closed to a team lead until it is written in the table.

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

const workboardCode = [...sources("apps/workboard/src"), ...sources("packages/ui/src")].join("\n");
const workboardReads = new Set([...workboardCode.matchAll(/kernel\.([a-zA-Z]+)\b/g)].map((match) => match[1]!));

const dashboardSessionReads = Object.entries(routeSchemas as Record<string, { auth?: { kind?: string; roles?: readonly string[] } }>)
  .filter(([, route]) => (route.auth?.kind === "session" || route.auth?.kind === "monitoring"))
  .map(([key]) => key);

describe("a team lead's reads", () => {
  it("are refused exactly the dashboard-session reads Workboard never calls", () => {
    const consoleOnly = dashboardSessionReads.filter((key) => !workboardReads.has(key)).sort();
    expect([...CONSOLE_ONLY_READS].sort()).toEqual(consoleOnly);
  });

  it("keep every read Workboard calls", () => {
    for (const key of dashboardSessionReads.filter((one) => workboardReads.has(one))) expect(CONSOLE_ONLY_READS.has(key), key).toBe(false);
  });

  it("refuse a team lead only, never the owner, a chatter or an agent", () => {
    const user = (role: string) => ({ authMethod: "session", user: { id: 1, username: "x", role } }) as unknown as Parameters<typeof teamLeadRefusal>[1];
    expect(teamLeadRefusal("overview", user("team_lead"))?.statusCode).toBe(403);
    expect(teamLeadRefusal("teamShifts", user("team_lead"))).toBeNull();
    expect(teamLeadRefusal("overview", user("owner"))).toBeNull();
    expect(teamLeadRefusal("overview", { kind: "agent" } as unknown as Parameters<typeof teamLeadRefusal>[1])).toBeNull();
  });
});
