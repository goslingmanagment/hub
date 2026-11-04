import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { AdminAiChatterLimit } from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, previousBusinessDate, toBusinessDate } from "@agency_hub_core/shared";
import { useAdminAiChatterLimits } from "@/api/adminAiSpend";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton, StatCardSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { DayNav } from "@/components/ui/PeriodStepper";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatAiUsd, formatBusinessDateShort } from "@/lib/format";
import { AI_LIMIT_STATUS } from "@/lib/statusWords";
import { StaleNotice } from "../StaleNotice.js";
import { LimitWindow } from "./LimitWindow.js";

const ROLE_WORDS: Record<string, string> = { owner: "владелец", team_lead: "тимлид", chatter: "чаттер" };
const FLASH_MS = 2_000;

/** The day of the screen: `?day=`, never in the future; a bad one is today. */
function useLimitsDay() {
  const [search, setSearch] = useSearchParams();
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const asked = search.get("day");
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today;
  const go = (next: string) => {
    const query = new URLSearchParams(search);
    if (next >= today) query.delete("day");
    else query.set("day", next);
    setSearch(query);
  };
  return { day, today, go };
}

/** The share of the day's limit spent: a quiet bar, amber once the AI stopped. */
function LimitBar({ person }: { person: AdminAiChatterLimit }) {
  const limit = person.dayLimitMicroUsd;
  if (limit === null) return null;
  const share = limit > 0 ? Math.min(person.spentMicroUsd / limit, 1) : 1;
  return (
    <span className={`limit-bar ${person.blocked ? "is-blocked" : ""}`} aria-hidden="true">
      <span style={{ width: `${share * 100}%` }} />
    </span>
  );
}

/**
 * «Лимиты»: what a person's AI may cost in a Moscow day and how much is left in
 * the shared reserve. A past day shows the limits as they were; the edit always
 * changes the limit now (design/screens/settings.md §6). Sums come from the hub only.
 */
