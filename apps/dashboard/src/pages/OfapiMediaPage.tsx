import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check } from "lucide-react";
import { useAuthMe } from "@/api/queries";
import { useOfapiExportPages } from "@/api/ofapiExports";
import { ofapiMediaActions, useOfapiMedia } from "@/api/ofapiMedia";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

const ready = (value: boolean | null) =>
  value === true ? "Готово" : value === false ? "Обрабатывается" : "Неизвестно";
const readyBadge = (value: boolean | null) =>
  value === true ? "badge badge-success" : value === false ? "badge badge-warning" : "badge";
const credits = (count: number) => `${count} ${ruPlural(count, "кредит", "кредита", "кредитов")}`;
/** Decimal units, as the upload price is counted: 3 credits per 1 000 000 bytes. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} Б`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000).toLocaleString("ru-RU")} КБ`;
  return `${(bytes / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}
const destinationLabels = { vault: "Медиатека", cdn: "Вложение для одного сообщения" } as const;
const uploadStatusLabels: Record<string, string> = {
  ready: "В очереди", leased: "Выполняется", awaiting_parse: "Обрабатывается", retry_wait: "Ждёт повтора",
  blocked: "Остановлена", complete: "Готово", completed: "Готово", cancelled: "Отменена",
  pending: "Ждёт OnlyFans", processing: "Обрабатывается", in_progress: "Обрабатывается", failed: "Ошибка",
};
const uploadStatusBadges: Record<string, string> = {
  complete: "badge badge-success", completed: "badge badge-success", failed: "badge badge-danger",
  blocked: "badge badge-warning", retry_wait: "badge badge-warning",
};
const reasonLabels: Record<string, string> = {
  background_paused: "Фоновый сбор на паузе", job_unavailable: "Задача недоступна", collection_off: "Сбор выключен",
  on_demand_only: "Сбор только по запросу", upload_status_retry: "OnlyFans не ответил, проверка повторится",
  upload_status_contract_rejected: "Ответ OnlyFans не прошёл проверку", indeterminate: "Результат неизвестен — нужна проверка",
};
const inventoryLabels: Record<string, string> = { never: "Ещё не собиралась", partial: "Собрана частично", complete: "Собрана полностью" };
const providerTypeLabels: Record<string, string> = { photo: "фото", video: "видео", audio: "аудио", gif: "GIF" };
const releaseFormStatusLabels: Record<string, string> = { approved: "одобрено", pending: "на проверке", rejected: "отклонено", expired: "истекло" };

/** One numbered step of the upload: the number, its title, its controls. */
function Step({ number, title, state, children }: { number: number; title: string; state: "done" | "current" | "todo"; children: ReactNode }) {
  const mark = state === "done" ? "bg-accent-soft text-accent" : state === "current" ? "bg-accent text-white" : "bg-hover text-text-muted";
  return <li className="flex gap-4">
    <span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${mark}`}>{state === "done" ? <Check size={15} /> : number}</span>
    <div className="min-w-0 flex-1 space-y-3">
      <h3 className={`text-sm font-semibold leading-7 ${state === "todo" ? "text-text-secondary" : "text-text-primary"}`}><span className="sr-only">Шаг {number}. </span>{title}</h3>
      {children}
    </div>
  </li>;
}

export function OfapiMediaPage() {
  const auth = useAuthMe(),
    owner = auth.data?.user.role === "owner",
    pages = useOfapiExportPages();
  const [selectedPage, setSelectedPage] = useState(0),
    [offset, setOffset] = useState(0);
  const pageId = selectedPage || pages.data?.pages[0]?.id || 0;
  const saved = useOfapiMedia(pageId, offset);
  const [file, setFile] = useState<File | null>(null),
    [sourceId, setSourceId] = useState("");
  const [destination, setDestination] = useState<"vault" | "cdn">("vault"),
    [maxCredits, setMaxCredits] = useState(3),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{
    body: Parameters<typeof ofapiMediaActions.upload>[0];
    pageLabel: string;
    sourceFilename: string;
    receipt: Awaited<ReturnType<typeof ofapiMediaActions.upload>>;
  } | null>(null);
  const [collectionPreview, setCollectionPreview] = useState<{
    selection: string[];
    revision: number;
    pageId: number;
    pageLabel: string;
  } | null>(null);
  const [handoff, setHandoff] = useState<Awaited<
    ReturnType<typeof ofapiMediaActions.handoff>
  > | null>(null);
  const inFlight = useRef(false);
  async function run(action: () => Promise<void>, refreshedNotice?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      const results = await Promise.all([saved.refetch(), pages.refetch()]);
      if (results.some((result) => result.isError)) {
        setError("Не удалось обновить сохранённые данные. Результат действия сохранён; нажмите «Обновить», чтобы проверить.");
      } else if (refreshedNotice) setNotice(refreshedNotice);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function reset() {
    setPreview(null);
    setCollectionPreview(null);
    setHandoff(null);
  }
  async function saveSource() {
    if (!file) return;
    await run(async () => {
      if (file.size > 100000000)
        throw new Error("Выберите файл не больше 100 МБ.");
      const bytes = await file.arrayBuffer(),
        hash = await crypto.subtle.digest("SHA-256", bytes),
        expectedSha256 = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("Файл не удалось прочитать"));
        reader.readAsDataURL(file);
      });
      const source = await ofapiMediaActions.source({
        pageId,
        filename: file.name,
        expectedSha256,
        fileBase64,
      });
      setSourceId(source.id);
      setMaxCredits(Math.max(1, Math.ceil((source.bytes * 3) / 1000000)));
      setNotice("Файл сохранён и проверен. Загрузка в OnlyFans ждёт вашего подтверждения.");
      setPreview(null);
    });
  }
  async function previewUpload() {
    await run(async () => {
      const body = {
        pageId,
        sourceId,
        destination,
        maxCredits,
        requestId: crypto.randomUUID(),
        expectedPolicyRevision: pages.data!.revision,
        dryRun: true,
      };
      const pageLabel =
        pages.data!.pages.find((page) => page.id === body.pageId)?.label ??
        `Страница ${body.pageId}`;
      const sourceFilename =
        saved.data?.sources.find((source) => source.id === body.sourceId)
          ?.filename ?? body.sourceId;
      setPreview({
        body,
        pageLabel,
        sourceFilename,
        receipt: await ofapiMediaActions.upload(body),
      });
    });
  }
  async function copyMaterial(
    input: Parameters<typeof ofapiMediaActions.handoff>[0],
  ) {
    await run(async () => {
      const result = await ofapiMediaActions.handoff(input);
      setHandoff(result);
      try {
        if (!navigator.clipboard) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(result.materialId);
        setNotice("ID скопирован. Выберите этот файл в ChatGoose перед отправкой.");
      } catch {
        setNotice("ID проверен, но скопировать его не удалось — скопируйте ID ниже вручную.");
      }
    });
  }
  const source = saved.data?.sources.find((value) => value.id === sourceId);
  const pageInfo = pages.data?.pages.find((page) => page.id === pageId);
  const pageLabel = pageInfo?.label ?? `Страница ${pageId}`;
  // A page without an OnlyFans API account has no media to read: its read
  // fails with "Mapped page not found", which is this state, not an error.
  const unbound = pageInfo !== undefined && pageInfo.accountId === null;
  const creditsValid = Number.isInteger(maxCredits) && maxCredits >= 1 && maxCredits <= 300;
  const readError = unbound ? null : saved.error;
  const collectionConfirm = collectionPreview && (
    <div className="space-y-3 rounded-lg border border-border bg-hover-alt p-3 text-sm text-text-secondary">
      <p>
        {collectionPreview.pageLabel} · прочитать{" "}
        {collectionPreview.selection.length === 1
          ? "сведения об этом файле"
          : "медиатеку, папки, согласия на публикацию и отмеченных пользователей"}
        . Не больше 10 запросов, 10 кредитов и 4 МБ. Прерванный обход остаётся частичным; сами файлы не скачиваются.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await ofapiMediaActions.collect({
                pageId: collectionPreview.pageId,
                category: "vault_catalog",
                expectedRevision: collectionPreview.revision,
                maxCredits: 10,
                maxCalls: 10,
                maxBytes: 4 * 1024 * 1024,
                from: null,
                to: null,
                selection: collectionPreview.selection,
              });
              setCollectionPreview(null);
              setNotice("Сбор сведений поставлен в очередь. Для большой медиатеки может понадобиться отдельный сбор в «Настройки сбора».");
            })
          }
        >
          Подтвердить сбор · до 10 кредитов
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setCollectionPreview(null)}>Отмена</button>
      </div>
    </div>
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="w-full sm:w-64">
          <span className="field-label">Страница</span>
          <select
            disabled={busy || !pages.data}
            className="select"
            value={pageId}
            onChange={(event) => {
              setSelectedPage(Number(event.target.value));
              setSourceId("");
              setFile(null);
              setOffset(0);
              reset();
            }}
          >
            {pages.data?.pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy || !pageId}
          onClick={() =>
            void run(async () => {}, "Данные обновлены.")
          }
        >
          Обновить
        </button>
        {owner && !unbound && <Link className="link ml-auto pb-2 text-sm" to="/settings?tab=collection">Настройки сбора</Link>}
      </div>
      {(error || readError || pages.error) && (
        <p role="alert" className="notice notice-danger">
          {error || (readError ?? pages.error)?.message}
        </p>
      )}
      {pages.isError && !pages.data && <button type="button" className="btn" disabled={pages.isFetching} onClick={() => void pages.refetch()}>Повторить загрузку страниц</button>}
      {saved.isError && saved.data && !unbound && <p className="notice notice-warning">Показаны прежние данные: текущее состояние проверить не удалось.</p>}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {(pages.isPending || (pageId > 0 && saved.isPending && !unbound)) && <p role="status" className="text-sm text-text-muted">Загружаем медиа…</p>}
      {pages.data && !pages.isError && pages.data.pages.length === 0 && <StatusPanel title="Нет страниц OnlyFans" description={owner ? "Добавьте или привяжите страницу в настройках сбора." : "Страницы OnlyFans пока не добавлены."} />}
      {busy && (
        <p role="status" className="text-sm text-text-muted">
          Ждём ответа сервера…
        </p>
      )}
      {unbound && (
        <StatusPanel
          title="Страница не привязана к OnlyFans API"
          description="Загрузка файлов и медиатека доступны только для страницы с привязанным аккаунтом OnlyFans API."
          action={owner ? <Link to="/settings?tab=collection">Настройки сбора</Link> : undefined}
        />
      )}
      {owner && !unbound && (
        <section className="card" aria-labelledby="media-upload-title">
          <div className="card-header">
            <div className="min-w-0">
              <h2 id="media-upload-title" className="card-title">Загрузить файл в OnlyFans</h2>
              <p className="card-description">Фото, видео или аудио до 100 МБ. Загрузка стоит 3 кредита за каждый МБ, минимум 1 кредит.</p>
            </div>
          </div>
          <ol className="card-body space-y-6">
            <Step number={1} title="Файл" state={source ? "done" : "current"}>
              <div className="flex flex-wrap items-end gap-3">
                <label className="w-full min-w-0 sm:w-auto sm:max-w-sm sm:flex-1">
                  <span className="field-label">Новый файл</span>
                  <input
                    disabled={busy}
                    className="input"
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4"
                    onChange={(event) => {
                      setFile(event.target.files?.[0] ?? null);
                      reset();
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !file || !pageId}
                  onClick={() => void saveSource()}
                >
                  Сохранить файл
                </button>
              </div>
              {file && (
                <p className="field-hint">
                  {file.name} · {formatSize(file.size)}
                </p>
              )}
              <label className="block max-w-xl">
                <span className="field-label">Или сохранённый ранее</span>
                <select
                  disabled={busy}
                  className="select"
                  value={sourceId}
                  onChange={(event) => {
                    setSourceId(event.target.value);
                    const row = saved.data?.sources.find(
                      (source) => source.id === event.target.value,
                    );
                    if (row)
                      setMaxCredits(
                        Math.max(1, Math.ceil((row.bytes * 3) / 1000000)),
                      );
                    reset();
                  }}
                >
                  <option value="">Выберите файл</option>
                  {saved.data?.sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.filename} · {formatSize(source.bytes)}
                    </option>
                  ))}
                </select>
                <span className="field-hint block">Сервер проверяет тип, размер и целостность файла. Сохранённый файл можно загрузить снова без повторной передачи.</span>
              </label>
            </Step>
            <Step number={2} title="Куда загрузить" state={preview ? "done" : source ? "current" : "todo"}>
              <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
                <label className="block min-w-0">
                  <span className="field-label">Назначение</span>
                  <select
                    disabled={busy}
                    className="select"
                    value={destination}
                    onChange={(event) => {
                      setDestination(event.target.value as "vault" | "cdn");
                      reset();
                    }}
                  >
                    <option value="vault">Медиатека</option>
                    <option value="cdn">Вложение для одного сообщения</option>
                  </select>
                  <span className="field-hint block">Файл медиатеки можно отправлять много раз, вложение — один раз.</span>
                </label>
                <label className="block min-w-0">
                  <span className="field-label">Не больше, кредитов</span>
                  <input
                    disabled={busy}
                    className="input"
                    type="number"
                    min={1}
                    max={300}
                    value={maxCredits}
                    onChange={(event) => {
                      setMaxCredits(Number(event.target.value));
                      reset();
                    }}
                  />
                  <span className="field-hint block">Подставлено по размеру файла.</span>
                </label>
              </div>
              {!creditsValid && <p role="alert" className="notice notice-danger">Лимит — целое число от 1 до 300 кредитов.</p>}
              <button
                type="button"
                className="btn"
                disabled={busy || !source || !pages.data || pages.isError || !creditsValid}
                onClick={() => void previewUpload()}
              >
                Показать цену
              </button>
            </Step>
            <Step number={3} title="Подтверждение с ценой" state={preview ? "current" : "todo"}>
              {preview ? (
                <div className="space-y-3">
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:max-w-2xl">
                    <div><dt className="text-xs text-text-muted">Страница</dt><dd className="text-text-primary">{preview.pageLabel}</dd></div>
                    <div><dt className="text-xs text-text-muted">Файл</dt><dd className="break-all text-text-primary">{preview.sourceFilename} · {formatSize(preview.receipt.bytes)}</dd></div>
                    <div><dt className="text-xs text-text-muted">Куда</dt><dd className="text-text-primary">{destinationLabels[preview.receipt.destination]}</dd></div>
                    <div><dt className="text-xs text-text-muted">Цена</dt><dd className="text-text-primary">около {credits(preview.receipt.estimatedCredits)} · не больше {credits(preview.receipt.maxCredits)}</dd></div>
                  </dl>
                  <p className="field-hint">Статус загрузки проверяется не больше 99 раз.</p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await ofapiMediaActions.upload({
                          ...preview.body,
                          dryRun: false,
                        });
                        setPreview(null);
                        setNotice("Загрузка поставлена в очередь. Её ход — в списке загрузок ниже.");
                      })
                    }
                  >
                    Загрузить · до {credits(preview.receipt.maxCredits)}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-text-muted">Цена появится здесь после шага 2. Без подтверждения ничего не загружается.</p>
              )}
            </Step>
          </ol>
          {(source || preview) && (
            <div className="border-t border-border-light px-5 py-3">
              <details className="help">
                <summary>Технические детали</summary>
                <div className="help-body break-all text-xs">
                  {source && <p>Файл: {source.mimeType} · {source.bytes} байт · SHA256 {source.sha256}</p>}
                  {source && <p>ID сохранённого файла: {source.id}</p>}
                  {preview && <p>Подтверждаемая загрузка: страница {preview.body.pageId} · файл {preview.body.sourceId} · SHA256 {preview.receipt.sha256}</p>}
                </div>
              </details>
            </div>
          )}
        </section>
      )}
      {!unbound && (
        <section className="card" aria-labelledby="media-uploads-title">
          <div className="card-header">
            <h2 id="media-uploads-title" className="card-title">Загрузки</h2>
          </div>
          {saved.data && !saved.isError && !saved.data.uploads.length && (
            <div className="empty">
              <p className="empty-title">Загрузок для этой страницы пока нет</p>
            </div>
          )}
          {saved.data && saved.data.uploads.length > 0 && <ul className="divide-y divide-border-light">
            {saved.data.uploads.map((job) => {
              const status = job.reason === "indeterminate" ? "indeterminate" : job.uploadStatus ?? job.state;
              const filename = saved.data?.sources.find((row) => row.id === job.sourceId)?.filename;
              const canResume = owner && job.state === "blocked" && ["background_paused", "job_unavailable", "collection_off", "on_demand_only"].includes(job.reason ?? "");
              const readiness = collectionPreview?.selection.length === 1 && collectionPreview.selection[0] === `vault_item:${job.mediaRef}`;
              return (
                <li key={job.id} className="space-y-2 px-5 py-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text-primary">{filename ?? destinationLabels[job.destination]}</span>
                        <span className={status === "indeterminate" ? "badge badge-warning" : uploadStatusBadges[status] ?? "badge"} title={status}>
                          {status === "indeterminate" ? "Результат неизвестен — нужна проверка" : uploadStatusLabels[status] ?? status}
                        </span>
                      </div>
                      <p className="text-xs text-text-muted">{filename ? `${destinationLabels[job.destination]} · ` : ""}{formatDateTime(job.createdAt)}</p>
                    </div>
                    {(canResume || (owner && job.state === "complete")) && (
                      <div className="flex flex-wrap gap-2">
                        {canResume && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={busy || !pages.data || pages.data.backgroundPaused}
                            onClick={() =>
                              void run(async () => {
                                await ofapiMediaActions.resume(job.id, {
                                  expectedRowVersion: job.rowVersion,
                                  expectedPolicyRevision: pages.data!.revision,
                                  reason:
                                    "Resume reviewed upload with original allowance",
                                });
                                setNotice("Загрузка продолжена с тем же файлом и лимитом.");
                              })
                            }
                          >
                            Продолжить загрузку
                          </button>
                        )}
                        {owner && job.state === "complete" && (
                          <>
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={busy}
                              onClick={() =>
                                void copyMaterial({
                                  pageId,
                                  jobId: job.id,
                                  expectedRowVersion: job.rowVersion,
                                  reason: "Owner reviewed upload handoff",
                                })
                              }
                            >
                              Скопировать ID
                            </button>
                            {job.destination === "vault" && job.mediaRef && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={busy || !pages.data}
                                onClick={() =>
                                  setCollectionPreview({
                                    selection: [`vault_item:${job.mediaRef}`],
                                    revision: pages.data!.revision,
                                    pageId,
                                    pageLabel,
                                  })
                                }
                              >
                                Проверить готовность
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-text-secondary">
                    Обработка: {ready(job.isReady)} · Списано OnlyFans API:{" "}
                    {job.actualCredits === null ? "ещё неизвестно" : credits(job.actualCredits)}
                    {" "}· Учтено: {credits(job.spentCredits)}
                  </p>
                  {job.reason && job.reason !== "upload_processing" && job.reason !== "indeterminate" && (
                    <p className="text-xs text-text-muted" title={job.reason}>
                      {reasonLabels[job.reason] ?? job.reason.replaceAll("_", " ")}
                    </p>
                  )}
                  {readiness && collectionConfirm}
                </li>
              );
            })}
          </ul>}
        </section>
      )}
      {handoff && (
        <section className="card" aria-label="ID для ChatGoose">
          <div className="card-body space-y-3">
            <p className="text-sm text-text-secondary" title={handoff.note}>
              {handoff.materialKind === "vault"
                ? "Файл медиатеки: этот ID можно использовать повторно — файл заново не загружается."
                : "Вложение для одного сообщения: используйте ID один раз. Готовность превью может остаться неизвестной; если отправка закончится неизвестным результатом, ID останется заблокированным."}
            </p>
            <label className="block">
              <span className="field-label">ID для ChatGoose</span>
              <input
                disabled={busy}
                className="input font-mono"
                readOnly
                value={handoff.materialId}
              />
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setHandoff(null)}>
              Скрыть ID
            </button>
          </div>
        </section>
      )}
      {!unbound && (
        <section className="card" aria-labelledby="media-catalog-title">
          <div className="card-header">
            <div className="min-w-0">
              <h2 id="media-catalog-title" className="card-title">Медиатека</h2>
              <p className="card-description">
                {saved.data
                  ? `${inventoryLabels[saved.data.inventory.state] ?? "Полнота неизвестна"}${saved.data.inventory.completedAt ? ` · ${formatDateTime(saved.data.inventory.completedAt)}` : ""}`
                  : saved.isError ? "Недоступна" : pageId ? "Загружаем…" : "Выберите страницу"}
              </p>
            </div>
            {owner && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !pageId || !pages.data}
                onClick={() =>
                  setCollectionPreview({
                    selection: [
                      "vault_inventory",
                      "vault_lists",
                      "release_forms",
                      "taggable_users",
                    ],
                    revision: pages.data!.revision,
                    pageId,
                    pageLabel,
                  })
                }
              >
                Обновить каталог
              </button>
            )}
          </div>
          {collectionPreview && collectionPreview.selection.length > 1 && <div className="px-5 pt-4">{collectionConfirm}</div>}
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Файл</th>
                  <th>Готовность</th>
                  <th>Размер</th>
                  <th>Согласия</th>
                  <th><span className="sr-only">Действие</span></th>
                </tr>
              </thead>
              <tbody>
                {saved.data && !saved.isError && saved.data.media.length === 0 && <tr><td colSpan={5} className="muted">{offset > 0 ? "На этой позиции файлов нет. Вернитесь на предыдущую страницу." : "В сохранённом каталоге нет файлов. Это не значит, что медиатека в OnlyFans пуста."}</td></tr>}
                {saved.data?.media.map((media) => (
                  <tr key={`${media.materialKind}:${media.mediaRef}`}>
                    <td title={`ID ${media.mediaRef}`}>
                      <span className="block text-text-primary">
                        {media.filename ?? (media.materialKind === "cdn" ? "Вложение для сообщения" : `Файл ${media.mediaRef}`)}
                      </span>
                      <span className="block text-xs text-text-muted">
                        {media.materialKind === "cdn" ? "Для одного сообщения" : "Медиатека"}
                        {media.providerType ? ` · ${providerTypeLabels[media.providerType] ?? media.providerType}` : ""}
                      </span>
                    </td>
                    <td>
                      {media.hasError
                        ? <span className="badge badge-danger">Ошибка у OnlyFans</span>
                        : <span className={readyBadge(media.isReady)}>{ready(media.isReady)}</span>}
                    </td>
                    <td className="muted">
                      {media.width !== null && media.height !== null ? `${media.width}×${media.height} · ` : ""}
                      {media.bytes === null ? "размер неизвестен" : formatSize(media.bytes)}
                    </td>
                    <td className="muted">
                      {media.releaseForms.length
                        ? media.releaseForms
                            .map(
                              (form) =>
                                `${form.name ?? form.id}${form.status ? ` (${releaseFormStatusLabels[form.status] ?? form.status})` : ""}`,
                            )
                            .join(", ")
                        : "Нет"}
                    </td>
                    <td className="text-right">
                      {owner && media.materialKind === "vault" && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={
                            busy ||
                            media.isReady !== true ||
                            media.hasError === true ||
                            media.canView === false
                          }
                          onClick={() =>
                            void copyMaterial({
                              pageId,
                              mediaRef: media.mediaRef,
                              expectedObservationId: media.observationId,
                              reason: "Owner reviewed vault material handoff",
                            })
                          }
                        >
                          Скопировать ID
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-footer flex-wrap">
            <span>
              {saved.data ? saved.data.totalMedia === 0 ? "0 файлов" : offset >= saved.data.totalMedia ? `На этой позиции файлов нет · всего ${saved.data.totalMedia}` : `${offset + 1}–${Math.min(offset + 50, saved.data.totalMedia)} из ${saved.data.totalMedia}` : "Количество неизвестно"}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Назад
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || offset + 50 >= (saved.data?.totalMedia ?? 0)}
                onClick={() => setOffset(offset + 50)}
              >
                Далее
              </button>
            </div>
          </div>
          {saved.data?.inventory.note && (
            <div className="border-t border-border-light px-5 py-3">
              <details className="help">
                <summary>Технические детали</summary>
                <div className="help-body text-xs">
                  <p>{saved.data.inventory.note}</p>
                </div>
              </details>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
