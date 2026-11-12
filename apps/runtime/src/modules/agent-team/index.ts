import { routeSchemas } from "@agency_hub_core/contracts";

import { readAgentFanWatch, readAgentSaleContext, readAgentShiftReview } from "../../services/agent-doors.ts";
import { readAgentTeamSales } from "../../services/agent-team-sales.ts";
import { beginAgentRequest, staticNotFound, withAgentTimeout, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * The team's sale facts for the agency ledger (`agentTeamSales`, ledger
 * release 2): an agent key with read:team and read:money reads the team's
 * work and every sale on its pages in a window, with the facts the ledger's
 * split rules read. No text of anyone's messages, no shift report's money:
 * facts only. Database only, read-only.
 */

/** A month of the team's work and sales is read in one statement budget. */
const AGENT_TEAM_TIMEOUT_MS = 60_000;
/** The fan watch and the report check: a run's worth of watches or a shift's sales. */
const AGENT_DOOR_TIMEOUT_MS = 30_000;

export function registerAgentTeamRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requireAgentKeyPrincipal } = ctx.auth;

  server.post("/api/v1/agent/team/sales", { schema: routeSchemas.agentTeamSales }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentTeamSales", requiredCapabilities: ["read:team", "read:money"] });
    let delivered = 0;
    try {
      const pages = scope.pages.map((page) => ({ id: page.id, label: page.pageLabel }));
      const from = new Date(request.body.from);
      const to = new Date(request.body.to);
      const result = await withAgentTimeout(appContext.db, AGENT_TEAM_TIMEOUT_MS, (tx) => readAgentTeamSales(tx, { from, to, now: new Date(), pages }), "agent_team_sales");
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentTeamSales",
        pageIds: pages.map((page) => page.id),
        verbatimText: false,
        // The audit's closed vocabulary (agent-read-audit.ts): the window and how many sales went out.
        requestSummary: { windowFrom: result.from, windowTo: result.to, returned: result.sales.length },
      });
      delivered = result.sales.length;
      return result;
    } finally {
      await scope.finish(delivered);
    }
  });

  // «Разбор смены» for an agent (ecosystem plan §3.3): the shift audit takes it ready instead of
  // recomputing it over psql. The review runs its own reads (several statements, not one transaction).
  server.get("/api/v1/agent/team/shift-review", { schema: routeSchemas.agentShiftReview }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, {
      operation: "agentShiftReview", requiredCapabilities: ["read:team", "read:money"],
    });
    let delivered = 0;
    try {
      const texts = scope.has("read:messages");
      const result = await readAgentShiftReview(appContext, { pages: scope.pages, texts, money: true }, request.query);
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentShiftReview",
        pageIds: scope.pages.filter((page) => result.review.shift.pages.some((one) => one.pageLabel === page.pageLabel)).map((page) => page.id),
        verbatimText: texts,
        requestSummary: { windowFrom: result.review.shift.startedAt, windowTo: result.review.shift.endedAt, returned: result.review.chats.length },
      });
      delivered = result.review.chats.length;
      return result;
    } finally {
      await scope.finish(delivered);
    }
  });

  // The fan watch (work/watch-fan): a watched fan's new messages and the page's last word, read-only.
  server.post("/api/v1/agent/team/fan-watch", { schema: routeSchemas.agentFanWatch }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentFanWatch", requiredCapabilities: ["read:messages"] });
    let delivered = 0;
    try {
      const pages = { pages: scope.pages, texts: true, money: scope.has("read:money") };
      const result = await withAgentTimeout(appContext.db, AGENT_DOOR_TIMEOUT_MS, (tx) => readAgentFanWatch(tx, pages, request.body), "agent_fan_watch");
      if (result === null) throw staticNotFound();
      const returned = result.watches.reduce((sum, watch) => sum + watch.fanMessages.length, 0);
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentFanWatch",
        pageIds: [...new Set(scope.pages.filter((page) => request.body.watches.some((watch) => watch.pageLabel === page.pageLabel)).map((page) => page.id))],
        verbatimText: true,
        requestSummary: { fans: request.body.watches.length, returned },
      });
      delivered = returned;
      return result;
    } finally {
      await scope.finish(delivered);
    }
  });

  // The report check (shift-sales-report): each sale's fan, bought PPV and who wrote before it.
  server.post("/api/v1/agent/team/sale-context", { schema: routeSchemas.agentSaleContext }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentSaleContext", requiredCapabilities: ["read:team", "read:money"] });
    let delivered = 0;
    try {
      const texts = scope.has("read:messages");
      const pages = { pages: scope.pages, texts, money: true };
      const result = await withAgentTimeout(appContext.db, AGENT_DOOR_TIMEOUT_MS, (tx) => readAgentSaleContext(tx, pages, request.body), "agent_sale_context");
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentSaleContext",
        pageIds: [...new Set(result.sales.map((sale) => scope.pages.find((page) => page.pageLabel === sale.pageLabel)!.id))],
        verbatimText: texts,
        requestSummary: { asked: request.body.sales.length, returned: result.sales.length },
      });
      delivered = result.sales.length;
      return result;
    } finally {
      await scope.finish(delivered);
    }
  });
}
