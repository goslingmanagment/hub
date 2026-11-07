import type { AdminUser } from "@agency_hub_core/contracts";
import { platforms, type Platform } from "@agency_hub_core/shared";
import { PLATFORM_DISPLAY_NAME } from "@/lib/platformUrls";

// The people screens' pure view logic: statuses, sorting, platform
// grouping, the join link and the Telegram template. Every user-facing word
// here obeys the §2 vocabulary (login, password, devices, links — nothing
// about the credential machinery underneath). The words and rules the console
// shares with Workboard live in one copy, packages/ui/src/teamAccess.ts:
// re-exported here under the console's names.

export {
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  LINK_KIND_WORD as LINK_KIND_LABEL,
  REVOCATION_LABEL,
  ROLE_LABEL,
  START_GUIDE_URL,
  buildJoinLink,
  currentOrigin,
  daysToHours,
  deviceRevokedReasonLabel,
  findByLogin as findTeamMemberByLogin,
  isValidUsername,
  linkRevokedReasonLabel,
  linkStateLabel,
  restoreMessage as restoreTeamMemberMessage,
  splitDevices,
  teamStatus,
  telegramMessage,
  type TeamStatus,
} from "@agency_hub_core/ui/teamAccess";

/* ------------------------------------------------------------------ */
/*  People                                                             */
/* ------------------------------------------------------------------ */

export function findTeamMember(
  users: readonly AdminUser[],
  userId: number,
): AdminUser | null {
  return users.find((user) => user.id === userId && !user.deletedAt) ?? null;
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
/*  Platforms — lookup tables, never a strict comparison    */
/* ------------------------------------------------------------------ */

export const PLATFORM_LABEL: Readonly<Record<Platform, string>> = PLATFORM_DISPLAY_NAME;

export const PLATFORM_DOT_CLASS: Readonly<Record<Platform, string>> = {
  fansly: "bg-fansly",
  onlyfans: "bg-onlyfans",
  telegram: "bg-telegram",
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

/** The page-assignment editor's words inside the Team card. */
export const TEAM_PAGE_LABELS = {
  assigned: "Страницы",
  empty: "Страниц пока нет.",
  unassign: "Снять",
  assignHeading: "Назначить страницу",
  select: "Выберите страницу…",
  assign: "Назначить",
} as const;
