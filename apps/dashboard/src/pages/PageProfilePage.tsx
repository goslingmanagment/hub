import { useMemo, type ReactNode } from "react";
import { useParams } from "react-router";
import type { PageProfileResponse } from "@agency_hub_core/contracts";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import { usePageProfile } from "@/api/page-profile";
import { AnalyticsEmpty, AnalyticsError, AnalyticsLoading, AnalyticsPanel } from "@/components/analytics/AnalyticsPanel";
import { DayChart } from "@/components/creator-stats/DayChart";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDate, formatRelativeTime } from "@/lib/format";

/**
 * The page's own Fansly profile (0337): what a creator sees on her profile and
 * in its editor — name, bio, location, social links, the badges Fansly
 * awarded, pinned posts, walls — read out of the hourly `/account/me`, its
 * changes since 2026-07 and the counters under it per day. Fansly only.
 */

type Version = NonNullable<PageProfileResponse["current"]>;
type Day = PageProfileResponse["daily"][number];

const DAYS = 180;

/** `profileSocials[].providerId` as the profile editor names them (bundle 2026-10-29). */
const SOCIAL_PROVIDERS: Record<string, { label: string; url?: (handle: string) => string }> = {
  "1": { label: "X (Twitter)", url: (handle) => `https://x.com/${handle}` },
  "4": { label: "Instagram", url: (handle) => `https://instagram.com/${handle}` },
  "5": { label: "TikTok", url: (handle) => `https://tiktok.com/@${handle}` },
  "8": { label: "Bluesky", url: (handle) => `https://bsky.app/profile/${handle}` },
  "9": { label: "Fleshlight" },
};

function socialLabel(providerId: string): string {
  return SOCIAL_PROVIDERS[providerId]?.label ?? `Сеть ${providerId}`;
}

