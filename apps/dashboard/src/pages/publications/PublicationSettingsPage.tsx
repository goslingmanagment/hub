import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { usePublicationSettings, useUpdatePublicationSettings } from "@/api/publications";
import { ModalShell } from "@/components/shared/ModalShell";
import { PlatformTag } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { ruPlural } from "@/lib/plural";
import { GlobalSwitchLine, PageStateMark } from "./PublicationParts.js";
import {
  actionFailure,
  dayKeyOf,
  momentLabel,
  priceRangeLabel,
  settingsDraftFrom,
  settingsForm,
  type PublicationPageSettings,
  type SettingsDraft,
} from "./publicationsView.js";

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: ReactNode }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      {children}
      {error !== undefined && <p role="alert" className="field-hint text-danger">{error}</p>}
      {hint !== undefined && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/** One page's publishing: the switch, the paid price range in dollars, the repeat threshold and the daily limit. */
function SettingsDialog({ settings, globalEnabled, onClose }: {
  settings: PublicationPageSettings;
  globalEnabled: boolean;
  onClose: () => void;
}) {
  const update = useUpdatePublicationSettings();
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftFrom(settings));
  const [failure, setFailure] = useState<string | null>(null);
  const enabledId = useId();
  const form = settingsForm(draft);
  const todayKey = dayKeyOf(new Date());
  const put = (change: Partial<SettingsDraft>) => setDraft((current) => ({ ...current, ...change }));
  const closeUnlessPending = () => { if (!update.isPending) onClose(); };

  function submit() {
    if (form.body === null || update.isPending) return;
    setFailure(null);
    update.mutate({ pageLabel: settings.pageLabel, body: form.body }, {
      onSuccess: () => { toast.success(`Сохранено: ${settings.pageLabel}`); onClose(); },
      onError: (error) => setFailure(actionFailure(error)),
    });
  }

  return (
    <ModalShell title={`Публикация на ${settings.pageLabel}`} onClose={closeUnlessPending}>
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {settings.autostopReason !== null && (
          <div role="alert" className="notice notice-danger">
            <div>
              <p className="font-semibold">Hub остановил публикацию{settings.autostoppedAt === null ? "" : ` ${momentLabel(settings.autostoppedAt, todayKey)} МСК`}</p>
              <p className="mt-1">{settings.autostopReason}</p>
              <p className="mt-1">Включите снова, когда разберётесь: включение снимает остановку.</p>
            </div>
          </div>
        )}

        <div>
          <label htmlFor={enabledId} className="flex items-start gap-3">
            <input
              id={enabledId}
              type="checkbox"
              className="mt-1"
              checked={draft.enabled}
              disabled={update.isPending}
              onChange={(event) => put({ enabled: event.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-text-primary">Публиковать на этой странице</span>
              <span className="block text-xs text-text-muted">
                Выключено — Hub не ставит новые посты и не загружает файлы на эту страницу. Уже поставленное остаётся
                в расписании площадки.
              </span>
            </span>
          </label>
          {draft.enabled && !globalEnabled && (
            <p className="field-hint">Общий выключатель сейчас выключен: пока его не включат, страница всё равно не публикует.</p>
          )}
        </div>

        <Field
          label="Цена платного поста, $"
          hint={settings.platform === "onlyfans"
            ? "Платные посты на OnlyFans пока выключены; вилка понадобится, когда их включат."
            : "Цена вне вилки не утверждается. Пусто — платные посты на странице не утверждаются."}
          error={form.errors.price}
        >
          <div className="flex items-start gap-2">
            <label className="flex-1">
              <span className="sr-only">от</span>
              <input
                className="input"
                inputMode="decimal"
                placeholder="от, например 5"
                value={draft.priceMin}
                disabled={update.isPending}
                aria-invalid={form.errors.priceMin !== undefined || form.errors.price !== undefined}
                onChange={(event) => put({ priceMin: event.target.value })}
              />
              {form.errors.priceMin !== undefined && <span role="alert" className="field-hint block text-danger">{form.errors.priceMin}</span>}
            </label>
            <span className="pt-2 text-text-muted">—</span>
            <label className="flex-1">
              <span className="sr-only">до</span>
              <input
                className="input"
                inputMode="decimal"
                placeholder="до, например 30"
                value={draft.priceMax}
                disabled={update.isPending}
                aria-invalid={form.errors.priceMax !== undefined || form.errors.price !== undefined}
                onChange={(event) => put({ priceMax: event.target.value })}
              />
              {form.errors.priceMax !== undefined && <span role="alert" className="field-hint block text-danger">{form.errors.priceMax}</span>}
            </label>
          </div>
        </Field>

        <Field
          label="Повтор файла, дней"
          hint="Файл, который выходил на странице ближе этого срока, утверждается только с отметкой «перезалив»."
          error={form.errors.repostDays}
        >
          <input
            className="input w-32"
            inputMode="numeric"
            value={draft.repostDays}
            disabled={update.isPending}
            aria-invalid={form.errors.repostDays !== undefined}
            onChange={(event) => put({ repostDays: event.target.value })}
          />
        </Field>

        <Field
          label="Предел постов в сутки"
          hint="Пусто — без предела. Hub и так предупредит, когда за день набирается вдвое больше постов, чем обычно."
          error={form.errors.dailyLimit}
        >
          <input
            className="input w-32"
            inputMode="numeric"
            placeholder="без предела"
            value={draft.dailyLimit}
            disabled={update.isPending}
            aria-invalid={form.errors.dailyLimit !== undefined}
            onChange={(event) => put({ dailyLimit: event.target.value })}
          />
        </Field>

        {failure !== null && <p role="alert" className="notice notice-danger">{failure}</p>}

        <div className="flex justify-end gap-3 border-t border-border pt-4">
          <button type="button" className="btn" disabled={update.isPending} onClick={closeUnlessPending}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={form.body === null || update.isPending}>
            {update.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/** Each page's publishing settings (spec §8): off by default, and only the owner turns it on. */
export function PublicationSettingsPage() {
  const settings = usePublicationSettings();
  const [editing, setEditing] = useState<PublicationPageSettings | null>(null);

  if (!settings.data) {
    return settings.isLoading
      ? <TableSkeleton rows={6} columns={5} />
      : (
        <StatusPanel
          title="Настройки не загрузились"
          description="Hub не ответил: попробуйте ещё раз."
          tone="error"
          action={<button type="button" className="btn btn-sm" onClick={() => void settings.refetch()}>Повторить</button>}
        />
      );
  }

  const { globalEnabled, pages } = settings.data;
  return (
    <div className="space-y-5">
      <GlobalSwitchLine enabled={globalEnabled} />
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Публикация по страницам</h2>
            <p className="card-description">У новой страницы публикация выключена. Включает её владелец.</p>
          </div>
        </div>
        {pages.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-text-secondary">Нет активных страниц.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[760px]">
              <thead>
                <tr>
                  <th>Страница</th>
                  <th>Публикация</th>
                  <th>Платные посты</th>
                  <th className="num">Повтор файла</th>
                  <th className="num">Предел в сутки</th>
                  <th><span className="sr-only">Действие</span></th>
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr key={page.pageLabel}>
                    <td className="whitespace-nowrap font-medium">
                      <span className="inline-flex items-center gap-1.5">{page.pageLabel} <PlatformTag platform={page.platform} /></span>
                    </td>
                    <td className="max-w-[320px]">
                      <PageStateMark settings={page} />
                      {page.autostopReason !== null && <div className="mt-0.5 text-xs text-danger">{page.autostopReason}</div>}
                    </td>
                    <td className="whitespace-nowrap">{priceRangeLabel(page.paidPriceMinMills, page.paidPriceMaxMills)}</td>
                    <td className="num">через {page.repostThresholdDays} {ruPlural(page.repostThresholdDays, "день", "дня", "дней")}</td>
                    <td className="num">{page.dailyLimit ?? "без предела"}</td>
                    <td className="text-right">
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(page)}>Изменить</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing !== null && (
        <SettingsDialog key={editing.pageLabel} settings={editing} globalEnabled={globalEnabled} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
