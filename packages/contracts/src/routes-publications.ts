import { errorResponseSchema } from "./primitives.ts";
import {
  agentPublicationChangesQuerySchema,
  agentPublicationChangesResponseSchema,
  agentPublicationCreateBodySchema,
  agentPublicationListQuerySchema,
  agentPublicationMediaQuerySchema,
  agentPublicationMediaResponseSchema,
  publicationApproveBodySchema,
  publicationApproveResponseSchema,
  publicationCreateBodySchema,
  publicationDetailSchema,
  publicationIdParamsSchema,
  publicationListQuerySchema,
  publicationListResponseSchema,
  publicationPageParamsSchema,
  publicationResolveBodySchema,
  publicationResolveResponseSchema,
  publicationSchema,
  publicationSettingsListResponseSchema,
  publicationSettingsSchema,
  publicationSettingsUpdateBodySchema,
  publicationUpdateBodySchema,
  publicationQueueListResponseSchema,
  publicationQueueRefreshBodySchema,
  publicationQueueRefreshResponseSchema,
  publicationWithdrawPageBodySchema,
  publicationWithdrawResponseSchema,
} from "./publications.ts";

// Publications (docs/plans/2026-10-23-wall-posts, spec §9). The owner's routes
// draft, approve, cancel, answer "unknown" and set the pages' publishing; an
// agent key with write:publication_drafts drafts on its own pages, reads
// their statuses and picks files from the page's media; one with
// approve:publications also approves them, on the owner's word in the chat
// (owner 2026-10-27). An agent cancels what its key drafted while Hub has not
// handed it to the platform (owner 2026-10-29). Nothing here talks to a platform.

const owner = { kind: "owner-session" } as const;
const ownerErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  // publication_version_conflict | publication_not_editable | publication_not_unknown
  409: errorResponseSchema,
} as const;
const agentErrors = { ...ownerErrors, 429: errorResponseSchema, 503: errorResponseSchema } as const;
// publication_handed_to_platform: Hub has sent it to the platform; only the owner takes it off, in Hub.

