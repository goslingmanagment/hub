import { useMemo } from "react";
import { useLocation, useParams } from "react-router";
import type { PageProfileResponse, PageSettingsResponse } from "@agency_hub_core/contracts";
import { useAuthMe } from "@/api/queries";
import { usePageProfile } from "@/api/page-profile";
import { usePageSettings } from "@/api/page-settings";
import { DayChart } from "@/components/creator-stats/DayChart";
import { ChartTable } from "@/components/charts/ChartTable";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatAgo, formatBusinessDateShort, formatCount, formatDate, formatMills } from "@/lib/format";
import { decodeRouteSegment } from "@/lib/navigation";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";
import { accountChanges, SOCIAL_PROVIDERS, socialLabel } from "./accountChanges.js";
import { fanslySettingWords, SETTING_ROUTES } from "./fanslySettingWords.js";
import { CollectionBlock } from "./summary/SummaryBlocks.js";
import { usePageCollection } from "./usePageCollection.js";

type Profile = PageProfileResponse;
type Version = NonNullable<Profile["current"]>;
type Day = Profile["daily"][number];

const DAYS = 180;

function day(iso: string | null): string {
  return iso ? formatDate(iso, { includeYear: true }) : "—";
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatCount(value);
}

/** The balance in hold, in mills as Fansly serves it; no number — null. */
function pendingBalance(settings: PageSettingsResponse | undefined): number | null {
  const body = settings?.routes.find((row) => row.route === "earnings.overview")?.current.body;
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { pendingBalance?: unknown }).pendingBalance;
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * «Аккаунт на Fansly»: how the page looks and is set up on Fansly and what changed.
 * Reads only: all of it is changed on Fansly itself (§9.4).
 */
export function AccountPage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const label = decodeRouteSegment(pageLabel);
  const { hash } = useLocation();
  useScrollToAnchor("fansly-settings", hash === "#fansly-settings");
  const { findPageByLabel } = useDashboardShell();
  const page = findPageByLabel(label);
  const { data: auth } = useAuthMe();
  const role = auth?.user.role === "owner" ? "owner" : "team_lead";
  const profile = usePageProfile(label, DAYS);
  const settings = usePageSettings(label);
  const changes = useMemo(() => accountChanges(profile.data, settings.data), [profile.data, settings.data]);
  if (!page) return null;

  return (
    <div className="pc-account">
      <AccountCollection page={page} role={role} />
      <LooksBlock query={profile} />
      <CountersBlock profile={profile} settings={settings} />
      <SettingsBlock query={settings} />
      <ChangesBlock profile={profile.data} settings={settings.data} changes={changes} loading={profile.isPending || settings.isPending} failed={profile.isError && settings.isError} retry={() => { void profile.refetch(); void settings.refetch(); }} />
    </div>
  );
}

function AccountCollection({ page, role }: { page: Parameters<typeof usePageCollection>[0] & { followerCount?: unknown; lastLightSyncAt: string | null }; role: "owner" | "team_lead" }) {
  const collection = usePageCollection(page, role);
  return <CollectionBlock page={{ ...page, followerCount: null }} collection={collection} owner={role === "owner"} compact />;
}