export function AiLimitsPage() {
  const { day, today, go } = useLimitsDay();
  const live = day >= today;
  const { hash } = useLocation();
  const { data, isLoading, isError, isFetching, isPlaceholderData, refetch, dataUpdatedAt } = useAdminAiChatterLimits(day, live);
  const [editing, setEditing] = useState<AdminAiChatterLimit | null>(null);
  const [lit, setLit] = useState<number | null>(null);

  // `#person-<userId>` from the AI spending or a person's card: scroll and light the row.
  useEffect(() => {
    if (!data || !hash.startsWith("#person-")) return;
    const id = Number(hash.slice("#person-".length));
    const row = document.getElementById(`person-${id}`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    setLit(id);
    const timer = window.setTimeout(() => setLit(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [data, hash]);

  const shownDay = data?.day ?? day;
  const dayLabel = formatBusinessDateShort(shownDay);
  const header = (
    <PageHeader
      actions={(
        <>
          {!live && <button type="button" className="btn btn-sm" onClick={() => go(today)}>Сегодня</button>}
          <DayNav day={day} today={today} onChange={go} />
        </>
      )}
      window={live ? "Сегодня. Новый день в 00:00" : `${dayLabel}, как было в тот день`}
      fresh={dataUpdatedAt ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined}
    />
  );

  if (isLoading && !data) {
    return (
      <>
        {header}
        <div className="stack"><StatCardSkeleton count={3} /><div className="card"><TableSkeleton rows={4} columns={4} /></div></div>
      </>
    );
  }
  if (!data) {
    return (
      <>
        {header}
        <StatusPanel
          tone="error"
          title="Hub не ответил"
          description="Лимиты не пришли. Это не ноль."
          action={<button type="button" className="btn btn-sm" onClick={() => void refetch()}>Повторить</button>}
        />
      </>
    );
  }

  const { pool } = data;
  const dataLive = data.day >= today;

  return (
    <>
      {header}
      <div className={`stack ${isPlaceholderData ? "opacity-60" : ""}`}>
        {isError && <StaleNotice at={dataUpdatedAt} retry={() => refetch()} />}
        <StatGrid className="settings-pool">
          <Stat
            label="Осталось в общем запасе"
            value={formatAiUsd(pool.remainingMicroUsd)}
            meta={pool.remainingMicroUsd <= 0 && pool.microUsd > 0 ? "Запас кончился" : undefined}
          />
          <Stat label="Запас на день" value={formatAiUsd(pool.microUsd)} meta="что люди с лимитом недотратили вчера" />
          <Stat label="Взято из запаса" value={formatAiUsd(pool.usedMicroUsd)} />
        </StatGrid>

        {data.chatters.length === 0 ? (
          <StatusPanel title="Сотрудников пока нет" description="Лимиты появятся, когда в команде будут люди." />
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table className="data-table settings-limits-table">
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th className="num">{dataLive ? "Сегодня" : dayLabel}</th>
                    <th className="num">{dataLive ? "Вчера" : formatBusinessDateShort(previousBusinessDate(data.day))}</th>
                    <th className="num">{dataLive ? "Лимит в день" : "Лимит сейчас"}</th>
                    <th><span className="sr-only">Действия</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.chatters.map((person) => {
                    const fromPool = person.fromPoolMicroUsd ?? 0;
                    const badge = person.blocked
                      ? dataLive ? AI_LIMIT_STATUS.exhausted : AI_LIMIT_STATUS.wasExhausted
                      : fromPool > 0 ? dataLive ? AI_LIMIT_STATUS.sharedPool : AI_LIMIT_STATUS.wasSharedPool : null;
                    return (
                      <tr key={person.userId} id={`person-${person.userId}`} className={lit === person.userId ? "settings-row-flash" : undefined}>
                        <td>
                          <div className="settings-person">
                            <Link to={`/team/people/${person.userId}`} className="settings-link font-medium">{person.username}</Link>
                            {badge && <StatusBadge status={badge} />}
                          </div>
                          <div className="settings-second">{ROLE_WORDS[person.role] ?? person.role}</div>
                        </td>
                        <td className="num">
                          <div>
                            {formatAiUsd(person.spentMicroUsd)}
                            {person.dayLimitMicroUsd !== null && <span className="muted"> из {formatAiUsd(person.dayLimitMicroUsd)}</span>}
                          </div>
                          <LimitBar person={person} />
                          {fromPool > 0 && <div className="settings-second">из запаса {formatAiUsd(fromPool)}</div>}
                        </td>
                        <td className="num">
                          <div>{formatAiUsd(person.dayBeforeMicroUsd)}</div>
                          {person.intoPoolMicroUsd !== null && person.intoPoolMicroUsd > 0 && (
                            <div className="settings-second">в запас +{formatAiUsd(person.intoPoolMicroUsd)}</div>
                          )}
                        </td>
                        <td className="num">
                          {person.dailyLimitMicroUsd === null ? <span className="muted">нет</span> : formatAiUsd(person.dailyLimitMicroUsd)}
                        </td>
                        <td>
                          <div className="settings-actions">
                            <button type="button" className="btn btn-sm" onClick={() => setEditing(person)}>
                              {person.dailyLimitMicroUsd === null ? "Задать" : "Изменить"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Disclosure>
          <p>Сколько ИИ может стоить человеку за день по Москве, на всех страницах вместе. Что люди с лимитом недотратили вчера, складывается в общий запас.</p>
          <p>Дошёл до своего лимита: дальше тратит из общего запаса. Запас кончился: у него не работает весь ИИ до 00:00.</p>
          <p>
            «Нет»: личного лимита нет, остаётся{" "}
            <Link className="link" to="/settings/ai/features/ai-core#config-chatMuseAiGatewayDailyMicroUsdLimit">общий потолок на страницу</Link>.
          </p>
          <p>За прошлый день лимиты и запас показаны такими, какими были в тот день.</p>
        </Disclosure>
      </div>
      {editing && (
        <LimitWindow
          person={data.chatters.find((person) => person.userId === editing.userId) ?? editing}
          day={data.day}
          live={dataLive}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
