import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { kernel } from "@/api/sdk";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

/**
 * The OnlyFans API's banned-words dictionary: a bounded, explicit download. The
 * request is the old one (`ofapiBannedWordsRefresh {maxPages}`); it now asks first,
 * because it spends credits, and waits while the API is off.
 */
export function OfapiBannedWords({ blocked }: { blocked: string | null }) {
  const [maxPages, setMaxPages] = useState(1); const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const query = useQuery({ queryKey: ["ofapi", "banned-words"], queryFn: () => kernel.ofapiBannedWordsAdminGet(), meta: { suppressGlobalError: true } });
  const refresh = useMutation({ meta: { suppressGlobalError: true }, mutationFn: () => kernel.ofapiBannedWordsRefresh({ body: { maxPages } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["ofapi", "banned-words"] }) });
  return (
    <div className="sys-stack-16">
      <p className="font-medium">
        {query.data
          ? `${query.data.entries.length} выражений · ${query.data.complete ? "полный обход" : "частичный обход"} · загружен ${formatDateTime(query.data.observedAt, { yearUnlessCurrent: true })}`
          : query.isLoading ? "Читаем сохранённый словарь…" : query.isError ? "Сохранённый словарь недоступен" : "Словарь ещё не загружен"}
      </p>
      <div className="sys-harvest-row">
        <label className="block">
          <span className="field-label">Не более страниц</span>
          <input aria-label="Лимит страниц словаря" type="number" min={1} max={30} value={maxPages} onChange={(e) => setMaxPages(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} className="input sys-cap-input" />
        </label>
        <button type="button" disabled={refresh.isPending || blocked !== null} title={blocked ?? undefined} className="btn sys-align-end" onClick={() => setConfirming(true)}>
          {refresh.isPending ? "Загружаем…" : "Загрузить ограниченный словарь"}
        </button>
      </div>
      <p className="field-hint">До {maxPages} {ruPlural(maxPages, "запроса", "запросов", "запросов")} по 100 строк. Цена не подтверждена; фактические кредиты записываются в журнал. Фонового обновления нет.</p>
      {refresh.isError && <p role="alert" className="sys-error">Не удалось загрузить словарь.</p>}
      {confirming && (
        <ConfirmModal
          title="Загрузить словарь запрещённых слов?"
          message="Hub запросит словарь у OnlyFans API."
          facts={[
            { label: "Что именно", value: `до ${maxPages} ${ruPlural(maxPages, "запроса", "запросов", "запросов")} по 100 строк` },
            { label: "Сколько стоит", value: "цена не подтверждена, фактические кредиты попадут в журнал" },
            { label: "Отменить", value: "нельзя, запросы уйдут сразу" },
          ]}
          confirmLabel="Загрузить словарь"
          pendingLabel="Загружаем…"
          tone="primary"
          initialFocus="cancel"
          isPending={refresh.isPending}
          onConfirm={() => refresh.mutate(undefined, { onSettled: () => setConfirming(false) })}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
