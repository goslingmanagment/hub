import { useRef, useState } from "react";
import { Link } from "react-router";
import { KernelApiError } from "@agency_hub_core/contracts";
import { useAdminOfapiBannedWords, useRefreshOfapiBannedWords } from "@/api/adminOfapiBannedWords";
import { useAuthMe } from "@/api/queries";
import { acknowledgeCaptureCustody, clearCaptureCustody, readCaptureCustody, saveCaptureCustody, type OfapiCaptureCustody } from "@/lib/ofapiCaptureCustody";
import { useSessionWorkspace } from "@/lib/useSessionWorkspace";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";

const button = "min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-hover disabled:opacity-50 focus-visible:outline-2";
export function OfapiBannedWords() {
  const query = useAdminOfapiBannedWords();
  const refresh = useRefreshOfapiBannedWords();
  const ownerId = useAuthMe().data?.user.id;
  const [maxPages, setMaxPages] = useState("1");
  const [term, setTerm] = useState("");
  const [category, setCategory] = useState("");
  const [shown, setShown] = useState(100);
  const [allowNewRead, setAllowNewRead] = useState(false);
  const [workspace, setWorkspace, readWorkspace] = useSessionWorkspace("ofapi-dictionary", () => {
    const saved = readCaptureCustody(ownerId, "dictionary");
    return { review: saved.record?.kind === "dictionary" ? saved.record.maxPages : null, unknown: saved.record !== null, error: "", notice: "", busy: false, custodyError: saved.error, record: saved.record, history: saved.history };
  });
  const { review, error, unknown, notice } = workspace;
  const setReview = (review: number | null) => setWorkspace(current => ({ ...current, review }));
  const setError = (error: string) => setWorkspace(current => ({ ...current, error }));
  const setUnknown = (unknown: boolean) => setWorkspace(current => ({ ...current, unknown }));
  const setNotice = (notice: string) => setWorkspace(current => ({ ...current, notice }));
  const pending = refresh.isPending || workspace.busy;
  const inFlight = useRef(false);
  const limit = Number(maxPages);
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= 30;
  const dictionary = query.data;
  const categories = [...new Set(dictionary?.entries.map(entry => entry.category).filter((value): value is string => value !== null) ?? [])];
  const entries = dictionary?.entries.filter(entry => (!category || entry.category === category) && `${entry.word} ${entry.alternatives ?? ""}`.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())) ?? [];
  async function collect() {
    if (inFlight.current || readWorkspace().busy || review === null || unknown) return;
    const record: OfapiCaptureCustody = { kind: "dictionary", maxPages: review, startedAt: new Date().toISOString(), clientRequestId: crypto.randomUUID() };
    try { saveCaptureCustody(ownerId, record); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Контекст сбора не сохранён."); return; }
    inFlight.current = true; setAllowNewRead(false); setWorkspace(current => ({ ...current, busy: true, error: "", notice: "", record }));
    try { const result = await refresh.mutateAsync(review); setReview(null); clearCaptureCustody(ownerId, record); setNotice(`Сохранён словарь: ${result.entries.length} выражений, ${result.pages} страниц ответа. ${result.complete ? "Обход завершён." : "Обход частичный."}`); }
    catch (reason) { const uncertain = !(reason instanceof KernelApiError && reason.category !== "contract" && reason.status !== null && reason.status >= 400 && reason.status < 500); setUnknown(uncertain); if (!uncertain) clearCaptureCustody(ownerId, record); setError(reason instanceof Error ? reason.message : "Ответ обновления не подтверждён."); }
    finally { inFlight.current = false; setWorkspace(current => ({ ...current, busy: false })); }
  }
  return <section className="min-w-0 space-y-3 rounded-xl border border-border-light bg-card p-4" aria-labelledby="ofapi-dictionary-title">
    <h3 id="ofapi-dictionary-title" className="font-semibold">Словарь запрещённых выражений</h3>
    <p className="text-sm text-text-secondary">Подсказки для редактора сообщений. Текст не меняется автоматически. Проверка использует буквальные совпадения; сложные правила проверяет провайдер при отправке.</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={query.isFetching} onClick={() => void query.refetch()}>Обновить сохранённый словарь из Hub</button></div>
    <QueryNotice error={query.isError} stale={dictionary !== undefined} retry={query.refetch} />
    {workspace.custodyError && <p role="alert" className="text-sm text-warning">{workspace.custodyError}</p>}
    {query.isLoading && dictionary === undefined && <StatusPanel title="Читаем сохранённый словарь" />}
    {dictionary === null && !query.isError && <p role="status" className="text-sm text-text-muted">Словарь ещё не собирался. Владелец может запустить ограниченное чтение ниже.</p>}
    {dictionary && <><p className="text-sm">Выражений в ответе: {dictionary.entries.length} · {dictionary.complete ? "полный обход" : "частичный обход"} · получено {new Date(dictionary.observedAt).toLocaleString("ru-RU")}.</p><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">Поиск выражения или альтернативы<input type="search" value={term} onChange={event => { setTerm(event.target.value); setShown(100); }} className="min-h-10 min-w-0 rounded border border-border bg-card px-3 py-2" /></label><label className="grid gap-1 text-sm">Категория<select value={category} onChange={event => { setCategory(event.target.value); setShown(100); }} className="min-h-10 min-w-0 rounded border border-border bg-card px-3 py-2"><option value="">Все категории</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div><p className="text-xs text-text-muted">Найдено в сохранённой выборке: {entries.length}. Показано: {Math.min(shown, entries.length)}.</p><ul className="grid gap-2 sm:grid-cols-2">{entries.slice(0, shown).map((entry, index) => <li key={`${entry.word}:${index}`} className="min-w-0 rounded border border-border p-3 text-sm"><p className="break-words font-medium">{entry.word}</p><p className="text-xs text-text-muted">Риск: {entry.riskLevel || "не указан"} · {entry.category ?? "без категории"}</p><p className="mt-1 break-words text-xs">Альтернатива: {entry.alternatives ?? "не указана"}</p></li>)}</ul>{entries.length === 0 && !query.isError && <p role="status">{dictionary.entries.length ? "Совпадений в сохранённом словаре нет." : "В полученном ответе нет выражений; учитывайте полноту обхода выше."}</p>}{entries.length > shown && <button type="button" className={button} onClick={() => setShown(value => value + 100)}>Показать ещё 100</button>}</>}
    <div className="space-y-3 border-t border-border pt-3"><h4 className="text-sm font-semibold">Прочитать словарь у провайдера</h4><div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm">Не более страниц<input aria-label="Лимит страниц словаря" type="number" min={1} max={30} step={1} value={review !== null ? String(review) : maxPages} disabled={pending || review !== null} onChange={event => setMaxPages(event.target.value)} className="min-h-10 w-28 rounded border border-border bg-card px-3 py-2" /></label><button type="button" disabled={!valid || pending || !!workspace.custodyError || review !== null} className={button} onClick={() => { setReview(limit); setError(""); }}>Проверить ограниченный сбор</button></div>
      {!valid && <p className="text-xs text-warning">Укажите целое число от 1 до 30.</p>}
      <p className="text-xs text-text-muted">До {review ?? (valid ? limit : "—")} запросов, по 100 строк. Цена не подтверждена; фактические кредиты записываются в журнал. Фонового обновления нет.</p>
      {review !== null && <div className="space-y-2 rounded border border-warning/40 p-3 text-sm"><p>{unknown ? "Результат сбора неизвестен. Он мог выполнить платные запросы; повтор автоматически не запускается." : `Будет прочитано до ${review} страниц у провайдера. Подтвердите этот предел.`}</p><div className="flex flex-wrap gap-2">{!unknown && <><button type="button" className={button} disabled={pending} onClick={() => void collect()}>{pending ? "Собираем…" : "Подтвердить чтение у провайдера"}</button><button type="button" className={button} disabled={pending} onClick={() => setReview(null)}>Отмена</button></>}{unknown && <p className="text-xs">Обновите сохранённый словарь из Hub и проверьте время последнего ответа и журнал расходов перед новым сбором.</p>}</div></div>}
      {unknown && workspace.record && <div className="space-y-3 text-sm"><Link className="text-accent underline" to="/ofapi-credits">Открыть журнал кредитов OFAPI</Link><label className="flex items-start gap-2"><input type="checkbox" checked={allowNewRead} onChange={event => setAllowNewRead(event.target.checked)} />Я проверил сохранённый словарь и расходы. Разрешаю новый отдельный сбор, который может добавить расход; прежний исход остаётся неизвестным.</label><button type="button" className={button} disabled={pending || !allowNewRead} onClick={() => {
        const current = readWorkspace(); if (current.busy || !current.record || !allowNewRead) return;
        try { const history = acknowledgeCaptureCustody(ownerId, current.record); setWorkspace(value => ({ ...value, review: null, unknown: false, record: null, history, error: "" })); setAllowNewRead(false); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "Контекст сбора не сохранён."); }
      }}>Перейти к проверке нового сбора</button></div>}
      {!!workspace.history.length && <details className="rounded border border-border p-3"><summary className="min-h-10 cursor-pointer text-sm">Предыдущие сборы с неизвестным исходом: {workspace.history.length}</summary><ul className="space-y-2 text-xs text-text-muted">{workspace.history.map(record => <li key={record.clientRequestId} className="break-all">{record.startedAt} · до {record.kind === "dictionary" ? record.maxPages : "—"} страниц · {record.clientRequestId}. После ручной сверки разрешён отдельный новый сбор; исход этого запроса не подтверждён.</li>)}</ul></details>}
      {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm text-text-secondary">{notice}</p>}
    </div>
  </section>;
}
