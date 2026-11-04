import {
  daysAgo,
  demoError,
  hoursAgo,
  iso,
  type DemoHandlers,
  type DemoRequest,
} from "../core.ts";
import { DEMO_MODELS, DEMO_PAGES, DEMO_USERS, demoPagesOfModel, type DemoPage, type DemoUser } from "../world.ts";
import { collectionHandlers } from "./settings-collection.ts";
import { ownerOnly, prefixFrom, uuidFrom } from "./settings-common.ts";
import { personaHandlers } from "./settings-personas.ts";

/**
 * «Настройки»: models and pages, the team (people, their devices and links),
 * AI personas with their Hi openers, and OnlyFans collection.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function pageRef(page: DemoPage) {
  return { id: page.id, label: page.label, platform: page.platform, modelSlug: page.modelSlug, modelName: page.modelName };
}

// --- Models and pages ---

function adminPage(page: DemoPage, now: Date) {
  return {
    ...pageRef(page),
    username: page.username,
    displayName: page.displayName,
    followerCount: { value: page.followers, available: page.followers !== null },
    subscriberCount: { value: page.subscribers, available: true },
    lastLightSyncAt: page.platform === "fansly" ? iso(hoursAgo(now, page.health === "attention" ? 5.2 : 0.3)) : null,
    lastFollowerSyncAt: page.platform === "fansly" ? iso(hoursAgo(now, page.health === "attention" ? 9 : 1)) : null,
    // Voice notes are allowlisted for the two biggest Fansly pages only.
    ...(page.label === "mia-1" || page.label === "nova-1" ? { capabilities: { voiceNotes: true } } : {}),
  };
}

// --- The team ---

/** A person invited yesterday who has not opened the link yet: only the
 *  team screen knows her, she has never worked a shift. */
const INVITED: DemoUser = { id: 10, username: "nika.t", role: "chatter", name: "Ника", pages: ["mia-3"], active: true };

interface Tenure {
  /** When the account was created (invite issued). */
  joinedDaysAgo: number;
  /** Hours since the last device-token use; null = never. */
  lastActiveHours: number | null;
  /** Deactivated this many days ago. */
  disabledDaysAgo?: number;
}

const TENURE: Readonly<Record<string, Tenure>> = {
  owner: { joinedDaysAgo: 412, lastActiveHours: 0.15 },
  "lead.marta": { joinedDaysAgo: 236, lastActiveHours: 1.4 },
  "lead.oleg": { joinedDaysAgo: 181, lastActiveHours: 5.2 },
  "alex.k": { joinedDaysAgo: 149, lastActiveHours: 0.4 },
  "kate.v": { joinedDaysAgo: 118, lastActiveHours: 2.6 },
  "den.s": { joinedDaysAgo: 94, lastActiveHours: 0.05 },
  "olya.m": { joinedDaysAgo: 71, lastActiveHours: 27 },
  "ivan.p": { joinedDaysAgo: 44, lastActiveHours: 8.5 },
  "lena.r": { joinedDaysAgo: 131, lastActiveHours: 12.4 * 24, disabledDaysAgo: 12 },
  "nika.t": { joinedDaysAgo: 1, lastActiveHours: null },
};

export function teamUsers(): DemoUser[] {
  return [...DEMO_USERS, INVITED];
}

function tenure(user: DemoUser): Tenure {
  return TENURE[user.username] ?? { joinedDaysAgo: 60, lastActiveHours: 24 };
}

function adminUser(user: DemoUser, now: Date) {
  const facts = tenure(user);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: false,
    assignedPages: DEMO_PAGES.filter((page) => user.pages.includes(page.label)).map(pageRef),
    disabledAt: facts.disabledDaysAgo !== undefined ? iso(daysAgo(now, facts.disabledDaysAgo, 15)) : null,
    deletedAt: null,
    lastActiveAt: facts.lastActiveHours === null ? null : iso(hoursAgo(now, facts.lastActiveHours)),
    registrationState: facts.lastActiveHours === null ? "invited" as const : "active" as const,
  };
}

function findUser(request: DemoRequest): DemoUser | undefined {
  const id = Number(request.params.userId);
  return teamUsers().find((user) => user.id === id);
}