export const publicationRouteSchemas = {
  adminPublicationList: {
    auth: owner, tags: ["admin"],
    summary: "Publications of every page (or one) by publish time, with their draft-check findings",
    querystring: publicationListQuerySchema,
    response: { 200: publicationListResponseSchema, ...ownerErrors },
  },
  adminPublicationCreate: {
    auth: owner, tags: ["admin"],
    summary: "Draft a publication as the owner; it is checked at once and approved separately",
    body: publicationCreateBodySchema,
    response: { 200: publicationSchema, ...ownerErrors },
  },
  adminPublicationGet: {
    auth: owner, tags: ["admin"],
    summary: "One publication with its findings re-checked, its status journal and its approval",
    params: publicationIdParamsSchema,
    response: { 200: publicationDetailSchema, ...ownerErrors },
  },
  adminPublicationUpdate: {
    auth: owner, tags: ["admin"],
    summary: "Edit a draft or an approved publication (compare-and-set on version); an approved one returns to draft",
    params: publicationIdParamsSchema,
    body: publicationUpdateBodySchema,
    response: { 200: publicationSchema, ...ownerErrors },
  },
  adminPublicationApprove: {
    auth: owner, tags: ["admin"],
    summary: "Approve one or many drafts in order; each is checked again and refused on a blocking finding",
    body: publicationApproveBodySchema,
    response: { 200: publicationApproveResponseSchema, ...ownerErrors },
  },
  adminPublicationCancel: {
    auth: owner, tags: ["admin"],
    summary: "Cancel a draft or an approved publication before Hub sends it",
    params: publicationIdParamsSchema,
    response: { 200: publicationSchema, ...ownerErrors },
  },
  adminPublicationResolve: {
    auth: owner, tags: ["admin"],
    summary: "Answer an unknown outcome: it went out (the platform post), or it did not (a linked new draft)",
    params: publicationIdParamsSchema,
    body: publicationResolveBodySchema,
    response: { 200: publicationResolveResponseSchema, ...ownerErrors },
  },
  adminPublicationWithdraw: {
    auth: owner, tags: ["admin"],
    summary: "Withdraw a Hub post from OnlyFans' schedule: 15 minutes or more before its time, after a fresh complete"
      + " read shows it there; sent once, its own outcome. Works while publishing is off, not while the page is stopped",
    params: publicationIdParamsSchema,
    response: { 200: publicationWithdrawResponseSchema, ...ownerErrors },
  },
  adminPublicationDeletePost: {
    auth: owner, tags: ["admin"],
    summary: "Delete a published Fansly post Hub made from the Fansly wall: one request through the page's browser,"
      + " sent once; a fresh read by its id after it settles «withdrawn», a lost answer «unknown». Works while publishing"
      + " is off, not while the page is stopped",
    params: publicationIdParamsSchema,
    response: { 200: publicationWithdrawResponseSchema, ...ownerErrors },
  },
  adminPublicationWithdrawPage: {
    auth: owner, tags: ["admin"],
    summary: "Withdraw every post Hub put in the page's OnlyFans schedule, one command per post, each its own outcome",
    body: publicationWithdrawPageBodySchema,
    response: { 200: publicationWithdrawResponseSchema, ...ownerErrors },
  },
  adminPublicationReplace: {
    auth: owner, tags: ["admin"],
    summary: "Draft a replacement of a withdrawn publication (only after a confirmed withdrawal); it is approved again",
    params: publicationIdParamsSchema,
    response: { 200: publicationSchema, ...ownerErrors },
  },
  adminPublicationQueueList: {
    auth: owner, tags: ["admin"],
    summary: "The latest read of every OnlyFans page's schedule: Hub's posts in it, the ones put there by hand, and"
      + " whether the read was complete and fresh",
    response: { 200: publicationQueueListResponseSchema, ...ownerErrors },
  },
  adminPublicationQueueRefresh: {
    auth: owner, tags: ["admin"],
    summary: "Read the page's OnlyFans schedule again within a minute (spends OnlyFansAPI credits)",
    body: publicationQueueRefreshBodySchema,
    response: { 200: publicationQueueRefreshResponseSchema, ...ownerErrors },
  },
  adminPublicationSettingsList: {
    auth: owner, tags: ["admin"],
    summary: "The global switch and every page's publishing settings (off by default)",
    response: { 200: publicationSettingsListResponseSchema, ...ownerErrors },
  },
  adminPublicationSettingsUpdate: {
    auth: owner, tags: ["admin"],
    summary: "Set one page's publishing: on/off, paid price range (mills), repeat threshold, daily limit",
    params: publicationPageParamsSchema,
    body: publicationSettingsUpdateBodySchema,
    response: { 200: publicationSettingsSchema, ...ownerErrors },
  },
  agentPublicationCreate: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "Draft a publication on a granted page (needs write:publication_drafts). A person approves it,"
      + " or this key when it has approve:publications. Replayable by idempotencyKey",
    params: publicationPageParamsSchema,
    body: agentPublicationCreateBodySchema,
    response: { 200: publicationSchema, ...agentErrors },
  },
  agentPublicationList: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "The page's publications and their statuses and findings (needs write:publication_drafts)",
    params: publicationPageParamsSchema,
    querystring: agentPublicationListQuerySchema,
    response: { 200: publicationListResponseSchema, ...agentErrors },
  },
  agentPublicationMedia: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "The page's media a draft can use, newest first: when each file last went out on the page and the"
      + " live publication that uses it (needs write:publication_drafts). Keyset-paginated by cursor",
    params: publicationPageParamsSchema,
    querystring: agentPublicationMediaQuerySchema,
    response: { 200: agentPublicationMediaResponseSchema, ...agentErrors },
  },
  agentPublicationChanges: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "This key's own publications on its pages changed since a time, oldest change first: status, its"
      + " reason, the platform's post or album, times (needs write:publication_drafts). Keyset-paginated by cursor",
    querystring: agentPublicationChangesQuerySchema,
    response: { 200: agentPublicationChangesResponseSchema, ...agentErrors },
  },
  agentPublicationCancel: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Cancel a publication this key drafted while Hub has not handed it to the platform: a draft or an"
      + " approved one (needs write:publication_drafts). Later it is the owner's, in Hub: 409"
      + " publication_handed_to_platform. A cancelled one answers as it is",
    params: publicationIdParamsSchema,
    response: { 200: publicationSchema, ...agentErrors },
  },
  agentPublicationGet: {
    // An id path, so no declarative page scope: the handler checks the grant.
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "One publication of a granted page with its status journal (needs write:publication_drafts)",
    params: publicationIdParamsSchema,
    response: { 200: publicationDetailSchema, ...agentErrors },
  },
  agentPublicationApprove: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Approve drafts of granted pages in order, on the owner's word in the chat (needs approve:publications);"
      + " each is checked again and refused on a blocking finding, as the owner's approval is",
    body: publicationApproveBodySchema,
    response: { 200: publicationApproveResponseSchema, ...agentErrors },
  },
  agentPublicationUpdate: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Edit a publication this key drafted; an approved one returns to draft and is approved again",
    params: publicationIdParamsSchema,
    body: publicationUpdateBodySchema,
    response: { 200: publicationSchema, ...agentErrors },
  },
} as const;
