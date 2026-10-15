import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { kernel } from "../../api/sdk.js";
export function OfapiBannedWords() {
  const [maxPages, setMaxPages] = useState(1); const qc = useQueryClient();
  const query = useQuery({ queryKey: ["ofapi", "banned-words"], queryFn: () => kernel.ofapiBannedWordsAdminGet() });
  const refresh = useMutation({ mutationFn: () => kernel.ofapiBannedWordsRefresh({ body: { maxPages } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["ofapi", "banned-words"] }) });
  return <section className="card card-body">
    <h3 className="card-title">Словарь запрещённых слов</h3>
    <p className="mt-2 text-sm text-text-secondary">Подсказки для редактора сообщений. Текст не меняется автоматически. Проверка использует буквальные совпадения; сложные правила проверяет провайдер при отправке.</p>
    <p className="mt-2 text-sm">{query.data ? `${query.data.entries.length} выражений · ${query.data.complete ? "полный обход" : "частичный обход"} · ${new Date(query.data.observedAt).toLocaleString("ru-RU")}` : query.isLoading ? "Чтение сохранённого словаря…" : query.isError ? "Сохранённый словарь недоступен" : "Словарь ещё не загружен"}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3"><label className="text-sm">Не более страниц <input aria-label="Лимит страниц словаря" type="number" min={1} max={30} value={maxPages} onChange={e => setMaxPages(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} className="input ml-2 inline-block w-20" /></label>
      <button type="button" disabled={refresh.isPending} className="btn btn-primary" onClick={() => refresh.mutate()}>{refresh.isPending ? "Загружаем…" : "Загрузить ограниченный словарь"}</button></div>
    <p className="mt-2 text-xs text-text-muted">До {maxPages} запросов, по 100 строк. Цена не подтверждена; фактические кредиты записываются в журнал. Фонового обновления нет.</p>
    {(query.isError || refresh.isError) && <p role="alert" className="mt-2 text-sm text-danger">{(refresh.error ?? query.error)?.message}</p>}
  </section>;
}
