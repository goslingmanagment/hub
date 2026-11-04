import { useState } from "react";
import type { AdminAiChatterLimit } from "@agency_hub_core/contracts";
import { microUsdFromDollars } from "@agency_hub_core/shared";
import { toast } from "sonner";
import { useAdminUpdateAiChatterLimit } from "@/api/adminAiSpend";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { Notice } from "@/components/ui/Notice";
import { Spinner } from "@/components/ui/Skeleton";
import { formatAiUsd, formatBusinessDateShort } from "@/lib/format";
import { isUnknownOutcome } from "../settingsFeedback.js";

/** The same reading as before: a comma is a point, `$` and spaces go, 0 to 1000. */
export function parseLimitDollars(text: string): number | null {
  const parsed = Number(text.replace(",", ".").replace(/[$\s]/g, ""));
  return text.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000 ? parsed : null;
}

const LIMIT_MAX = microUsdFromDollars(1000);

/**
 * A person's daily AI limit: what it was and what it becomes, before the one
 * request. The person is the row's; a past day says the change is for now.
 */
export function LimitWindow({ person, day, live, onClose }: {
  person: AdminAiChatterLimit;
  /** The day the screen shows; a past one gets its notice. */
  day: string;
  live: boolean;
  onClose: () => void;
}) {
  const update = useAdminUpdateAiChatterLimit();
  const current = person.dailyLimitMicroUsd;
  const [draft, setDraft] = useState(current === null ? "" : (current / 1_000_000).toFixed(2));
  const [removing, setRemoving] = useState(false);
  const parsed = parseLimitDollars(draft);
  const next = parsed === null ? null : microUsdFromDollars(parsed);
  const touched = draft !== (current === null ? "" : (current / 1_000_000).toFixed(2));
  const changed = next !== null && next !== current;

  function save(dailyLimitMicroUsd: number | null) {
    update.mutate({ userId: person.userId, body: { dailyLimitMicroUsd } }, {
      onSuccess: () => {
        toast.success(dailyLimitMicroUsd === null ? `Лимит ${person.username} убран` : `Лимит ${person.username}: ${formatAiUsd(dailyLimitMicroUsd)}`);
        onClose();
      },
    });
  }

  const failure = update.error
    ? isUnknownOutcome(update.error)
      ? "Hub не ответил: неизвестно, сохранилось ли. Закройте окно и посмотрите столбец «Лимит»."
      : "Не удалось сохранить. Лимит прежний."
    : null;

  return (
    <ModalShell
      title={`Лимит ИИ в день: ${person.username}`}
      onClose={() => { if (!update.isPending) onClose(); }}
      explicitCloseOnly={touched || update.isPending}
      size="confirm"
    >
      <div className="space-y-4">
        {!live && <Notice>Вы смотрите {formatBusinessDateShort(day).replace(/\.$/, "")}. Правка меняет лимит сейчас, а не тот день.</Notice>}
        {removing ? (
          <p className="dialog-text">Личного лимита не будет, останется общий потолок на страницу.</p>
        ) : (
          <>
            <Field
              label="Лимит, долларов"
              hint={`От $0.00 до ${formatAiUsd(LIMIT_MAX)}. ${live ? "Сегодня" : "В тот день"} потрачено ${formatAiUsd(person.spentMicroUsd)}.`}
              error={draft.trim() !== "" && parsed === null ? "Нужна сумма в долларах, например $5.00." : undefined}
            >
              <input
                className="input tabular-nums"
                inputMode="decimal"
                value={draft}
                aria-invalid={draft.trim() !== "" && parsed === null}
                placeholder="например, 5.00"
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
            {next === 0 && (
              <p className="settings-second">При $0.00 человек тратит только общий запас. Когда запас кончится, у него не работает весь ИИ до 00:00.</p>
            )}
          </>
        )}
        <dl className="confirm-facts">
          <dt>Было → стало</dt>
          <dd className="tabular-nums">
            {current === null ? "нет" : formatAiUsd(current)} → {removing ? "нет" : next === null ? "…" : formatAiUsd(next)}
          </dd>
          <dt>Когда</dt>
          <dd>Сразу. Новый день начнётся в 00:00 по Москве</dd>
        </dl>
        {failure && <Notice tone="warning" role="alert">{failure}</Notice>}
      </div>
      <div className="dialog-actions settings-limit-actions">
        {current !== null && !removing && (
          <button type="button" className="btn btn-ghost settings-limit-remove" disabled={update.isPending} onClick={() => { update.reset(); setRemoving(true); }}>
            Убрать лимит
          </button>
        )}
        <button type="button" className="btn" disabled={update.isPending} onClick={() => (removing ? setRemoving(false) : onClose())}>
          {removing ? "Назад" : "Отмена"}
        </button>
        {removing ? (
          <button type="button" className="btn btn-primary" disabled={update.isPending} onClick={() => save(null)}>
            {update.isPending && <Spinner />}
            {update.isPending ? "Сохраняем…" : "Подтвердить: убрать лимит"}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={update.isPending || !changed} onClick={() => next !== null && save(next)}>
            {update.isPending && <Spinner />}
            {update.isPending ? "Сохраняем…" : "Сохранить лимит"}
          </button>
        )}
      </div>
    </ModalShell>
  );
}
