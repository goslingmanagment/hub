import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { NoAnswerPanel } from "@agency_hub_core/ui/console/StatusPanel";
import { Skeleton } from "@agency_hub_core/ui/console/Skeleton";
import { formatDate, formatDateTime } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { kernel } from "@/shared/hub";
import { shiftPath } from "@/shared/links";
import { usePeopleIndex } from "@/shared/people";

const messagesWord = (count: number) => `${count} ${ruPlural(count, "сообщение", "сообщения", "сообщений")}`;

/**
 * «Кто с ним работал» (the owner asked for it by name, products package M): who wrote to this fan on this page, by
 * person, and the shifts it was in — from the authorship and the shifts Hub keeps (`pageFanWorkedWith`). Whose a sale
 * is stays the sale's chain's: here only who wrote and when.
 */
export function FanWorkedWith({ pageLabel, platformUserId }: { pageLabel: string; platformUserId: string }) {
  const people = usePeopleIndex();
  const query = useQuery({
    queryKey: ["pageFanWorkedWith", pageLabel, platformUserId],
    queryFn: () => kernel.pageFanWorkedWith({ params: { pageLabel, platformUserId } }),
    meta: { suppressGlobalError: true },
  });
  const data = query.data;
  // A person with several logins is one person: their rows add up under one name.
  const byPerson = new Map<string, { name: string; messages: number; priced: number; shifts: number; lastAt: string; firstAt: string }>();
  for (const author of data?.authors ?? []) {
    const key = people.keyOf(author.userId);
    const row = byPerson.get(key) ?? { name: people.nameOf(author.userId, author.username), messages: 0, priced: 0, shifts: 0, lastAt: author.lastAt, firstAt: author.firstAt };
    row.messages += author.messages;
    row.priced += author.priced;
    row.shifts += author.shifts;
    if (author.lastAt > row.lastAt) row.lastAt = author.lastAt;
    if (author.firstAt < row.firstAt) row.firstAt = author.firstAt;
    byPerson.set(key, row);
  }
  const persons = [...byPerson.values()].sort((a, b) => b.messages - a.messages);

  return (
    <section className="card" aria-labelledby="fan-worked-title">
      <div className="card-header">
        <div>
          <h2 id="fan-worked-title" className="card-title">Кто с ним работал</h2>
          <p className="card-description">Кто писал этому фану на этой странице и в каких сменах.</p>
        </div>
      </div>
      <div className="card-body">
        {!data ? (
          query.isError ? <NoAnswerPanel retry={query.refetch} /> : <Skeleton width="80%" />
        ) : persons.length === 0 ? (
          <p className="fan-muted-line">Из расширения ему никто не писал.</p>
        ) : (
          <>
            <ul className="fan-other-list">
              {persons.map((person) => (
                <li key={person.name}>
                  <div className="fan-other-head">
                    <span className="fan-link">{person.name}</span>
                    <span className="fan-other-sum">{messagesWord(person.messages)}</span>
                  </div>
                  <p className="fan-cell-sub">
                    {[
                      person.shifts > 0 ? `${person.shifts} ${ruPlural(person.shifts, "смена", "смены", "смен")}` : null,
                      person.priced > 0 ? `платных ${person.priced}` : null,
                      person.firstAt.slice(0, 10) === person.lastAt.slice(0, 10) ? formatDate(person.lastAt) : `${formatDate(person.firstAt)} – ${formatDate(person.lastAt)}`,
                    ].filter(Boolean).join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
            {data.shifts.length > 0 && (
              <>
                <h3 className="card-title fan-worked-shifts">Смены</h3>
                <ul className="fan-other-list">
                  {data.shifts.map((shift) => (
                    <li key={`${shift.userId}:${shift.shiftId ?? shift.startedAt}`}>
                      <div className="fan-other-head">
                        <Link className="fan-link" to={shiftPath(shift.userId, shift.startedAt, new URLSearchParams({ page: pageLabel }))}>{formatDateTime(shift.startedAt)}</Link>
                        <span className="fan-other-model">{people.nameOf(shift.userId, shift.username)}</span>
                        <span className="fan-other-sum">{messagesWord(shift.messages)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                {data.shiftsTotal > data.shifts.length && <p className="fan-muted-line">Показаны последние {data.shifts.length} из {data.shiftsTotal}.</p>}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
