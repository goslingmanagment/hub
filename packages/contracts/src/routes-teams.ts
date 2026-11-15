import { z } from "zod";

import { errorResponseSchema, intId, isoDateTime, isoTimestamp } from "./primitives.ts";

/**
 * Teams (products plan 2026-11-13 §4.2, package T): a team is a model. The team records (`team_roles`: «ведёт
 * команду», «ведёт кастомы», «видит команду») and a lead's notes on a shift review. Who may read and write is the
 * runtime's one place, services/teams.ts. Database only; no money anywhere.
 */

export const TEAM_ROLE_KINDS = ["lead", "customs", "view"] as const;
export type TeamRoleKindWire = (typeof TEAM_ROLE_KINDS)[number];

const teamModelSchema = z.object({
  id: intId,
  slug: z.string(),
  name: z.string(),
  /** The viewer may grant and take back «видит команду» and «ведёт кастомы» on it (its lead, the owner). */
  canGrant: z.boolean(),
  /** The viewer may grant and take back «ведёт команду» on it (the owner only). */
  canGrantLead: z.boolean(),
  /** The lead's name; null — the team has none: its matters go to the owner. */
  leadName: z.string().nullable(),
});

const teamRoleRecordSchema = z.object({
  personId: intId,
  personCode: z.string(),
  personName: z.string(),
  modelId: intId,
  kind: z.enum(TEAM_ROLE_KINDS),
  grantedByName: z.string().nullable(),
  grantedAt: isoTimestamp,
});

export const teamRolesResponseSchema = z.object({
  /** The models of the viewer's teams (the owner: every model of the realm). */
  models: z.array(teamModelSchema),
  /** The live records on them. */
  records: z.array(teamRoleRecordSchema),
  serverNow: isoTimestamp,
});
export type TeamRolesResponse = z.infer<typeof teamRolesResponseSchema>;

export const teamRoleSetBodySchema = z.object({
  personCode: z.string().min(1).max(80),
  modelId: intId,
  kind: z.enum(TEAM_ROLE_KINDS),
  /** true — grant; false — take back. */
  granted: z.boolean(),
});
export type TeamRoleSetBody = z.infer<typeof teamRoleSetBodySchema>;

export const teamRoleSetResponseSchema = z.object({ changed: z.boolean(), savedAt: isoTimestamp });

export const reviewNotesQuerySchema = z.object({
  userId: z.coerce.number().int().positive(),
  at: isoDateTime({ offset: true }),
});

const reviewNoteSchema = z.object({
  id: intId,
  /** One chat of the shift (the review's chat key); null — the whole shift. */
  chatKey: z.string().nullable(),
  authorName: z.string(),
  text: z.string(),
  createdAt: isoTimestamp,
});

export const reviewNotesResponseSchema = z.object({
  /** The shift's id; null — no shift there. */
  shiftId: intId.nullable(),
  /** The notes the viewer may read: the chatter's own, the author's, the lead's and the owner's; nobody else's. */
  notes: z.array(reviewNoteSchema),
  /** The viewer may leave a note here (the lead of a model of the shift, the owner). */
  canWrite: z.boolean(),
  serverNow: isoTimestamp,
});
export type ReviewNotesResponse = z.infer<typeof reviewNotesResponseSchema>;

export const reviewNoteAddBodySchema = z.object({
  userId: intId,
  at: isoDateTime({ offset: true }),
  chatKey: z.string().min(1).max(200).nullable().optional(),
  text: z.string().trim().min(1).max(2000),
});

export const reviewNoteAddResponseSchema = z.object({ id: intId, savedAt: isoTimestamp });

const errors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
} as const;

export const teamRouteSchemas = {
  teamRoles: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "The team records of the viewer's teams: who leads, who leads customs, who sees the team",
    description: "Any session. The owner every model of his realm; anyone else the models of their teams "
      + "(services/teams.ts). Database only; no money.",
    response: { 200: teamRolesResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
  },
  teamRoleSet: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "Grant or take back «видит команду», «ведёт кастомы» (the model's lead, the owner) or «ведёт команду» (the owner)",
    description: "A full session (not the extension's). A record is never deleted: taking it back marks it. A person "
      + "of the test team gets records of test models only. Database only.",
    body: teamRoleSetBodySchema,
    response: { 200: teamRoleSetResponseSchema, ...errors },
  },
  reviewNotes: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "The notes on one shift review the viewer may read",
    description: "The chatter of the shift, the lead of a model of it and the owner read them; the rest of the team "
      + "does not. Database only.",
    querystring: reviewNotesQuerySchema,
    response: { 200: reviewNotesResponseSchema, ...errors },
  },
  reviewNoteAdd: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "A lead's (or the owner's) note to the chatter on a shift or one chat of it",
    description: "The lead of a model of the shift, or the owner; a full session. Database only.",
    body: reviewNoteAddBodySchema,
    response: { 200: reviewNoteAddResponseSchema, ...errors },
  },
} as const;
