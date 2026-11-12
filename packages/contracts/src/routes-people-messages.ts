import {
  peopleMessageKindParamsSchema,
  peopleMessagePressBodySchema,
  peopleMessagePressResponseSchema,
  peopleMessageRecipientQuerySchema,
  peopleMessageRecipientResponseSchema,
  peopleMessagesResponseSchema,
  peopleMessageSwitchBodySchema,
  peopleMessageSwitchResponseSchema,
} from "./people-messages.ts";
import { errorResponseSchema } from "./primitives.ts";

// Система → «Сообщения людям» (package S): the owner's screen of the server's
// sender, the owner's switch of one kind (audited as every live setting) and
// the owner's press for the kinds sent by a button. Every route is the
// owner's session. Nothing here talks to Telegram but the press, and only
// with the token set and the kind on.

const ownerErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  // the kinds setting changed since the screen read it
  409: errorResponseSchema,
} as const;

export const peopleMessageRouteSchemas = {
  peopleMessages: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Система → Сообщения людям: every kind with its template, an example, whether it is on and what was held",
    description: "Database only. Whether the bot token is set (never its value), the work chats per model, and per kind: "
      + "to whom and when, the exact template, an example rendered from the newest real object, on or off and the last "
      + "switch, the cap and quiet hours, and the 7 days' held messages word for word.",
    response: { 200: peopleMessagesResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
  },
  peopleMessageSwitch: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Turn one kind of messages to people on or off (the owner's word, audited)",
    description: "Writes the live setting peopleMessageKinds through the audited config path (config_audit_log and "
      + "admin.config_update). Only an event after the moment a kind is turned on sends; a held message never does. "
      + "One kind per call: there is no «turn everything on».",
    params: peopleMessageKindParamsSchema,
    body: peopleMessageSwitchBodySchema,
    response: { 200: peopleMessageSwitchResponseSchema, ...ownerErrors },
  },
  peopleMessageRecipient: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Whether the owner's press would reach the person: the button's words, or the one line why it cannot",
    description: "Database only, no call to Telegram. Shown only with the kind on and the bot token set. A person "
      + "without a Telegram id in the registry, or one whose last send Telegram refused because they never wrote to the "
      + "bot or blocked it, gets the line instead of the button.",
    querystring: peopleMessageRecipientQuerySchema,
    response: { 200: peopleMessageRecipientResponseSchema, ...ownerErrors },
  },
  peopleMessagePress: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Send the payout text or the invitation to the person by Telegram (the owner's press)",
    description: "The same rules as every kind: with the kind off or no token the message is held and nothing leaves. "
      + "One attempt; an attempt that does not answer is `unknown` and is never repeated by itself. The same text to the "
      + "same person the same day is `duplicate`. An invitation's one-time link is not kept in the stored text.",
    body: peopleMessagePressBodySchema,
    response: { 200: peopleMessagePressResponseSchema, ...ownerErrors },
  },
} as const;