function shortText(value: string | null, max = 80): string {
  if (value === null || value.trim() === "") return "пусто";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** What changed from one version to the next, in words. */
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
  if (out.length === 0) out.push("Поменялись служебные флаги профиля");
  return out;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function ProfileNow({ profile }: { profile: Version }) {
  return (
    <AnalyticsPanel title="Профиль сейчас" description={`Так страница выглядит на Fansly · проверено ${formatRelativeTime(profile.lastSeenAt)}`}>
      <div className="card-body">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя">{profile.displayName ?? "—"}</Field>
          <Field label="Ник">{profile.username ? `@${profile.username}` : "—"}</Field>
          <Field label="Локация">{profile.location || "не указана"}</Field>
          <Field label="Соцсети">
            {profile.socials.length === 0 ? "не указаны" : (
              <ul className="space-y-0.5">
                {profile.socials.map((s) => {
                  const url = SOCIAL_PROVIDERS[s.providerId]?.url?.(s.handle);
                  return (
                    <li key={`${s.providerId}:${s.handle}`}>
                      {socialLabel(s.providerId)}: {url ? <a className="link" href={url} target="_blank" rel="noreferrer">{s.handle}</a> : s.handle}
                    </li>
                  );
                })}
              </ul>
            )}
          </Field>
          <div className="sm:col-span-2">
            <Field label="Описание">
              {profile.about ? <p className="whitespace-pre-wrap">{profile.about}</p> : "пусто"}
            </Field>
          </div>
        </dl>
      </div>
    </AnalyticsPanel>
  );
}

function Badges({ profile }: { profile: Version }) {
  return (
    <AnalyticsPanel title="Бейджи" description="Награды Fansly на профиле: места в лидерборде и другие.">
      {profile.badges.length === 0 ? <AnalyticsEmpty reason="Бейджей на профиле нет." /> : (
        <div className="card-body">
          <ul className="space-y-2">
            {[...profile.badges].reverse().map((badge) => (
              <li key={badge.badgeRef}>
                <span className="badge badge-success">{badge.title ?? "Бейдж"}</span>
                <span className="ml-2 text-sm text-muted">{badge.awardedAt ? formatDate(badge.awardedAt, { includeYear: true }) : ""}</span>
                {badge.description ? <p className="mt-0.5 text-sm text-muted">{badge.description}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </AnalyticsPanel>
  );
}

function WallsAndPins({ profile }: { profile: Version }) {
  const wallName = new Map(profile.walls.map((w) => [w.wallRef, w.name ?? "без названия"]));
  return (
    <AnalyticsPanel title="Стены и закрепы" description="Стены профиля по порядку и закреплённые на них посты.">
      {profile.walls.length === 0 ? <AnalyticsEmpty reason="Стен Fansly не прислал." /> : (
        <div className="card-body overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr><th>Стена</th><th>Видна</th><th>Закреплено</th></tr>
            </thead>
            <tbody>
              {profile.walls.map((wall) => {
                const pins = profile.pinnedPosts.filter((p) => p.wallRef === wall.wallRef);
                return (
                  <tr key={wall.wallRef}>
                    <td>
                      {wall.name ?? "без названия"}
                      {wall.mainWall ? <span className="badge ml-2">главная</span> : null}
                      {wall.defaultWall ? <span className="badge ml-2">по умолчанию</span> : null}
                      {wall.description ? <div className="text-xs text-muted">{shortText(wall.description, 120)}</div> : null}
                    </td>
                    <td>{wall.private ? "скрыта" : "всем"}</td>
                    <td>
                      {pins.length === 0 ? "—" : pins.map((pin) => (
                        <a key={pin.postRef} className="link mr-2" href={`https://fansly.com/post/${pin.postRef}`} target="_blank" rel="noreferrer">
                          пост{pin.pinnedAt ? ` от ${formatDate(pin.pinnedAt, { includeYear: true })}` : ""}
                        </a>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {profile.pinnedPosts.some((p) => p.wallRef === null || !wallName.has(p.wallRef)) ? (
            <p className="mt-2 text-sm text-muted">
              Закреплено вне этих стен: {profile.pinnedPosts.filter((p) => p.wallRef === null || !wallName.has(p.wallRef)).length}
            </p>
          ) : null}
        </div>
      )}
    </AnalyticsPanel>
  );
}

function Counters({ daily }: { daily: readonly Day[] }) {
  const last = daily.at(-1) ?? null;
  const rows = daily.map((day) => ({
    bucketStart: day.day,
    followers: day.followers,
    subscribers: day.subscribers,
    postLikes: day.postLikes,
    mediaLikes: day.mediaLikes,
  }));
  return (
    <AnalyticsPanel title="Счётчики профиля" description={`Последнее значение каждого дня за ${DAYS} дней.`}>
      {last === null ? <AnalyticsEmpty reason="Счётчиков пока нет." /> : (
        <div className="card-body space-y-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Фолловеры">{last.followers ?? "—"}</Field>
            <Field label="Подписчики">{last.subscribers ?? "—"}</Field>
            <Field label="Фото · видео · наборы">{`${last.images ?? "—"} · ${last.videos ?? "—"} · ${last.bundles ?? "—"}`}</Field>
            <Field label="Баланс к выводу">{last.earningsBalanceMills === null ? "—" : formatUsdFromMills(last.earningsBalanceMills)}</Field>
            <Field label="Лайки постов">{last.postLikes ?? "—"}</Field>
            <Field label="Лайки медиа">{last.mediaLikes ?? "—"}</Field>
            <Field label="Истории сейчас">{last.stories ?? "—"}</Field>
            <Field label="Стрим">{last.streamStatus === null ? "канала нет" : last.streamStatus === 2 ? "в эфире" : "не в эфире"}</Field>
          </dl>
          {/* Followers and subscribers differ by two orders: one axis each. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <DayChart lines rows={rows} series={[{ key: "followers", label: "Фолловеры", color: "var(--color-chart-blue)" }]} />
            <DayChart lines rows={rows} series={[{ key: "subscribers", label: "Подписчики", color: "var(--color-chart-magenta)" }]} />
          </div>
          <DayChart
            lines
            rows={rows}
            series={[
              { key: "postLikes", label: "Лайки постов", color: "var(--color-chart-orange)" },
              { key: "mediaLikes", label: "Лайки медиа", color: "var(--color-chart-green)" },
            ]}
          />
        </div>
      )}
    </AnalyticsPanel>
  );
}

function History({ versions }: { versions: readonly Version[] }) {
  const events = useMemo(() => {
    const out: { at: string; changes: string[] }[] = [];
    for (let i = 1; i < versions.length; i += 1) out.push({ at: versions[i]!.firstSeenAt, changes: profileChanges(versions[i - 1]!, versions[i]!) });
    return out.reverse();
  }, [versions]);
  const since = versions[0]?.firstSeenAt ?? null;
  return (
    <AnalyticsPanel title="История изменений" description={since ? `Что менялось в профиле с ${formatDate(since, { includeYear: true })}: когда новый вид появился впервые.` : undefined}>
      {events.length === 0 ? <AnalyticsEmpty reason="Профиль с тех пор не менялся." /> : (
        <div className="card-body">
          <ul className="space-y-3">
            {events.map((event) => (
              <li key={event.at}>
                <div className="text-sm text-muted">{formatDate(event.at, { includeYear: true })}</div>
                <ul className="list-disc pl-5">
                  {event.changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </AnalyticsPanel>
  );
}

export function PageProfilePage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const query = usePageProfile(pageLabel, DAYS);
  if (query.isPending) return <AnalyticsLoading what="Загружаем профиль…" />;
  if (query.isError || !query.data) return <AnalyticsError message="Не удалось загрузить профиль." onRetry={() => void query.refetch()} />;
  const { current, versions, daily, page } = query.data;
  if (page.platform !== "fansly") return <StatusPanel title="Профиль есть только у страниц Fansly" />;
  if (current === null) return <StatusPanel title="Профиль ещё не прочитан" description="Он появится после ближайшего часового опроса страницы." />;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <ProfileNow profile={current} />
        <Badges profile={current} />
      </div>
      <WallsAndPins profile={current} />
      <Counters daily={daily} />
      <History versions={versions} />
    </div>
  );
}
