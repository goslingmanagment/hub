import {
  agentMatterCloseBodySchema,
  agentMatterCommentBodySchema,
  agentMatterCommentResponseSchema,
  agentMatterOpenBodySchema,
  agentMatterResponseSchema,
  clientMattersResponseSchema,
  mattersListQuerySchema,
  mattersListResponseSchema,
  mattersWaitingQuerySchema,
  mattersWaitingResponseSchema,
} from "./matters.ts";
import { errorResponseSchema } from "./primitives.ts";

// Дела (ecosystem plan, package D). A person reads their matters by session
// (the owner every one); the extension's narrow token reads the person's count
// and newest matters, without evidence; an agent key with write:matters opens,
// closes and comments by reason key, its own kinds only. Database only.

const readErrors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema } as const;
const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  // matter_not_agents (the server's kind or another writer's key) | person_unknown
  409: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema,
} as const;

export const matterRouteSchemas = {
  mattersList: {
    auth: { kind: "any-session" }, tags: ["admin"],
    summary: "The caller's matters: the owner's every one, by kind; a team lead's own and their role's on their pages; a chatter's own",
    description: "Database only. Open matters the longest waiting first, closed the last closed first. A matter with money "
      + "evidence is the owner's alone. `kinds` says for every kind Hub mirrors whether its source answered lately: "
      + "`no` is «не проверено», never a zero.",
    querystring: mattersListQuerySchema,
    response: { 200: mattersListResponseSchema, ...readErrors },
  },
  mattersWaiting: {
    auth: { kind: "session" }, tags: ["admin"],
    summary: "«Ждут вас» read from matters, by the list's groups (waiting-groups.ts): the chips, the menu's number and the list's counts",
    description: "Database only. What waits for the viewer themself, every role grouped by the one table; the number is "
      + "the groups' sum. A group whose source did not answer lately has `checked: false` («не удалось проверить») and "
      + "is in `failed`. `active` is the owner's switch: until it is on, the screens keep their own reads and Hub "
      + "compares the two counts in the background (matter_checks).",
    querystring: mattersWaitingQuerySchema,
    response: { 200: mattersWaitingResponseSchema, ...readErrors },
  },
  clientMatters: {
    auth: { kind: "apiKey" }, tags: ["client"],
    summary: "How many matters wait for the person, and the newest 50 of them: titles and links, no evidence",
    description: "Database only. The device token's person: their own matters (a team lead's also their role's on their "
      + "pages, the owner's every one); never a matter with money evidence.",
    response: { 200: clientMattersResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
  },
  agentMatterOpen: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Open a matter by its reason key for a person (by login) or a role; the same key again updates it, a closed one"
      + " reopens (needs write:matters)",
    description: "Database only. The agent's own kinds: a kind Hub's server mirrors, or a key another writer holds, is 409 "
      + "`matter_not_agents`. Pages must be of the key's grant.",
    body: agentMatterOpenBodySchema,
    response: { 200: agentMatterResponseSchema, ...agentErrors },
  },
  agentMatterClose: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Close a matter the agent opened, by its key: resolved, withdrawn or cause gone; a closed one stays as it was"
      + " (needs write:matters)",
    body: agentMatterCloseBodySchema,
    response: { 200: agentMatterResponseSchema, ...agentErrors },
  },
  agentMatterComment: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Comment a matter by its key, in its history (needs write:matters)",
    body: agentMatterCommentBodySchema,
    response: { 200: agentMatterCommentResponseSchema, ...agentErrors },
  },
} as const;
