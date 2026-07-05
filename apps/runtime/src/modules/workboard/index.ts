import { routeSchemas } from "@agency_hub_core/contracts";

import { requireDashboardUser, requireOwner, requireSessionUser } from "../../services/auth.ts";
import {
  getWorkboardReport,
  snoozeWorkboardFanReport,
  unsnoozeWorkboardFanReport,
} from "../../services/workboard.ts";
import { getWorkboardPresenceReport } from "../../services/workboard-presence.ts";
import {
  claimWorkboardV2Fan,
  getWorkboardV2Lists,
  getWorkboardV2Report,
  recordWorkboardContactV2,
  snoozeWorkboardV2,
  triggerWorkboardV2Recompute,
  unclaimWorkboardV2Fan,
  undoWorkboardContactV2,
  unsnoozeWorkboardV2,
} from "./report.ts";
import {
  getWorkboardV2AiReport,
  listWorkboardV2AiRuns,
  runWorkboardV2AiClassify,
  updateWorkboardV2AiSettings,
} from "./ai-analytics.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// The module's exported service interface (worker sweeps, classifier, tests
// reach engine internals ONLY through here — the Stage 19 walls enforce it).
export * from "./engine.ts";
export * from "./recompute.ts";
export * from "./closing-classifier.ts";
export * from "./classify-closing.ts";
export * from "./ai-analytics.ts";
export * from "./report.ts";
export * from "./types.ts";
export * from "./ai-settings.ts";
export * from "./closing.ts";
export * from "./spender-diagnostics.ts";
export * from "./page-access.ts";

// Workboard module (target §6.1): board reads, contact log, snoozes, classifier
// admin. Handlers relocated verbatim from server.ts (Stage 19 Task 3) — the
// in-handler guards are the legacy layer retiring after the enforce flip.

export function registerWorkboardRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/pages/:pageLabel/workboard", {
    schema: routeSchemas.workboard,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardReport(appContext, principal, request.params.pageLabel);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/presence", {
    schema: routeSchemas.workboardPresence,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardPresenceReport(appContext, principal, request.params.pageLabel);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/snooze", {
    schema: routeSchemas.workboardSnooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return snoozeWorkboardFanReport(appContext, principal, request.params.pageLabel, request.body);
  });

  server.delete("/api/v1/pages/:pageLabel/workboard/snooze/:fanId", {
    schema: routeSchemas.workboardUnsnooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return unsnoozeWorkboardFanReport(appContext, principal, request.params.pageLabel, request.params.fanId);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/v2", {
    schema: routeSchemas.workboardV2,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardV2Report(appContext, principal, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/v2/lists", {
    schema: routeSchemas.workboardV2Lists,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardV2Lists(appContext, principal, request.params.pageLabel);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/contact", {
    schema: routeSchemas.workboardV2Contact,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return recordWorkboardContactV2(appContext, principal, request.params.pageLabel, request.body);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/recompute", {
    schema: routeSchemas.workboardV2Recompute,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return triggerWorkboardV2Recompute(appContext, principal, request.params.pageLabel);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/snooze", {
    schema: routeSchemas.workboardV2Snooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return snoozeWorkboardV2(appContext, principal, request.params.pageLabel, request.body);
  });

  server.delete("/api/v1/pages/:pageLabel/workboard/v2/snooze/:fanId", {
    schema: routeSchemas.workboardV2Unsnooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return unsnoozeWorkboardV2(appContext, principal, request.params.pageLabel, request.params.fanId);
  });

  server.delete("/api/v1/pages/:pageLabel/workboard/v2/contact/:fanId", {
    schema: routeSchemas.workboardV2UndoContact,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return undoWorkboardContactV2(appContext, principal, request.params.pageLabel, request.params.fanId);
  });

  // Stage 23: claim leases — any-session (chatters claim their own work), not
  // dashboard-only like the reads above; page access is the real boundary.
  server.post("/api/v1/pages/:pageLabel/workboard/v2/claim", {
    schema: routeSchemas.workboardV2Claim,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    return claimWorkboardV2Fan(appContext, principal, request.params.pageLabel, request.body);
  });

  server.delete("/api/v1/pages/:pageLabel/workboard/v2/claim/:fanId", {
    schema: routeSchemas.workboardV2Unclaim,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    return unclaimWorkboardV2Fan(appContext, principal, request.params.pageLabel, request.params.fanId);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/v2/ai", {
    schema: routeSchemas.workboardV2Ai,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal); // settings/cost/verdicts are owner-only; the board's coverage banner uses a separate read
    return getWorkboardV2AiReport(appContext, principal, request.params.pageLabel);
  });

  server.put("/api/v1/pages/:pageLabel/workboard/v2/ai/settings", {
    schema: routeSchemas.workboardV2AiSettings,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return updateWorkboardV2AiSettings(appContext, principal, request.params.pageLabel, request.body);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/ai/classify", {
    schema: routeSchemas.workboardV2AiClassify,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return runWorkboardV2AiClassify(appContext, principal, request.params.pageLabel, request.body);
  });

  server.get("/api/v1/workboard/ai/runs", {
    schema: routeSchemas.workboardV2AiRuns,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listWorkboardV2AiRuns(appContext);
  });
}
