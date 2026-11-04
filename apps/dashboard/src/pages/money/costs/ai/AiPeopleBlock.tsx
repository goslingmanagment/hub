import { Fragment, useState } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import type { AdminAiChatterLimit, AdminAiSpendResponse, AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { useAdminAiChatterLimits } from "@/api/adminAiSpend";
import { useAdminChatterUsage } from "@/api/adminUsage";
import { Notice } from "@/components/ui/Notice";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatAiUsd, formatCount, formatDateTime, formatDuration } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { AI_LIMIT_STATUS } from "@/lib/statusWords";
import { ROLE_WORD, anyFeatureLabel, callsWord, compact, sharePct, todayMoscow } from "./aiShared.js";

type Spend = AdminAiSpendResponse;
type UsageRow = AdminChatterUsageResponse["rows"][number];

interface Person {
  userId: number;
  username: string;
  role: string | null;
  cost: number;
  approximate: boolean;
  calls: number;
  limit: AdminAiChatterLimit | undefined;
  shift: Spend["shifts"]["byChatter"][number] | undefined;
  usage: UsageRow | undefined;
}

function TodayCell({ limit }: { limit: AdminAiChatterLimit | undefined }) {
  if (!limit) return <span className="text-text-muted">—</span>;
  return (
    <Link to="/settings/ai/limits" className="ai-limit-link" title="Лимиты меняются в «Настройки → ИИ → Лимиты»">
      <span>
        {formatAiUsd(limit.spentMicroUsd)}
        {limit.dayLimitMicroUsd !== null && ` из ${formatAiUsd(limit.dayLimitMicroUsd)}`}
      </span>
      {limit.dayLimitMicroUsd === null && <span className="ai-sub">лимита нет</span>}
      {limit.blocked && <StatusBadge status={AI_LIMIT_STATUS.exhausted} />}
      {(limit.fromPoolMicroUsd ?? 0) > 0 && (
        <>
          <StatusBadge status={AI_LIMIT_STATUS.sharedPool} />
          <span className="ai-sub">из запаса {formatAiUsd(limit.fromPoolMicroUsd!)}</span>
        </>
      )}
    </Link>
  );
}

