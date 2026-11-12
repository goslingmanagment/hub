import {
  adminPeopleProposalsQuerySchema,
  adminPeopleProposalsResponseSchema,
  adminPersonCreateBodySchema,
  adminPersonCreateResponseSchema,
  adminPersonImportNoteSettleBodySchema,
  adminPersonPayTermBodySchema,
  adminPersonProposalDecideBodySchema,
  adminPersonProposalDecideResponseSchema,
  adminPersonProposalParamsSchema,
  adminPersonResponseSchema,
  adminPersonUpdateBodySchema,
  agentPeopleQuerySchema,
  agentPeopleResponseSchema,
  agentPersonProposalBodySchema,
  agentPersonProposalResponseSchema,
  agentPersonProposalsQuerySchema,
  agentPersonProposalsResponseSchema,
  personCodeParamsSchema,
  teamPeopleResponseSchema,
} from "./people.ts";
import {
  accountPayoutDetailsBodySchema,
  accountPayoutDetailsResponseSchema,
  accountStartResponseSchema,
} from "./person-start.ts";
import { errorResponseSchema } from "./primitives.ts";

// The people registry (people.ts): the team's list for a session, the
// owner's card of one person with the pay terms and every write, and the
// agent key's twins — the feed (`read:team`, pay terms only with
// `read:pay_terms`) and proposals (`propose:people`) that wait for the owner.
// Database only.

const sessionErrors = { 401: errorResponseSchema, 403: errorResponseSchema } as const;
const ownerErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  // a code, a login, a Telegram id or a report tag another person has; a decided proposal
  409: errorResponseSchema,
} as const;
const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  409: errorResponseSchema, 503: errorResponseSchema,
} as const;

export const peopleRouteSchemas = {
  accountStart: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "«Начало»: the caller's own way from the invitation to the first shift, each step closed by what Hub sees",
    description: "Workboard «Начало». The person of the session's login (null when the login is nobody's): the extension "
      + "installed and signed in, the pages opened, the first active minute, where payouts go — the caller's own, "
      + "never anyone else's. A narrow session (from the extension) reads it too, without where payouts go: "
      + "`payoutDetails.text` is null for it (written, and when, is all it learns), and writing it needs a "
      + "password (accountPayoutDetailsSet is refused to it). Database only.",
    response: { 200: accountStartResponseSchema, ...sessionErrors },
  },
  accountPayoutDetailsSet: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "Write where the caller's own payouts go (free text; empty clears it)",
    description: "The person of the session's login writes their own; read back by them and by the owner's card only. "
      + "Not checked, not a wallet. Audited without the text. 409 when the login is nobody's in the registry.",
    body: accountPayoutDetailsBodySchema,
    response: { 200: accountPayoutDetailsResponseSchema, 400: errorResponseSchema, ...sessionErrors, 409: errorResponseSchema },
  },
  teamPeople: {
    auth: { kind: "session" }, tags: ["admin"],
    summary: "The people of the agency, one record per person, with their logins, agent keys, working pages, schedule, rights"
      + " and Telegram — no money",
    description: "The owner and a team lead. The owner also gets the Hub logins no person holds yet. Pay terms are never here: "
      + "they are in the owner's adminPerson.",
    response: { 200: teamPeopleResponseSchema, ...sessionErrors },
  },
  adminPerson: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "One person with everything: the record, every schedule slot, the pay terms and the agents' proposals",
    params: personCodeParamsSchema,
    response: { 200: adminPersonResponseSchema, ...ownerErrors },
  },
  adminPersonCreate: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Create a person, and with `invite` their login and invite link, with `payTerms` their pay terms, in the same transaction",
    description: "A failure on any part (a taken code, login, Telegram id or tag, a missing page or model) leaves nothing behind. "
      + "The raw invite token is returned exactly once.",
    body: adminPersonCreateBodySchema,
    response: { 200: adminPersonCreateResponseSchema, ...ownerErrors },
  },
  adminPersonUpdate: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Change a person: the record, logins and keys linked, working pages, a new schedule from a day, rights, onboarding",
    description: "Only the fields given change; lists (working pages, rights, onboarding) are replaced whole. A schedule change "
      + "ends the slot holding on `from` the day before. Audited.",
    params: personCodeParamsSchema,
    body: adminPersonUpdateBodySchema,
    response: { 200: adminPersonResponseSchema, ...ownerErrors },
  },
  adminPersonPayTermSet: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Set a person's pay terms on a model from a day: share and fix per shift; the same day again corrects it",
    description: "Money, the owner's only. A term holds until the person's next term of the same model. Audited with the values "
      + "before and after.",
    params: personCodeParamsSchema,
    body: adminPersonPayTermBodySchema,
    response: { 200: adminPersonResponseSchema, ...ownerErrors },
  },
  adminPersonImportNoteSettle: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Mark one of a person's import notes «Сверено» (or take it back): the owner looked into the disagreement",
    description: "The note is named by its place in the list and its code; 409 when they no longer match. Audited.",
    params: personCodeParamsSchema,
    body: adminPersonImportNoteSettleBodySchema,
    response: { 200: adminPersonResponseSchema, ...ownerErrors },
  },
  adminPeopleProposals: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "The agents' proposals about people, newest first (by default the open ones)",
    querystring: adminPeopleProposalsQuerySchema,
    response: { 200: adminPeopleProposalsResponseSchema, ...ownerErrors },
  },
  adminPersonProposalDecide: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Accept an agent's proposal (the change goes through the owner's own edit) or reject it",
    description: "409 when it is decided already, or when the change no longer applies (then it stays open).",
    params: adminPersonProposalParamsSchema,
    body: adminPersonProposalDecideBodySchema,
    response: { 200: adminPersonProposalDecideResponseSchema, ...ownerErrors },
  },
  agentPeople: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "The people registry's feed (needs read:team): code, kind, role, state, logins, working pages, schedule, rights and"
      + " Telegram; pay terms only with read:pay_terms",
    description: "With `since`, only people whose record or anything hanging off it changed at or after it. Working pages outside "
      + "the key's grant are left out. Database only.",
    querystring: agentPeopleQuerySchema,
    response: { 200: agentPeopleResponseSchema, ...agentErrors },
  },
  agentPersonProposalCreate: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Propose a change about a person, or a new person (needs propose:people): it waits for the owner; nothing changes now",
    description: "The change has the shape of the owner's edit (or create) and is checked against the registry now: an unknown "
      + "person, page, login or key is a 400/404 here, not later. Never pay terms, never an invitation.",
    body: agentPersonProposalBodySchema,
    response: { 200: agentPersonProposalResponseSchema, ...agentErrors },
  },
  agentPersonProposals: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "This key's proposals about people and what the owner decided (needs propose:people)",
    querystring: agentPersonProposalsQuerySchema,
    response: { 200: agentPersonProposalsResponseSchema, ...agentErrors },
  },
} as const;
