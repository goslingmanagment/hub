import { demoError, hashString, isDemoReply, iso, queryNumber, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_PAGES, DEMO_USERS, demoFans, demoUserByRole } from "../world.ts";
import { clientSendCustodyList } from "./costs-attention-queues.ts";
import { ownerOnly } from "./settings-common.ts";
import { teamUsers } from "./settings.ts";

/**
 * Workboard «Доступ» and «Решения»: the writes the console's demo answered with
 * «изменения не сохраняются» (403). Each one is accepted and changes nothing in
 * the invented world, so the screens can show their questions and their
 * results; a reload shows the agency as before. Hub's own checks that a screen
 * relies on are kept: the owner only, a person and a page that exist, the owner
 * cannot be switched off or deleted.
 */

function personOf(request: DemoRequest) {
  const id = Number(request.params.userId);
  return teamUsers().find((user) => user.id === id);
}

function guard(request: DemoRequest) {
  const refused = ownerOnly(request);
  if (refused) return refused;
  const person = personOf(request);
  if (!person) return demoError(404, "Not Found", "Пользователь не найден");
  return person;
}

export const wbAdminHandlers: DemoHandlers = {
  adminAssignPage: (request) => {
    const person = guard(request);
    if (isDemoReply(person)) return person;
    const label = (request.body as { pageLabel?: string } | null)?.pageLabel ?? "";
    const page = DEMO_PAGES.find((one) => one.label === label);
    if (!page) return demoError(404, "Not Found", `Страницы «${label}» нет.`);
    const labels = new Set([...person.pages, label]);
    return {
      id: person.id,
      username: person.username,
      role: person.role,
      mustChangePassword: false,
      assignedPages: DEMO_PAGES.filter((one) => labels.has(one.label)).map((one) => ({ id: one.id, label: one.label, platform: one.platform, modelSlug: one.modelSlug, modelName: one.modelName })),
    };
  },

  adminUnassignPage: (request) => {
    const person = guard(request);
    if (isDemoReply(person)) return person;
    if (!DEMO_PAGES.some((one) => one.label === request.params.pageLabel)) return demoError(404, "Not Found", "Страница не найдена");
    return { ok: true as const };
  },

  adminRevokeDeviceToken: (request) => {
    const person = guard(request);
    return isDemoReply(person) ? person : { revoked: true as const };
  },

  adminRevokeDeviceTokens: (request) => {
    const person = guard(request);
    return isDemoReply(person) ? person : { revokedCount: person.username === "nika.t" ? 0 : 1 };
  },

  adminTerminateAllAccess: (request) => {
    const person = guard(request);
    if (isDemoReply(person)) return person;
    if (person.role === "owner") return demoError(400, "Bad Request", "Владельцу нельзя завершить все входы");
    return { deviceTokens: 1, sessions: 0, links: 0 };
  },

  adminRevokeAccountLink: (request) => {
    const person = guard(request);
    if (isDemoReply(person)) return person;
    const now = request.now;
    return {
      id: Number(request.params.linkId),
      kind: "invite" as const,
      keyPrefix: "dmorvk",
      state: "revoked" as const,
      expiresAt: iso(new Date(now.getTime() + 6 * 86_400_000)),
      usedAt: null,
      revokedAt: iso(now),
      revokedReason: "revoked_by_owner",
      createdAt: iso(new Date(now.getTime() - 8 * 3_600_000)),
      createdBy: 1,
    };
  },

  adminDeactivateUser: (request) => {
    const person = guard(request);
    if (isDemoReply(person)) return person;
    if (person.role === "owner") return demoError(400, "Bad Request", "Владельца нельзя деактивировать");
    return { ok: true as const, revokedDeviceTokens: 1, revokedSessions: 0 };
  },

  adminReactivateUser: (request) => {
    const person = guard(request);
    return isDemoReply(person) ? person : { ok: true as const };
  },

  adminDeleteUser: (request) => {
    const person = guard(request);
    if (isDemoReply(person)) return person;
    if (person.role === "owner") return demoError(400, "Bad Request", "Владельца нельзя удалить");
    return { ok: true as const, revokedDeviceTokens: 0, revokedSessions: 0 };
  },

  // A held send's resolve: the send as Hub would answer it, now resolved by hand. The queue is unchanged after a reload.
  clientSendCustodyResolve: (request) => {
    const listed = heldWithFansly({ ...request, query: { state: "held", limit: "100" } });
    if (isDemoReply(listed)) return listed;
    const item = listed.items.find((one) => one.attemptId === request.params.attemptId && one.pageLabel === request.params.pageLabel);
    if (!item) return demoError(404, "not_found", "Send not found on this page");
    const outcome = (request.body as { outcome?: string } | null)?.outcome;
    return {
      attemptId: item.attemptId,
      fanRef: item.fanRef,
      userId: item.userId,
      purpose: item.purpose,
      state: outcome === "sent" ? "resolved-sent" : "resolved-not-sent",
      generationRef: item.generationRef,
      partIndex: item.partIndex,
      partCount: item.partCount,
      createdAt: item.createdAt,
      ticketExpiresAt: item.ticketExpiresAt,
    };
  },
};

