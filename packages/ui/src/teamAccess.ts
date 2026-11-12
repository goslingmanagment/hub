import { CHATTER_SITE_ORIGIN, chatterSiteOriginFor } from "./sites.js";

/**
 * The people's access, without React: who is in what state, the one-time join
 * link and its Telegram text, the words of links and devices, for Workboard's
 * Доступ (the console's people screens it replaced said the same).
 */

export type AccessRole = "owner" | "team_lead" | "chatter";
export type TeamStatus = "invited" | "active" | "disabled";
export type LinkKind = "invite" | "password_reset";

export const ROLE_LABEL: Readonly<Record<AccessRole, string>> = {
  owner: "Владелец",
  team_lead: "Тимлид",
  chatter: "Чаттер",
};

/** Deactivation wins over everything; an account without its password yet waits for the person to open the invite. */
export function teamStatus(user: { disabledAt: string | null; registrationState: string }): TeamStatus {
  if (user.disabledAt) return "disabled";
  if (user.registrationState === "invited") return "invited";
  return "active";
}

/** Hub's unique login index is case-insensitive: match that rule before inviting, the disabled included. */
export function findByLogin<U extends { username: string; deletedAt: string | null }>(users: readonly U[], username: string): U | null {
  const normalized = username.trim().toLowerCase();
  return users.find((user) => !user.deletedAt && user.username.toLowerCase() === normalized) ?? null;
}

/** Mirrors the invite body's login rule, so the form refuses before the round-trip. */
export function isValidUsername(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 100;
}

export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;

export function daysToHours(days: number): number {
  return days * 24;
}

/** The chatters' site (/join opens there) and the one that goes with a console's origin: ./sites.ts. */
export { CHATTER_SITE_ORIGIN, chatterSiteOriginFor } from "./sites.js";

/** The chatters' guide (the old /fansly/start.html answers 301). */
export const START_GUIDE_URL = `${CHATTER_SITE_ORIGIN}/start.html`;

/** The secret travels in the fragment: it never reaches a server log as a path. */
export function buildJoinLink(consoleOrigin: string, secret: string): string {
  return `${chatterSiteOriginFor(consoleOrigin)}/join#${secret}`;
}

export function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export function telegramMessage(kind: LinkKind, username: string, link: string): string {
  if (kind === "password_reset") {
    return `Привет! Ссылка для нового пароля ChatGoose: ${link}. Открой и придумай новый пароль. Логин: ${username}.`;
  }
  return `Привет! Твой аккаунт ChatGoose: ${link}. Открой, придумай пароль. Логин: ${username}. Как начать: ${START_GUIDE_URL}`;
}

/** Capitalised for a list's first word. */
export const LINK_KIND_LABEL: Readonly<Record<LinkKind, string>> = {
  invite: "Приглашение",
  password_reset: "Сброс пароля",
};

const LINK_REVOKED_REASON_LABEL: Readonly<Record<string, string>> = {
  superseded: "заменена новой",
  password_set: "пароль задан",
  user_deactivated: "человек деактивирован",
  revoked_by_owner: "отозвана владельцем",
};

/** An unknown reason is dropped, never shown as a machine word. */
export function linkRevokedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return LINK_REVOKED_REASON_LABEL[reason] ?? null;
}

export function linkStateLabel(
  link: { state: string; expiresAt: string; usedAt: string | null; revokedReason: string | null },
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
    default:
      return link.state;
  }
}

/** The revocations, each named for how far it reaches (the console's REVOCATION_LABEL). */
export const REVOCATION_LABEL = {
  device: "Завершить вход на устройстве",
  allDevices: "Отозвать все устройства",
  allAccess: "Завершить все входы",
} as const;

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

export function deviceRevokedReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return DEVICE_REVOKED_REASON_LABEL[reason] ?? null;
}

interface DeviceLike {
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string;
}

/** Live sign-ins first (freshest on top); the ended ones are history, newest end first. Nothing is collapsed. */
export function splitDevices<D extends DeviceLike>(devices: readonly D[]): { active: D[]; history: D[] } {
  const activity = (device: D) => Date.parse(device.lastUsedAt ?? device.createdAt);
  const ended = (device: D) => Date.parse(device.revokedAt ?? device.expiresAt);
  return {
    active: devices.filter((device) => device.isActive).sort((a, b) => activity(b) - activity(a)),
    history: devices.filter((device) => !device.isActive).sort((a, b) => ended(b) - ended(a)),
  };
}

/** What a restore brings back: the console's words, by whether the password was ever set. */
export function restoreMessage(user: { registrationState: string }): string {
  if (user.registrationState === "invited") {
    return "Вернётся тот же сотрудник с историей, ролью и назначенными страницами; прежние ссылки не заработают. "
      + "Пароль ещё не задан — после восстановления создайте новое приглашение в этой карточке.";
  }
  return "Вернётся тот же сотрудник с историей, ролью и назначенными страницами и сможет войти с прежним паролем "
    + "(если забыл — сбросьте его ссылкой). Прежние входы и ссылки останутся недействительными.";
}
