import { useState } from "react";
import type { AdminAiChatterLimit } from "@agency_hub_core/contracts";

import { useAdminAiChatterLimits, useAdminUpdateAiChatterLimit } from "@/api/adminAiSpend";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";

const ROLE_LABELS: Record<string, string> = { owner: "владелец", team_lead: "тимлид", chatter: "чаттер" };

function usd(microUsd: number): string {
  const value = microUsd / 1_000_000;
  if (value === 0) return "$0";
  return `$${value.toFixed(2)}`;
}

function LimitCell({
  person,
  busy,
  onSave,
}: {
  person: AdminAiChatterLimit;
  busy: boolean;
  onSave: (microUsd: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    const parsed = Number(draft.replace(",", ".").replace(/[$\s]/g, ""));
    const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000;
    return (
      <form
        className="flex items-center justify-end gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSave(Math.round(parsed * 1_000_000));
          setEditing(false);
        }}
      >
        <span className="text-text-muted">$</span>
        <input
          className="input w-20 text-right"
          inputMode="decimal"
          autoFocus
          aria-label={`Лимит ИИ в день для ${person.username}, долларов`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!valid || busy}>Сохранить</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Отмена</button>
      </form>
    );
  }

  const startEditing = () => {
    setDraft(person.dailyLimitMicroUsd === null ? "" : String(person.dailyLimitMicroUsd / 1_000_000));
    setEditing(true);
  };

  return (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <span className={person.dailyLimitMicroUsd === null ? "text-text-muted" : "font-medium"}>
        {person.dailyLimitMicroUsd === null ? "нет" : usd(person.dailyLimitMicroUsd)}
      </span>
      <button type="button" className="btn btn-sm" onClick={startEditing} disabled={busy}>
        {person.dailyLimitMicroUsd === null ? "Задать" : "Изменить"}
      </button>
      {person.dailyLimitMicroUsd !== null && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onSave(null)} disabled={busy}>
          Убрать
        </button>
      )}
    </div>
  );
}

function TodayCell({ person }: { person: AdminAiChatterLimit }) {
  const limit = person.dailyLimitMicroUsd;
  if (limit === null) return <>{usd(person.todayMicroUsd)}</>;
  const share = limit > 0 ? Math.min(person.todayMicroUsd / limit, 1) : 1;
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="whitespace-nowrap">
        {usd(person.todayMicroUsd)} <span className="text-text-muted">из {usd(limit)}</span>
      </span>
      <span className="block h-1.5 w-28 overflow-hidden rounded-full bg-border" aria-hidden="true">
        <span
          className={`block h-full rounded-full ${person.blocked ? "bg-danger" : share >= 0.8 ? "bg-warning" : "bg-accent"}`}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </span>
    </div>
  );
}

/** The owner's personal daily AI limits: what each person's AI may cost in a Moscow day. */
export function AiChatterLimitsSection() {
  const { data, isLoading, isError, refetch, isFetching } = useAdminAiChatterLimits();
  const update = useAdminUpdateAiChatterLimit();
  const [error, setError] = useState<string | null>(null);

  const save = (userId: number, microUsd: number | null) => {
    setError(null);
    update.mutate({ userId, body: { dailyLimitMicroUsd: microUsd } }, {
      onError: (cause) => setError(cause instanceof Error ? cause.message : "Не удалось сохранить"),
    });
  };

  let content;
  if (isLoading) {
    content = <TableSkeleton rows={4} columns={3} />;
  } else if (isError && !data) {
    content = (
      <StatusPanel
        title="Не удалось загрузить лимиты"
        description="Сервер не ответил."
        tone="error"
        action={<button type="button" className="btn btn-sm" onClick={() => void refetch()} disabled={isFetching}>Повторить</button>}
      />
    );
  } else if (data) {
    content = (
      <>
        {error && <div role="alert" className="notice notice-warning mx-4 mt-3">{error}</div>}
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Кто</th>
                <th className="num">Сегодня</th>
                <th className="num">Лимит в день</th>
              </tr>
            </thead>
            <tbody>
              {data.chatters.map((person) => (
                <tr key={person.userId}>
                  <td>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{person.username}</span>
                      {person.blocked && <span className="badge badge-danger">ИИ выключен до 00:00</span>}
                    </div>
                    <div className="text-xs text-text-muted">{ROLE_LABELS[person.role] ?? person.role}</div>
                  </td>
                  <td className="num"><TodayCell person={person} /></td>
                  <td className="num">
                    <LimitCell person={person} busy={update.isPending} onSave={(microUsd) => save(person.userId, microUsd)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="ai-chatter-limits-title" className="card">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="ai-chatter-limits-title" className="card-title">Личные лимиты ИИ на день</h2>
          <p className="card-description">
            Сколько ИИ может стоить человеку за день по Москве, на всех страницах вместе. Дошёл до лимита — у него
            не работает весь ИИ до 00:00 МСК. «Нет» — личного лимита нет, остаётся общий потолок на страницу.
          </p>
        </div>
      </div>
      {content}
    </section>
  );
}
