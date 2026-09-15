import type {
  AccountLinkItem,
  AccountLinkKind,
  AdminUser,
  DeviceTokenItem,
} from "@agency_hub_core/contracts";
import { platforms, type Platform, type UserRole } from "@agency_hub_core/shared";

// Decision 350 — the Team tab's pure view logic: statuses, sorting, platform
// grouping, the join link and the Telegram template. Every user-facing word
// here obeys the §2 vocabulary (login, password, devices, links — nothing
// about the credential machinery underneath); tests/dashboard-team-copy-
// vocabulary.test.ts pins it.

/* ------------------------------------------------------------------ */
/*  People                                                             */
/* ------------------------------------------------------------------ */

export type TeamStatus = "invited" | "active" | "disabled";

export const TEAM_STATUS_LABEL: Readonly<Record<TeamStatus, string>> = {
  invited: "ждёт регистрации",
  active: "активен",
  disabled: "деактивирован",
};

export const ROLE_LABEL: Readonly<Record<UserRole, string>> = {
  owner: "владелец",
  team_lead: "тимлид",
  chatter: "чаттер",
};

/** Deactivation wins over everything; an account that has not set its
 * password yet (§4.1 p.12: `registrationState: "invited"`) waits for the
 * person to open the invite. */
export function teamStatus(user: Pick<AdminUser, "disabledAt" | "registrationState">): TeamStatus {
  if (user.disabledAt) return "disabled";
  if (user.registrationState === "invited") return "invited";
  return "active";
}

export function findTeamMember(
  users: readonly AdminUser[],
  username: string,
): AdminUser | null {
  return users.find((user) => user.username === username) ?? null;
}

/** Working people float up (freshest device activity first); never-active
 * rows (fresh invites, probes) sink together, alphabetically. */
export function sortTeamByActivity(users: readonly AdminUser[]): AdminUser[] {
  return [...users].sort((a, b) => {
    const aTime = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
    const bTime = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    return a.username.localeCompare(b.username);
  });
}

/* ------------------------------------------------------------------ */
/*  Platforms — lookup tables, never a strict comparison (Stage 18)    */
/* ------------------------------------------------------------------ */

export const PLATFORM_LABEL: Readonly<Record<Platform, string>> = {
  fansly: "Fansly",
  onlyfans: "OnlyFans",
};

export const PLATFORM_DOT_CLASS: Readonly<Record<Platform, string>> = {
  fansly: "bg-fansly",
  onlyfans: "bg-onlyfans",
};

export interface PlatformGroup<T> {
  platform: Platform;
  label: string;
  pages: T[];
}

/** Groups pages by platform in the canonical platform order; platforms with
 * no pages are omitted. */
export function groupPagesByPlatform<T extends { platform: Platform }>(
  pages: readonly T[],
): PlatformGroup<T>[] {
  const byPlatform = new Map<Platform, T[]>();
  for (const page of pages) {
    const bucket = byPlatform.get(page.platform);
    if (bucket) {
      bucket.push(page);
    } else {
      byPlatform.set(page.platform, [page]);
    }
  }
  return platforms.flatMap((platform) => {
    const bucket = byPlatform.get(platform);
    return bucket ? [{ platform, label: PLATFORM_LABEL[platform], pages: bucket }] : [];
  });
}

/* ------------------------------------------------------------------ */
/*  Links                                                              */
/* ------------------------------------------------------------------ */

export const START_GUIDE_URL = "https://ext.gosling-agency.ru/start.html";

export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;

export function daysToHours(days: number): number {
  return days * 24;
}

/** Mirrors adminCreateInviteBodySchema's username rule so the form can refuse
 * before the round-trip. */
export function isValidUsername(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 100;
}

/** The link travels in the URL FRAGMENT (§4.1 p.2): it never reaches a
 * server log as a path. */
export function buildJoinLink(origin: string, secret: string): string {
  return `${origin}/join#${secret}`;
}

/** The dashboard is served same-origin with the kernel, so the join page the
 * person opens lives on exactly this origin. Guarded: the settings tree also
 * renders server-side in tests, where there is no window. */
export function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export const LINK_KIND_LABEL: Readonly<Record<AccountLinkKind, string>> = {
  invite: "приглашение",
  password_reset: "сброс пароля",
};

