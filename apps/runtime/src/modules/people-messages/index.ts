import { routeSchemas } from "@agency_hub_core/contracts";

import { pressPeopleMessage, readPeopleMessageRecipient, readPeopleMessages, switchPeopleMessageKind } from "../../services/people-messages/index.ts";
import { telegramPeopleTransport } from "../../services/people-messages/transport.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Система → «Сообщения людям» (ecosystem plan 2026-11-12, package S): the
 * owner's screen of the server's sender, the owner's switch of one kind and the
 * owner's press for the payout text and the invitation. Every route is the
 * owner's session (the route's auth). The screen reads only; the switch writes
 * the live setting through the audited config path; the press sends only with
 * the bot token set and the kind on.
 */
export function registerPeopleMessageRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/system/people-messages", { schema: routeSchemas.peopleMessages }, async () => readPeopleMessages(appContext));

  server.post("/api/v1/system/people-messages/kinds/:kind", { schema: routeSchemas.peopleMessageSwitch }, async (request) => {
    const principal = await requirePrincipal(request);
    return switchPeopleMessageKind(appContext, principal, request.params.kind, request.body);
  });

  server.get("/api/v1/system/people-messages/recipient", { schema: routeSchemas.peopleMessageRecipient }, async (request) =>
    readPeopleMessageRecipient(appContext, request.query));

  server.post("/api/v1/system/people-messages/press", { schema: routeSchemas.peopleMessagePress }, async (request) => {
    const principal = await requirePrincipal(request);
    return pressPeopleMessage(appContext, principal, request.body, { transport: telegramPeopleTransport(appContext) });
  });
}
