import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { kernel } from "../../api/sdk.js";
import { formatDateTime } from "@/lib/format";

/** The provider's banned-words dictionary: a bounded, explicit download. The
 *  card around it (title, description) belongs to the screen. */
export function OfapiBannedWords() {
  const [maxPages, setMaxPages] = useState(1); const qc = useQueryClient();
  const query = useQuery({ queryKey: ["ofapi", "banned-words"], queryFn: () => kernel.ofapiBannedWordsAdminGet() });
  const refresh = useMutation({ mutationFn: () => kernel.ofapiBannedWordsRefresh({ body: { maxPages } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["ofapi", "banned-words"] }) });
  return <div className="space-y-3 text-sm">
    <p className="font-medium text-text-primary">
      {query.data
        ? `${query.data.entries.length} выражений · ${query.data.complete ? "полный обход" : "частичный обход"} · загружен ${formatDateTime(query.data.observedAt, { yearUnlessCurrent: true })}`
        : query.isLoading ? "Читаем сохранённый словарь…" : query.isError ? "Сохранённый словарь недоступен" : "Словарь ещё не загружен"}
    </p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="field-label">Не более страниц</span>
        <input aria-label="Лимит страниц словаря" type="number" min={1} max={30} value={maxPages} onChange={e => setMaxPages(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} className="input w-24 tabular-nums" />
      </label>
      <button type="button" disabled={refresh.isPending} className="btn" onClick={() => refresh.mutate()}>{refresh.isPending ? "Загружаем…" : "Загрузить ограниченный словарь"}</button>
    </div>
    <p className="field-hint">До {maxPages} запросов по 100 строк. Цена не подтверждена; фактические кредиты записываются в журнал. Фонового обновления нет.</p>
    {(query.isError || refresh.isError) && <p role="alert" className="text-danger">{(refresh.error ?? query.error)?.message}</p>}
  </div>;
}