export function telegramMessage(kind: AccountLinkKind, username: string, link: string): string {
  if (kind === "password_reset") {
    return `Привет! Ссылка для нового пароля ChatGoose: ${link}. Открой и придумай новый пароль. Логин: ${username}.`;
  }
  return `Привет! Твой аккаунт ChatGoose: ${link}. Открой, придумай пароль. Логин: ${username}. Как начать: ${START_GUIDE_URL}`;
}

const LINK_REVOKED_REASON_LABEL: Readonly<Record<string, string>> = {
  superseded: "заменена новой",
  password_set: "пароль задан",
  user_deactivated: "человек деактивирован",
  revoked_by_owner: "отозвана владельцем",
};

/** A reason the kernel grew after this build is still a machine word
 * (`revoked_by_owner`), and showing it verbatim would put exactly the
 * vocabulary §2 forbids on the owner's screen. An unknown reason degrades to
 * no reason at all: the state alone is already true. */
export function linkRevokedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return LINK_REVOKED_REASON_LABEL[reason] ?? null;
}

export function linkStateLabel(
  link: Pick<AccountLinkItem, "state" | "expiresAt" | "usedAt" | "revokedAt" | "revokedReason">,
  formatDate: (iso: string) => string,
): string {
  switch (link.state) {
    case "active":
      return `действует до ${formatDate(link.expiresAt)}`;
    case "used":
      return `использована ${link.usedAt ? formatDate(link.usedAt) : ""}`.trim();
    case "expired":
      return `истекла ${formatDate(link.expiresAt)}`;
    case "revoked": {
      const reason = linkRevokedReasonLabel(link.revokedReason);
      return reason ? `отозвана — ${reason}` : "отозвана";
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Devices                                                            */
/* ------------------------------------------------------------------ */

/** The three revocations of §4.4, each named for how far it actually reaches.
 * The card renders these constants and tests/team-access-intents.test.ts ties
 * each one to the kernel operation it fires, so a label can never drift away
 * from the thing it promises to do. */
export const REVOCATION_LABEL = {
  device: "Завершить вход на устройстве",
  allDevices: "Отозвать все устройства",
  allAccess: "Завершить все входы",
} as const;

// The kernel's reasons as written today (`revoked` = revoke-all,
// `self_revoked`, `user_deactivated`) plus the Decision 349 additions.
const DEVICE_REVOKED_REASON_LABEL: Readonly<Record<string, string>> = {
  revoked: "все устройства отозваны",
  revoked_by_owner: "вход завершён владельцем",
  self_revoked: "выход с устройства",
  user_deactivated: "человек деактивирован",
  password_set: "пароль изменён",
  password_changed: "пароль изменён",
  password_reset: "пароль сброшен",
  access_terminated: "все входы завершены",
};

/** Same rule as links: an unrecognised reason is dropped rather than shown
 * raw, and the caller falls back to the plain "вход завершён". */
export function deviceRevokedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return DEVICE_REVOKED_REASON_LABEL[reason] ?? null;
}

/** Live sign-ins first (freshest activity on top); everything else — expired
 * and revoked — is history, newest end first. Two rows with the same label
 * are two real sign-ins (one laptop can hold several), so nothing is
 * collapsed. */
export function splitDevices(devices: readonly DeviceTokenItem[]): {
  active: DeviceTokenItem[];
  history: DeviceTokenItem[];
} {
  const active = devices
    .filter((device) => device.isActive)
    .sort((a, b) => activityTime(b) - activityTime(a));
  const history = devices
    .filter((device) => !device.isActive)
    .sort((a, b) => endedTime(b) - endedTime(a));
  return { active, history };
}

function activityTime(device: DeviceTokenItem): number {
  return Date.parse(device.lastUsedAt ?? device.createdAt);
}

function endedTime(device: DeviceTokenItem): number {
  return Date.parse(device.revokedAt ?? device.expiresAt);
}

/* ------------------------------------------------------------------ */
/*  Time — Russian relative time for the people list                   */
/* ------------------------------------------------------------------ */

export function formatRelativeRu(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "—";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}


/* ------------------------------------------------------------------ */
/*  Pages                                                              */
/* ------------------------------------------------------------------ */

/** The shared page-assignment editor ships English copy for the screens that
 * have always used it; inside the Team card it speaks the owner's language. */
export const TEAM_PAGE_LABELS = {
  assigned: "Страницы",
  empty: "Страниц пока нет.",
  unassign: "Снять",
  assignHeading: "Назначить страницу",
  select: "Выбери страницу…",
  assign: "Назначить",
} as const;