// --- Held sends as production has them: mostly Fansly greetings ------------------

type Custody = Exclude<ReturnType<typeof clientSendCustodyList>, { demoReply: true }>;
type CustodyItem = Custody["items"][number];

function uuid(seed: string): string {
  const hex = Array.from({ length: 4 }, (_, index) => hashString(`wb:${seed}:${index}`).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Two greetings on Fansly whose report never came (production 07.11: 11 such, all Fansly greetings). */
function fanslyHeld(now: Date): CustodyItem[] {
  const den = DEMO_USERS.find((user) => user.username === "den.s")!;
  const kate = DEMO_USERS.find((user) => user.username === "kate.v")!;
  const seeds = [
    { page: "nova-1", fan: 4, user: den, minutesAgo: 3 * 60 + 40, partCount: 2, variant: 1 },
    { page: "mia-1", fan: 9, user: kate, minutesAgo: 52, partCount: 1, variant: 0 },
  ];
  return seeds.map((seed, index) => {
    const createdAt = new Date(now.getTime() - seed.minutesAgo * 60_000);
    const fans = demoFans(seed.page).filter((fan) => fan.totalSpent > 0);
    return {
      attemptId: uuid(`held-fansly:${index}`),
      fanRef: fans[seed.fan % fans.length]!.platformUserId,
      userId: seed.user.id,
      purpose: "greeting",
      state: "uncertain-held",
      generationRef: uuid(`held-fansly-gen:${index}`),
      partIndex: 0,
      partCount: seed.partCount,
      createdAt: iso(createdAt),
      ticketExpiresAt: iso(new Date(createdAt.getTime() + 10_000)),
      pageLabel: seed.page,
      variant: seed.variant,
      username: seed.user.username,
      instanceId: uuid(`install:${seed.user.username}`),
      updatedAt: iso(createdAt),
      greeting: { state: "none", at: null, source: null, firstPartIsThisAttempt: false },
      resolution: null,
    };
  });
}

/** The console's queue plus the Fansly greetings, oldest first, cut to the viewer's pages and the page asked. */
function heldWithFansly(request: DemoRequest): ReturnType<typeof clientSendCustodyList> {
  const base = clientSendCustodyList({ ...request, query: { ...request.query, limit: "100", offset: "0" } });
  if (isDemoReply(base) || queryString(request, "state") === "resolved") return clientSendCustodyList(request);
  const viewer = demoUserByRole(request.role);
  const pageLabel = queryString(request, "pageLabel");
  const extra = fanslyHeld(request.now).filter((item) => viewer.pages.includes(item.pageLabel) && (pageLabel === undefined || item.pageLabel === pageLabel));
  const items = [...base.items, ...extra].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const limit = Math.min(100, Math.max(1, Math.round(queryNumber(request, "limit", 50))));
  const offset = Math.max(0, Math.round(queryNumber(request, "offset", 0)));
  return { ...base, items: items.slice(offset, offset + limit), limit, offset, total: items.length };
}

/** Wraps the console's `clientSendCustodyList` (costs-attention): fixtures/index.ts spreads it over that area. */
export const wbHeldHandlers: DemoHandlers = {
  clientSendCustodyList: heldWithFansly,
};
