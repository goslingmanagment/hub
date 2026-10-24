import { useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useAuthMe } from "@/api/auth";
import { useSaveWinBackApproach, useTeamWinBackApproaches, useTeamWinBackResults } from "@/api/team";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatMills } from "@/lib/format";

/**
 * Chat Memory week 3: win-back approaches — the results by approach and chatter
 * (`teamWinBackResults`) and, for the owner, the list itself
 * (`teamWinBackApproaches`, `teamWinBackApproachSave`).
 */

const RANGES = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
] as const;

const HOW_IT_WORKS = [
  "В расширении на вкладке «Вернуть» чаттер выбирает подход одним касанием и пишет фану сам. Hub записывает выбор и "
    + "считает, что было после первого сообщения этого чаттера фану (в течение 48 часов после выбора).",
  "«Ответили» — фан написал в течение 72 часов; «Купили» — заплатил в течение 7 дней; «Потратили» — сколько за 30 "
    + "дней. Итог считается, только когда его срок прошёл: «3 из 5» — из пяти созревших попыток.",
  "Hub не назначает подходы и не засчитывает продажи: только записывает и считает.",
];

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const NUM_HEAD = "whitespace-nowrap px-3 py-2 text-right text-xs font-medium text-text-muted xl:px-4";
const CELL = "px-3 py-2 align-top text-text-secondary xl:px-4";
const NUM = "px-3 py-2 align-top text-right tabular-nums text-text-secondary xl:px-4";

/** "3 из 5 · 60 %"; "—" when nothing matured yet. */
export function outOf(hits: number, matured: number): string {
  if (matured === 0) return "—";
  return `${hits} из ${matured} · ${Math.round((100 * hits) / matured)} %`;
}

function ApproachesEditor() {
  const { data, isLoading } = useTeamWinBackApproaches(true);
  const save = useSaveWinBackApproach();
  const [draft, setDraft] = useState("");

  function submit(body: Parameters<typeof save.mutate>[0], done?: () => void) {
    save.mutate(body, {
      onSuccess: () => done?.(),
      onError: () => toast.error("Не сохранилось: такое название уже есть или Hub не ответил."),
    });
  }

  return (
    <section aria-label="Подходы для чаттеров" className="card mt-6">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary">Подходы для чаттеров</h2>
        <p className="mt-0.5 text-xs text-text-muted">Чаттеры видят включённые, по порядку. Выключенный подход пропадает из расширения, его итоги остаются.</p>
      </div>
      {isLoading || !data ? <div className="p-4"><TableSkeleton rows={3} columns={2} /></div> : (
        <ul className="divide-y divide-border">
          {data.approaches.map((approach) => (
            <li key={approach.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span className={approach.active ? "text-text-primary" : "text-text-muted line-through"}>{approach.label}</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={save.isPending}
                onClick={() => submit({ id: approach.id, label: approach.label, sortOrder: approach.sortOrder, active: !approach.active })}
              >
                {approach.active ? "Выключить" : "Включить"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          const label = draft.trim();
          if (label === "") return;
          submit({ label, sortOrder: (data?.approaches.length ?? 0) + 1, active: true }, () => setDraft(""));
        }}
      >
        <input
          className="input min-w-[240px] flex-1"
          placeholder="Новый подход, например «Голосовое с именем»"
          maxLength={80}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending || draft.trim() === ""}>Добавить</button>
      </form>
    </section>
  );
}

export function TeamApproachesPage() {
  const [search, setSearch] = useSearchParams();
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  const range = RANGES.some((item) => item.key === search.get("days")) ? search.get("days")! : "30";
  const { data, isLoading, isFetching, refetch } = useTeamWinBackResults(Number(range));

  const header = (
    <div className="mb-5">
      <p className="max-w-3xl text-sm text-text-secondary">Какие подходы возвращают фанов — и у кого.</p>
      <details className="help mt-1">
        <summary>Как это считается</summary>
        <div className="help-body">{HOW_IT_WORKS.map((line) => <p key={line}>{line}</p>)}</div>
      </details>
      <div className="mt-4">
        <FilterButtons
          filters={RANGES.map(({ key, label }) => ({ key, label }))}
          active={range}
          onChange={(key) => setSearch((current) => {
            const next = new URLSearchParams(current);
            next.set("days", key);
            return next;
          })}
        />
      </div>
    </div>
  );

  let body;
  if (!data) {
    body = isLoading
      ? <TableSkeleton rows={4} columns={7} />
      : (
        <StatusPanel
          title="Итоги не загрузились"
          description="Hub не ответил. Попробуйте ещё раз."
          tone="error"
          action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
        />
      );
  } else if (data.rows.length === 0) {
    body = <StatusPanel title="Попыток пока нет" description="Как только чаттеры начнут выбирать подходы на вкладке «Вернуть», здесь появятся итоги." />;
  } else {
    body = (
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={HEAD}>Подход</th>
              <th className={HEAD}>Сотрудник</th>
              <th className={NUM_HEAD}>Выбрал</th>
              <th className={NUM_HEAD}>Написал</th>
              <th className={NUM_HEAD}>Ответили за 72 ч</th>
              <th className={NUM_HEAD}>Купили за 7 дн</th>
              <th className={NUM_HEAD}>Потратили за 30 дн</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={`${row.approachId}:${row.userId}`} className="border-b border-border last:border-b-0">
                <td className={`${CELL} font-medium text-text-primary`}>{row.approach}</td>
                <td className={CELL}>{row.username}</td>
                <td className={NUM}>{row.attempts}</td>
                <td className={NUM}>{row.sent}</td>
                <td className={NUM}>{outOf(row.replied72h, row.matured72h)}</td>
                <td className={NUM}>{outOf(row.bought7d, row.matured7d)}</td>
                <td className={NUM}>{row.matured30d === 0 ? "—" : formatMills(row.spent30dMills)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      {header}
      {body}
      {owner && <ApproachesEditor />}
    </div>
  );
}