interface DeviceSpec {
  label: string;
  /** Created this many days ago. */
  created: number;
  /** Last used this many hours ago; null = never used. */
  usedHours: number | null;
  version: string | null;
  harvest?: boolean;
  /** Ended this many days ago, with the kernel's reason (null = ran out); absent = live. */
  ended?: { days: number; reason: string | null };
}

const EXTENSION = "2.9.3";
const DESKTOP = "1.14.2";

function deviceSpecs(user: DemoUser): DeviceSpec[] {
  const facts = tenure(user);
  const used = facts.lastActiveHours;
  switch (user.username) {
    case "owner":
      return [
        { label: "Firefox · macOS", created: 64, usedHours: used, version: EXTENSION },
        { label: "ChatGoose Desktop · MacBook Pro", created: 38, usedHours: 20, version: DESKTOP },
        { label: "Firefox · macOS", created: 210, usedHours: 66 * 24, version: "2.4.0", ended: { days: 64, reason: "self_revoked" } },
      ];
    case "lead.marta":
      return [
        { label: "Firefox · Windows 11", created: 88, usedHours: used, version: EXTENSION },
        { label: "Firefox · macOS", created: 23, usedHours: 31, version: EXTENSION },
        { label: "Firefox · Windows 10", created: 236, usedHours: 92 * 24, version: "2.3.1", ended: { days: 89, reason: "password_reset" } },
      ];
    case "lead.oleg":
      return [{ label: "Firefox · Windows 11", created: 120, usedHours: used, version: EXTENSION }];
    case "olya.m":
      return [
        { label: "ChatGoose Desktop · Windows", created: 71, usedHours: used, version: DESKTOP, harvest: true },
        { label: "Firefox · Windows 11", created: 71, usedHours: 54, version: EXTENSION },
      ];
    case "ivan.p":
      // Still on an old build of the extension: the card shows the version.
      return [{ label: "Firefox · Ubuntu", created: 44, usedHours: used, version: "2.8.6" }];
    case "lena.r":
      return [
        { label: "Firefox · Windows 10", created: 131, usedHours: used, version: "2.8.6", ended: { days: 12, reason: "user_deactivated" } },
        { label: "Firefox · Android", created: 77, usedHours: 19 * 24, version: "2.8.1", ended: { days: 12, reason: "user_deactivated" } },
      ];
    case "nika.t":
      return [];
    default:
      return [
        { label: "Firefox · Windows 11", created: Math.min(facts.joinedDaysAgo - 1, 90), usedHours: used, version: EXTENSION },
        {
          label: "Firefox · Windows 10",
          created: facts.joinedDaysAgo,
          usedHours: (facts.joinedDaysAgo - 2) * 24,
          version: "2.2.0",
          ended: { days: facts.joinedDaysAgo - 1, reason: "self_revoked" },
        },
      ];
  }
}

function deviceTokens(user: DemoUser, now: Date) {
  return deviceSpecs(user).map((spec, index) => {
    const seed = `device:${user.username}:${index}`;
    const createdAt = daysAgo(now, spec.created);
    const lastUsedAt = spec.usedHours === null ? null : hoursAgo(now, spec.usedHours);
    // Sliding 90 days from the last use, never past a year from creation.
    const slide = (lastUsedAt ?? createdAt).getTime() + 90 * DAY_MS;
    const expires = new Date(Math.min(slide, createdAt.getTime() + 365 * DAY_MS));
    const ended = spec.ended;
    const expiresAt = ended && ended.reason === null ? daysAgo(now, ended.days) : expires;
    return {
      id: 400 + user.id * 10 + index,
      label: spec.label,
      keyPrefix: `agency_hub_device_${prefixFrom(seed, 6)}`,
      harvestMachineId: spec.harvest ? uuidFrom(`machine:${user.username}`) : null,
      isActive: ended === undefined,
      expiresAt: iso(expiresAt),
      lastUsedAt: lastUsedAt ? iso(lastUsedAt) : null,
      lastClientVersion: spec.version,
      createdAt: iso(createdAt),
      revokedAt: ended && ended.reason !== null ? iso(daysAgo(now, ended.days, 14)) : null,
      revokedReason: ended?.reason ?? null,
    };
  });
}