function LooksBlock({ query }: { query: ReturnType<typeof usePageProfile> }) {
  const current = query.data?.current ?? null;
  return (
    <section className="card" aria-labelledby="account-looks-title">
      <div className="card-header">
        <div>
          <h2 id="account-looks-title" className="card-title">Как выглядит</h2>
          <p className="card-description">
            {current ? `Так страница выглядит на Fansly, проверено ${formatAgo(current.lastSeenAt)}. Читается раз в час.` : "Так страница выглядит на Fansly. Читается раз в час."}
          </p>
        </div>
      </div>
      {!query.data ? (
        <div className="card-body">{query.isError ? <NoAnswerPanel retry={query.refetch} /> : <><Skeleton width="60%" /><Skeleton width="40%" /></>}</div>
      ) : current === null ? (
        <div className="card-body"><p className="fan-muted-line">Профиль ещё не прочитан. Он появится после ближайшего часового опроса страницы.</p></div>
      ) : (
        <>
          <div className="card-body account-looks">
            <dl className="kv">
              <dt>Имя</dt><dd>{current.displayName ?? "—"}</dd>
              <dt>Ник</dt><dd>{current.username ? `@${current.username}` : "—"}</dd>
              <dt>Локация</dt><dd>{current.location || <span className="text-text-muted">не указана</span>}</dd>
              <dt>Соцсети</dt>
              <dd>
                {current.socials.length === 0 ? <span className="text-text-muted">не указаны</span> : (
                  <ul className="account-socials">
                    {current.socials.map((social) => {
                      const url = SOCIAL_PROVIDERS[social.providerId]?.url?.(social.handle);
                      return <li key={`${social.providerId}:${social.handle}`}>{socialLabel(social.providerId)}: {url ? <a className="link" href={url} target="_blank" rel="noreferrer">{social.handle}</a> : social.handle}</li>;
                    })}
                  </ul>
                )}
              </dd>
              <dt>Описание</dt><dd className="whitespace-pre-wrap">{current.about || <span className="text-text-muted">пусто</span>}</dd>
            </dl>
            <div className="account-badges">
              <h3 className="fan-subtitle">Бейджи</h3>
              {current.badges.length === 0 ? <p className="fan-muted-line">Бейджей на профиле нет.</p> : (
                <ul className="account-badge-list">
                  {[...current.badges].reverse().map((badge) => (
                    <li key={badge.badgeRef}>
                      <p className="font-medium">{badge.title ?? "Бейдж"}{badge.awardedAt && <span className="fan-cell-sub">, {day(badge.awardedAt)}</span>}</p>
                      {badge.description && <p className="fan-cell-sub">{badge.description}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <Walls profile={current} />
        </>
      )}
    </section>
  );
}

function Walls({ profile }: { profile: Version }) {
  const known = new Set(profile.walls.map((wall) => wall.wallRef));
  const outside = profile.pinnedPosts.filter((pin) => pin.wallRef === null || !known.has(pin.wallRef)).length;
  return (
    <div className="account-walls">
      <h3 className="fan-subtitle account-walls-title">Стены и закреплённые посты</h3>
      {profile.walls.length === 0 ? <p className="fan-muted-line account-walls-title">Стен Fansly не прислал.</p> : (
        <div className="table-wrap">
          <table className="data-table fan-table">
            <thead><tr><th scope="col">Стена</th><th scope="col">Видна</th><th scope="col">Закреплено</th></tr></thead>
            <tbody>
              {profile.walls.map((wall) => {
                const pins = profile.pinnedPosts.filter((pin) => pin.wallRef === wall.wallRef);
                const marks = [wall.mainWall ? "главная" : null, wall.defaultWall ? "по умолчанию" : null].filter(Boolean).join(", ");
                return (
                  <tr key={wall.wallRef}>
                    <td>
                      <div>{wall.name ?? "без названия"}{marks && <span className="fan-cell-sub"> · {marks}</span>}</div>
                      {wall.description && <div className="fan-cell-sub">{wall.description}</div>}
                    </td>
                    <td>{wall.private ? "скрыта" : "всем"}</td>
                    <td>
                      {pins.length === 0 ? <span className="text-text-muted">—</span> : (
                        <span className="account-pins">
                          {pins.map((pin) => (
                            <a key={pin.postRef} className="link" href={`https://fansly.com/post/${pin.postRef}`} target="_blank" rel="noreferrer">
                              пост{pin.pinnedAt ? ` от ${day(pin.pinnedAt)}` : ""}
                            </a>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {outside > 0 && <p className="fan-muted-line account-walls-title">Закреплено вне этих стен: {outside}</p>}
    </div>
  );
}

function CountersBlock({ profile, settings }: { profile: ReturnType<typeof usePageProfile>; settings: ReturnType<typeof usePageSettings> }) {
  const daily = profile.data?.daily ?? [];
  const last: Day | null = daily.at(-1) ?? null;
  const hold = pendingBalance(settings.data);
  if (!profile.data) return profile.isError ? <NoAnswerPanel retry={profile.refetch} /> : <StatCardSkeleton count={4} />;
  if (last === null) return <p className="fan-muted-line">Счётчиков пока нет.</p>;
  const stream = last.streamStatus === null ? "канала нет" : last.streamStatus === 2 ? "в эфире" : "не в эфире";
  const rows = daily.map((row) => ({ bucketStart: row.day, followers: row.followers, subscribers: row.subscribers, postLikes: row.postLikes, mediaLikes: row.mediaLikes }));
  return (
    <section className="account-counters" aria-label="Баланс и счётчики">
      <StatGrid>
        <Stat label="Баланс к выводу" value={last.earningsBalanceMills === null ? "—" : formatMills(last.earningsBalanceMills)} />
        <Stat label="Баланс в холде" value={hold === null ? "—" : formatMills(hold)} meta={settings.isError && !settings.data ? "Hub не ответил" : undefined} />
        <Stat label="Фолловеры" value={count(last.followers)} />
        <Stat label="Подписчиков по данным Fansly" value={count(last.subscribers)} />
      </StatGrid>
      <dl className="account-line">
        <div><dt>Лайки постов</dt><dd>{count(last.postLikes)}</dd></div>
        <div><dt>Лайки медиа</dt><dd>{count(last.mediaLikes)}</dd></div>
        <div><dt>Фото · видео · наборы</dt><dd>{count(last.images)} · {count(last.videos)} · {count(last.bundles)}</dd></div>
        <div><dt>Истории сейчас</dt><dd>{count(last.stories)}</dd></div>
        <div><dt>Эфир</dt><dd>{stream}</dd></div>
      </dl>
      <p className="fan-muted-line">Последнее значение за день, по данным Fansly. В доход на Главной баланс не входит.</p>
      <Disclosure label={`Как менялось за ${DAYS} дней`} lazy>
        <div className="account-charts">
          <div><h3 className="fan-subtitle">Фолловеры</h3><DayChart lines rows={rows} series={[{ key: "followers", label: "Фолловеры", color: "var(--color-chart-blue)" }]} height={200} /></div>
          <div><h3 className="fan-subtitle">Подписчики</h3><DayChart lines rows={rows} series={[{ key: "subscribers", label: "Подписчики", color: "var(--color-chart-blue)" }]} height={200} /></div>
          <div className="account-charts-wide">
            <h3 className="fan-subtitle">Лайки</h3>
            <DayChart lines rows={rows} series={[{ key: "postLikes", label: "Лайки постов", color: "var(--color-chart-blue)" }, { key: "mediaLikes", label: "Лайки медиа", color: "var(--color-chart-orange)" }]} height={200} />
          </div>
        </div>
        <ChartTable
          rows={[...daily].reverse()}
          rowKey={(row) => row.day}
          caption="Счётчики по дням"
          columns={[
            { key: "day", label: "День", value: (row) => formatBusinessDateShort(row.day) },
            { key: "followers", label: "Фолловеры", num: true, value: (row) => count(row.followers) },
            { key: "subscribers", label: "Подписчики", num: true, value: (row) => count(row.subscribers) },
            { key: "postLikes", label: "Лайки постов", num: true, value: (row) => count(row.postLikes) },
            { key: "mediaLikes", label: "Лайки медиа", num: true, value: (row) => count(row.mediaLikes) },
          ]}
        />
      </Disclosure>
    </section>
  );
}

function SettingsBlock({ query }: { query: ReturnType<typeof usePageSettings> }) {
  const routes = query.data?.routes ?? [];
  const byRoute = new Map(routes.map((row) => [row.route, row]));
  const checked = routes.reduce<string | null>((newest, row) => (newest === null || row.current.lastSeenAt > newest ? row.current.lastSeenAt : newest), null);
  return (
    <section id="fansly-settings" className="card scroll-mt-16" aria-labelledby="fansly-settings-title">
      <div className="card-header">
        <div>
          <h2 id="fansly-settings-title" className="card-title">Как настроено на Fansly</h2>
          <p className="card-description">{checked ? `Как в настройках кабинета, проверено ${formatAgo(checked)}. Читается раз в сутки.` : "Как в настройках кабинета. Читается раз в сутки."}</p>
        </div>
      </div>
      {!query.data ? (
        query.isError ? <div className="card-body"><NoAnswerPanel retry={query.refetch} /></div> : <TableSkeleton rows={6} columns={3} />
      ) : routes.length === 0 ? (
        <div className="card-body"><p className="fan-muted-line">Настройки ещё не прочитаны: Hub читает их раз в сутки.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table fan-table">
            <thead><tr><th scope="col">Что</th><th scope="col">Сейчас</th><th scope="col">С какого дня</th></tr></thead>
            <tbody>
              {SETTING_ROUTES.map(({ route, label }) => {
                const row = byRoute.get(route);
                return (
                  <tr key={route}>
                    <td className="account-setting-name">{label}</td>
                    <td className="account-setting-value">{row ? fanslySettingWords(row.current.summary) : <span className="text-text-muted">ещё не прочитано</span>}</td>
                    <td className="account-setting-day">{row ? day(row.current.firstSeenAt) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ChangesBlock({ profile, settings, changes, loading, failed, retry }: {
  profile: Profile | undefined;
  settings: PageSettingsResponse | undefined;
  changes: ReturnType<typeof accountChanges>;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}) {
  const profileSince = profile?.versions[0]?.firstSeenAt ?? null;
  const settingsSince = (settings?.routes ?? []).flatMap((row) => [row.current.firstSeenAt, ...row.earlier.map((item) => item.firstSeenAt)]).sort()[0] ?? null;
  const since = [profileSince ? `в профиле с ${day(profileSince)}` : null, settingsSince ? `в настройках с ${day(settingsSince)}` : null].filter(Boolean).join(" и ");
  return (
    <section className="card" aria-labelledby="account-changes-title">
      <div className="card-header">
        <div>
          <h2 id="account-changes-title" className="card-title">Что менялось</h2>
          {since && <p className="card-description">Что менялось {since}.</p>}
        </div>
      </div>
      <div className="card-body">
        {loading ? <><Skeleton width="50%" /><Skeleton width="70%" /></> : failed ? <NoAnswerPanel retry={retry} /> : changes.length === 0 ? (
          <p className="fan-muted-line">С тех пор ничего не менялось.</p>
        ) : (
          <ol className="account-changes">
            {changes.map((entry) => (
              <li key={entry.at}>
                <p className="account-change-day">{day(entry.at)}</p>
                <ul>{entry.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
