import type { PageProfileResponse, PageSettingsResponse } from "@agency_hub_core/contracts";
import { fanslySettingWords, SETTING_LABELS } from "./fanslySettingWords.js";

type Version = NonNullable<PageProfileResponse["current"]>;

/** `profileSocials[].providerId` as the profile editor names them (bundle 2026-10-29). */
export const SOCIAL_PROVIDERS: Readonly<Record<string, { label: string; url?: (handle: string) => string }>> = {
  "1": { label: "X (Twitter)", url: (handle) => `https://x.com/${handle}` },
  "4": { label: "Instagram", url: (handle) => `https://instagram.com/${handle}` },
  "5": { label: "TikTok", url: (handle) => `https://tiktok.com/@${handle}` },
  "8": { label: "Bluesky", url: (handle) => `https://bsky.app/profile/${handle}` },
  "9": { label: "Fleshlight" },
};

export function socialLabel(providerId: string): string {
  return SOCIAL_PROVIDERS[providerId]?.label ?? "Другая сеть";
}

function shortText(value: string | null, max = 80): string {
  if (value === null || value.trim() === "") return "пусто";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** What changed from one version of the profile to the next, in words. */
export function profileChanges(before: Version, after: Version): string[] {
  const out: string[] = [];
  const text = (label: string, a: string | null, b: string | null) => {
    if ((a ?? "") !== (b ?? "")) out.push(`${label}: «${shortText(a)}» → «${shortText(b)}»`);
  };
  text("Имя", before.displayName, after.displayName);
  text("Ник", before.username, after.username);
  text("Локация", before.location, after.location);
  if ((before.about ?? "") !== (after.about ?? "")) out.push("Описание изменено");
  if (before.avatarMediaRef !== after.avatarMediaRef) out.push("Новый аватар");
  if (before.bannerMediaRef !== after.bannerMediaRef) out.push("Новая обложка");
  const socials = (v: Version) => new Set(v.socials.map((s) => `${socialLabel(s.providerId)}: ${s.handle}`));
  const [sa, sb] = [socials(before), socials(after)];
  for (const s of sb) if (!sa.has(s)) out.push(`Соцсеть добавлена — ${s}`);
  for (const s of sa) if (!sb.has(s)) out.push(`Соцсеть убрана — ${s}`);
  const badgesBefore = new Set(before.badges.map((b) => b.badgeRef));
  for (const b of after.badges) if (!badgesBefore.has(b.badgeRef)) out.push(`Новый бейдж — ${b.title ?? b.badgeRef}`);
  const badgesAfter = new Set(after.badges.map((b) => b.badgeRef));
  for (const b of before.badges) if (!badgesAfter.has(b.badgeRef)) out.push(`Бейдж пропал — ${b.title ?? b.badgeRef}`);
  const pinsBefore = new Set(before.pinnedPosts.map((p) => p.postRef));
  const pinsAfter = new Set(after.pinnedPosts.map((p) => p.postRef));
  const pinned = after.pinnedPosts.filter((p) => !pinsBefore.has(p.postRef)).length;
  const unpinned = before.pinnedPosts.filter((p) => !pinsAfter.has(p.postRef)).length;
  if (pinned > 0) out.push(`Закреплено постов: ${pinned}`);
  if (unpinned > 0) out.push(`Откреплено постов: ${unpinned}`);
  const wallsBefore = new Map(before.walls.map((w) => [w.wallRef, w]));
  const wallsAfter = new Map(after.walls.map((w) => [w.wallRef, w]));
  for (const [ref, w] of wallsAfter) {
    const old = wallsBefore.get(ref);
    if (old === undefined) out.push(`Новая стена — ${w.name ?? ref}`);
    else {
      if ((old.name ?? "") !== (w.name ?? "")) out.push(`Стена переименована: «${shortText(old.name, 40)}» → «${shortText(w.name, 40)}»`);
      if (old.private !== w.private) out.push(`Стена «${shortText(w.name, 40)}» ${w.private ? "скрыта" : "открыта"}`);
    }
  }
  for (const [ref, w] of wallsBefore) if (!wallsAfter.has(ref)) out.push(`Стена удалена — ${w.name ?? ref}`);
  if (out.length === 0) out.push("Изменились служебные настройки профиля");
  return out;
}

export interface ChangeDay {
  /** The day the new look or setting was first seen. */
  at: string;
  changes: string[];
}

/** One feed: the profile's versions and the settings' earlier answers, the newest first, by day. */
export function accountChanges(profile: PageProfileResponse | undefined, settings: PageSettingsResponse | undefined): ChangeDay[] {
  const events: Array<{ at: string; text: string }> = [];
  const versions = profile?.versions ?? [];
  for (let i = 1; i < versions.length; i += 1) {
    for (const change of profileChanges(versions[i - 1]!, versions[i]!)) events.push({ at: versions[i]!.firstSeenAt, text: change });
  }
  for (const row of settings?.routes ?? []) {
    // The balance in hold moves every day: it is a tile, not a change.
    if (row.route === "earnings.overview") continue;
    const chain = [...row.earlier].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
    const all = [...chain, row.current];
    for (let i = 1; i < all.length; i += 1) {
      events.push({
        at: all[i]!.firstSeenAt,
        text: `${SETTING_LABELS[row.route] ?? row.route}: «${fanslySettingWords(all[i - 1]!.summary)}» → «${fanslySettingWords(all[i]!.summary)}»`,
      });
    }
  }
  const byDay = new Map<string, ChangeDay>();
  for (const event of events.sort((a, b) => b.at.localeCompare(a.at))) {
    const day = event.at.slice(0, 10);
    const entry = byDay.get(day) ?? { at: event.at, changes: [] };
    entry.changes.push(event.text);
    byDay.set(day, entry);
  }
  return [...byDay.values()];
}