/** The detail under a person: their features, tokens and calls, from the usage report. */
function PersonDetail({ person, total, usageFailed, retry }: { person: Person; total: number; usageFailed: boolean; retry: () => void }) {
  const row = person.usage;
  return (
    <div className="row-detail-body ai-person-detail">
      <p>
        Доля {sharePct(person.cost, total)}, за вызов {person.calls > 0 ? formatAiUsd(Math.round(person.cost / person.calls)) : "—"}
        {row?.topFeature && <>. Чаще всего: {anyFeatureLabel(row.topFeature.feature)}, {callsWord(row.topFeature.requestCount)}, {Math.round(row.topFeature.sharePct)} %</>}
      </p>
      {!row ? (
        usageFailed
          ? <p className="text-text-secondary">Подробности не пришли. <button type="button" className="link" onClick={retry}>Повторить</button></p>
          : <p className="text-text-secondary">Подробностей нет: отчёт считает только вызовы чаттеров.</p>
      ) : (
        <>
          <ul className="ai-feature-list">
            {row.featureBreakdown.map((feature) => (
              <li key={feature.feature}>
                <span className="font-medium">{anyFeatureLabel(feature.feature)}</span>
                <span>
                  {callsWord(feature.requestCount)}
                  {feature.costMicroUsd > 0 && `, ${feature.costApproximate ? "≈ " : ""}${formatAiUsd(feature.costMicroUsd)}`}
                  {feature.regenerateRatePct > 0 && `, перегенерации ${Math.round(feature.regenerateRatePct)} %`}
                </span>
                <span className="text-text-secondary">
                  {compact(feature.tokenCounts.input)} на входе, {compact(feature.tokenCounts.output)} на выходе, {compact(feature.tokenCounts.cacheTotal)} из кэша
                </span>
              </li>
            ))}
          </ul>
          <p className="text-text-secondary">
            Всего токенов: {compact(row.tokenCounts.input)} на входе, {compact(row.tokenCounts.output)} на выходе, {compact(row.tokenCounts.cacheTotal)} из кэша.
            {row.gateway.requestCount > 0 && (
              <> Вызовы ИИ: {formatCount(row.gateway.requestCount)}, выполнено {formatCount(row.gateway.completedCount)}, с ошибкой {formatCount(row.gateway.failedCount)}
                {row.gateway.cancelledCount > 0 && `, отменено ${formatCount(row.gateway.cancelledCount)}`}
                {row.gateway.openReservationCount > 0 && `, ещё идут ${formatCount(row.gateway.openReservationCount)}`}
                {row.gateway.providerBreakdown.map((provider) => `, ${provider.provider}: ${formatCount(provider.requestCount)}, ${formatAiUsd(provider.costMicroUsd)}`).join("")}.
                {row.gateway.requestCount !== person.calls && " Число вызовов отличается от столбца: туда не входят отказы по лимиту."}
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * «Люди»: one table of everyone who costs AI. Today's limit is only shown here and
 * leads to its one home, /settings/ai/limits: no write on this screen.
 */
export function AiPeopleBlock({ data, range }: { data: Spend; range: { from: string; to: string } }) {
  const limits = useAdminAiChatterLimits(todayMoscow(), true);
  const usage = useAdminChatterUsage(range);
  const [open, setOpen] = useState<number | null>(null);
  const total = data.total.costMicroUsd;

  const people = new Map<number, Person>();
  const person = (userId: number, username: string): Person => {
    const existing = people.get(userId);
    if (existing) return existing;
    const created: Person = { userId, username, role: null, cost: 0, approximate: false, calls: 0, limit: undefined, shift: undefined, usage: undefined };
    people.set(userId, created);
    return created;
  };
  for (const row of data.breakdowns.chatter) {
    const id = Number(row.key);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const entry = person(id, row.label);
    entry.cost = row.costMicroUsd;
    entry.calls = row.calls;
    entry.approximate = row.approximateMicroUsd > 0;
  }
  for (const limit of limits.data?.chatters ?? []) {
    const entry = person(limit.userId, limit.username);
    entry.role = limit.role;
    entry.limit = limit;
  }
  for (const shift of data.shifts.byChatter) person(shift.userId, shift.username).shift = shift;
  for (const row of usage.data?.rows ?? []) if (people.has(row.userId)) people.get(row.userId)!.usage = row;
  const rows = [...people.values()].sort((a, b) => b.cost - a.cost || a.username.localeCompare(b.username));
  const hub = data.breakdowns.chatter.find((row) => row.key === "background");
  const pool = limits.data?.pool;

  return (
    <section className="card" aria-labelledby="ai-people-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="ai-people-title" className="card-title">Люди</h2>
          {pool && (
            <p className="card-description">
              Общий запас сегодня {formatAiUsd(pool.microUsd)}, взято {formatAiUsd(pool.usedMicroUsd)}, осталось {formatAiUsd(pool.remainingMicroUsd)}
            </p>
          )}
        </div>
        <Link className="link text-sm" to="/settings/ai/limits">Изменить лимиты</Link>
      </div>
      {limits.isError && !limits.data && (
        <div className="card-body pb-4">
          <Notice tone="warning" role="status" action={<button type="button" className="btn btn-sm" onClick={() => void limits.refetch()}>Повторить</button>}>Лимиты не пришли.</Notice>
        </div>
      )}
      <div className="table-wrap">
        <table className="data-table" aria-label="Траты на ИИ по сотрудникам">
          <thead>
            <tr>
              <th scope="col">Сотрудник</th>
              <th scope="col" className="num">Траты</th>
              <th scope="col" className="num">Вызовов</th>
              <th scope="col" className="num" title="Всегда сегодня, по Москве">Сегодня / лимит</th>
              <th scope="col" className="num" title="Смены: от первого действия в расширении до часа без действий">Часы работы</th>
              <th scope="col" className="num" title="ИИ в сменах на час работы">За час</th>
              <th scope="col" className="num" title="Доля ответов, которые сгенерировали заново">Перегенерации</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const expanded = open === entry.userId;
              const isChatter = entry.role === "chatter" || (entry.role === null && Boolean(entry.shift));
              return (
                <Fragment key={entry.userId}>
                  <tr>
                    <td>
                      <div className="ai-account">
                        <button
                          type="button"
                          className="home-expander"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Свернуть" : "Раскрыть"} ${entry.username}`}
                          onClick={() => setOpen(expanded ? null : entry.userId)}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                        <div className="min-w-0">
                          <Link className="money-link font-medium" to={isChatter ? `/team/chatters/${entry.userId}` : `/team/people/${entry.userId}`}>{entry.username}</Link>
                          {entry.role && <div className="ai-sub">{ROLE_WORD[entry.role] ?? entry.role}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="num">{entry.approximate ? "≈ " : ""}{formatAiUsd(entry.cost)}</td>
                    <td className="num">{formatCount(entry.calls)}</td>
                    <td className="num"><TodayCell limit={entry.limit} /></td>
                    <td className="num">{entry.shift ? formatDuration(entry.shift.workedMinutes) : "—"}</td>
                    <td className="num">{entry.shift?.perWorkedHourMicroUsd != null ? formatAiUsd(entry.shift.perWorkedHourMicroUsd) : "—"}</td>
                    <td className="num">
                      {entry.usage && entry.usage.totalGenerations > 0 ? (
                        <span className="inline-flex items-center justify-end gap-2">
                          {Math.round(entry.usage.regenerateRatePct)} %
                          {entry.usage.warning && <StatusBadge tone="attention" title="Перегенерировали больше 30 % ответов">много</StatusBadge>}
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="row-detail">
                      <td colSpan={7}>
                        <PersonDetail person={entry} total={total} usageFailed={usage.isError} retry={() => void usage.refetch()} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {hub && (
              <tr>
                <td><span className="ai-hub-name">Сам Hub</span></td>
                <td className="num">{hub.approximateMicroUsd > 0 ? "≈ " : ""}{formatAiUsd(hub.costMicroUsd)}</td>
                <td className="num">{formatCount(hub.calls)}</td>
                <td className="num" colSpan={4} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data.shifts.shifts > 0 && (
        <div className="card-footer justify-start">
          Часы и «за час» — смены с {formatDateTime(data.shifts.from)} по {formatDateTime(data.shifts.to)}: {formatCount(data.shifts.shifts)} {ruPlural(data.shifts.shifts, "смена", "смены", "смен")},
          ИИ на смену {data.shifts.perShiftMicroUsd != null ? formatAiUsd(data.shifts.perShiftMicroUsd) : "—"}, на час работы{" "}
          {data.shifts.perWorkedHourMicroUsd != null ? formatAiUsd(data.shifts.perWorkedHourMicroUsd) : "—"}; вне смен {formatAiUsd(data.shifts.outsideShiftsMicroUsd)}.
        </div>
      )}
    </section>
  );
}