function accountLinks(user: DemoUser, now: Date) {
  if (user.role === "owner") return [];
  const facts = tenure(user);
  const base = 900 + user.id * 10;
  const link = (
    offset: number,
    kind: "invite" | "password_reset",
    createdDays: number,
    state: "active" | "used" | "expired" | "revoked",
    extra: { usedDays?: number; revokedDays?: number; revokedReason?: string } = {},
  ) => {
    const createdAt = createdDays < 2 ? hoursAgo(now, createdDays * 24) : daysAgo(now, createdDays, 10);
    return {
      id: base + offset,
      kind,
      keyPrefix: prefixFrom(`link:${user.username}:${offset}`, 8),
      state,
      expiresAt: iso(new Date(createdAt.getTime() + 7 * DAY_MS)),
      usedAt: extra.usedDays !== undefined ? iso(daysAgo(now, extra.usedDays, 12)) : null,
      revokedAt: extra.revokedDays !== undefined ? iso(hoursAgo(now, extra.revokedDays * 24)) : null,
      revokedReason: extra.revokedReason ?? null,
      createdAt: iso(createdAt),
      createdBy: 1,
    };
  };
  switch (user.username) {
    case "nika.t":
      return [
        // Re-issued after a typo in the first message: the first one is superseded.
        link(2, "invite", 0.31, "active"),
        link(1, "invite", 0.34, "revoked", { revokedDays: 0.31, revokedReason: "superseded" }),
      ];
    case "lena.r":
      return [
        link(2, "password_reset", 13, "revoked", { revokedDays: 12, revokedReason: "user_deactivated" }),
        link(1, "invite", facts.joinedDaysAgo, "used", { usedDays: facts.joinedDaysAgo }),
      ];
    case "lead.marta":
      return [
        link(3, "password_reset", 89, "used", { usedDays: 89 }),
        link(2, "invite", facts.joinedDaysAgo, "used", { usedDays: facts.joinedDaysAgo }),
        link(1, "invite", facts.joinedDaysAgo + 9, "expired"),
      ];
    case "kate.v":
      return [
        link(2, "password_reset", 33, "expired"),
        link(1, "invite", facts.joinedDaysAgo, "used", { usedDays: facts.joinedDaysAgo }),
      ];
    default:
      return [link(1, "invite", facts.joinedDaysAgo, "used", { usedDays: facts.joinedDaysAgo })];
  }
}

export const settingsHandlers: DemoHandlers = {
  adminModels: (request) => ownerOnly(request) ?? DEMO_MODELS.map((model, index) => ({
    id: model.id,
    slug: model.slug,
    name: model.name,
    pageCount: demoPagesOfModel(model.slug).length,
    sortOrder: (index + 1) * 10,
  })),

  adminPages: (request) => ownerOnly(request) ?? DEMO_PAGES.map((page) => adminPage(page, request.now)),

  adminListUsers: (request) => ownerOnly(request) ?? teamUsers().map((user) => adminUser(user, request.now)),

  adminListDeviceTokens: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const user = findUser(request);
    if (!user) return demoError(404, "Not Found", "Пользователь не найден");
    return deviceTokens(user, request.now);
  },

  adminListAccountLinks: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const user = findUser(request);
    if (!user) return demoError(404, "Not Found", "Пользователь не найден");
    return accountLinks(user, request.now);
  },

  // The team's invitations: an invented link, so the one-time window can be shown. Nothing is created.
  adminCreateInvite: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const body = request.body as { username?: string; role?: "chatter" | "team_lead"; pageLabels?: string[]; expiresInHours?: number };
    const username = body.username ?? "new.chatter";
    const user: DemoUser = { id: 99, username, role: body.role ?? "chatter", name: username, pages: body.pageLabels ?? [], active: true };
    return {
      user: { ...adminUser(user, request.now), lastActiveAt: null, registrationState: "invited" as const },
      link: { id: 990, kind: "invite" as const, keyPrefix: "dmoinv", token: "demo-invite-link-not-real", expiresAt: iso(hoursAgo(request.now, -(body.expiresInHours ?? 168))) },
    };
  },
  adminCreateAccountLink: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const user = findUser(request);
    if (!user) return demoError(404, "Not Found", "Пользователь не найден");
    const body = request.body as { kind?: "invite" | "password_reset"; expiresInHours?: number };
    return { id: 991, kind: body.kind ?? "password_reset", keyPrefix: "dmolnk", token: "demo-reset-link-not-real", expiresAt: iso(hoursAgo(request.now, -(body.expiresInHours ?? 168))) };
  },

  ...personaHandlers,
  ...collectionHandlers,
};
