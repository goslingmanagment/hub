import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useOfapiExportPages } from "@/api/ofapiExports";
import { ofapiMediaActions, useOfapiMedia } from "@/api/ofapiMedia";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { ofapiPageHref, resolveOfapiPage } from "@/lib/ofapiNavigation";
import { useSessionWorkspace } from "@/lib/useSessionWorkspace";
import { acknowledgeSeparateMediaUpload, findMediaUpload, mediaUploadFailure, mediaUploadUnresolved, mergeMediaUploadOutcome, readMediaUploadCustody, settleMediaUpload, startMediaUpload, type MediaUploadRecord } from "@/lib/ofapiMediaCustody";
import { useCollectionJobCustody } from "./settings/collection/collectionJobCustody.js";
const field =
  "min-w-0 max-w-full rounded border border-border bg-card px-3 py-2 text-sm text-text-primary";
const button =
  "rounded border border-border px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-40";
const ready = (value: boolean | null) =>
  value === true ? "Готово" : value === false ? "Обрабатывается" : "Неизвестно";
function useMediaState<T>(ownerId: number, name: string, initial: T | (() => T)) {
  return useSessionWorkspace<T>(`ofapi-media:${ownerId}:${name}`, () => typeof initial === "function" ? (initial as () => T)() : initial);
}
export function OfapiMediaPage() {
  const auth = useAuthMe();
  const pages = useOfapiExportPages();
  const [search, setSearch] = useSearchParams();
  const requestedPage = search.get("page");
  const selected = resolveOfapiPage(pages.data?.pages, requestedPage);
  function selectPage(label: string, replace = false) {
    const next = new URLSearchParams(search);
    next.set("page", label);
    setSearch(next, { replace });
  }
  useEffect(() => {
    if (requestedPage === null && selected) selectPage(selected.label, true);
  }, [requestedPage, selected?.label]);
  if (!auth.data?.user.id) return <StatusPanel title="Проверяем сессию…" />;
  return <OfapiMediaContent key={auth.data.user.id} ownerId={auth.data.user.id} owner={auth.data.user.role === "owner"} pages={pages} pageId={selected?.id ?? 0} requestedPage={requestedPage} selectPage={selectPage} />;
}

function OfapiMediaContent({ pages, pageId, requestedPage, selectPage, ownerId, owner }: {
  pages: ReturnType<typeof useOfapiExportPages>;
  pageId: number;
  requestedPage: string | null;
  selectPage: (label: string) => void;
  ownerId: number;
  owner: boolean;
}) {
  const queryClient = useQueryClient();
  const [offsets, setOffsets] = useMediaState<Record<number, number>>(ownerId, "offsets", {});
  const offset = offsets[pageId] ?? 0;
  const setOffset = (value: number) => setOffsets(current => ({ ...current, [pageId]: value }));
  const saved = useOfapiMedia(pageId, offset);
  const [files, setFiles] = useMediaState<Record<number, File | null>>(ownerId, "files", {});
  const file = files[pageId] ?? null;
  const setFile = (value: File | null) => setFiles(current => ({ ...current, [pageId]: value }));
  const [sourceIds, setSourceIds] = useMediaState<Record<number, string>>(ownerId, "sources", {});
  const sourceId = sourceIds[pageId] ?? "";
  const setSourceId = (value: string) => setSourceIds(current => ({ ...current, [pageId]: value }));
  const [uploadDrafts, setUploadDrafts] = useMediaState<Record<number, { destination: "vault" | "cdn"; maxCredits: number }>>(ownerId, "drafts", {});
  const uploadDraft: { destination: "vault" | "cdn"; maxCredits: number } = uploadDrafts[pageId] ?? { destination: "vault", maxCredits: 3 };
  const { destination, maxCredits } = uploadDraft;
  const setDestination = (value: "vault" | "cdn") => setUploadDrafts(current => ({ ...current, [pageId]: { ...(current[pageId] ?? uploadDraft), destination: value } }));
  const setMaxCredits = (value: number) => setUploadDrafts(current => ({ ...current, [pageId]: { ...(current[pageId] ?? uploadDraft), maxCredits: value } }));
  const [busy, setBusy, readBusy] = useMediaState(ownerId, "busy", false),
    [error, setError] = useMediaState(ownerId, "error", ""),
    [notice, setNotice] = useMediaState(ownerId, "notice", "");
  const [previews, setPreviews] = useMediaState<Record<number, {
    body: Parameters<typeof ofapiMediaActions.upload>[0];
    pageLabel: string;
    sourceFilename: string;
    receipt: Awaited<ReturnType<typeof ofapiMediaActions.upload>>;
  } | null>>(ownerId, "previews", {});
  const preview = previews[pageId] ?? null;
  const setPreview = (value: (typeof previews)[number]) => setPreviews(current => ({ ...current, [pageId]: value }));
  const [collectionPreviews, setCollectionPreviews] = useMediaState<Record<number, {
    selection: string[];
    revision: number;
    pageId: number;
    pageLabel: string;
  } | null>>(ownerId, "collection-previews", {});
  const collectionPreview = collectionPreviews[pageId] ?? null;
  const setCollectionPreview = (value: (typeof collectionPreviews)[number]) => setCollectionPreviews(current => ({ ...current, [pageId]: value }));
  const [handoffs, setHandoffs] = useMediaState<Record<number, Awaited<ReturnType<typeof ofapiMediaActions.handoff>> | null>>(ownerId, "handoffs", {});
  const handoff = handoffs[pageId] ?? null;
  const setHandoff = (value: (typeof handoffs)[number]) => setHandoffs(current => ({ ...current, [pageId]: value }));
  const [operationPage, setOperationPage] = useMediaState(ownerId, "operation-page", "");
  const [uploadCustody, setUploadCustody, readUploadCustody] = useMediaState(ownerId, "upload-custody", () => readMediaUploadCustody(ownerId));
  const collectionCustody = useCollectionJobCustody(ownerId);
  const [separateUploadAcknowledged, setSeparateUploadAcknowledged] = useState(false);
  const uploadBlocked = Boolean(uploadCustody.error) || mediaUploadUnresolved(uploadCustody.current);
  useEffect(() => { setSeparateUploadAcknowledged(false); }, [uploadCustody.current?.body.requestId]);
  async function run(action: () => Promise<void>, targetPageId = pageId) {
    if (readBusy()) return;
    setOperationPage(pages.data?.pages.find(page => page.id === targetPageId)?.label ?? String(targetPageId));
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["ofapi", "media", targetPageId] });
      await pages.refetch();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
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
        throw new Error("Выберите файл размером до 100 МБ (100 000 000 байт).");
      const bytes = await file.arrayBuffer(),
        hash = await crypto.subtle.digest("SHA-256", bytes),
        expectedSha256 = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
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
      setNotice(
        "Исходник сохранён, контрольная сумма проверена. Теперь выберите назначение и проверьте загрузку.",
      );
      setPreview(null);
    });
  }
  async function previewUpload() {
    if (readUploadCustody().error || mediaUploadUnresolved(readUploadCustody().current)) return;
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
        `Page ${body.pageId}`;
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
  async function submitUpload(recover: boolean) {
    if (!owner) return;
    const current = readUploadCustody();
    if (current.error || (!recover && mediaUploadUnresolved(current.current))) return;
    const original = recover ? current.current : preview ? {
      body: { ...preview.body, dryRun: false }, pageLabel: preview.pageLabel, sourceFilename: preview.sourceFilename,
      startedAt: new Date().toISOString(), phase: "sending" as const, receipt: null, error: "",
    } : null;
    if (!original || (recover && !mediaUploadUnresolved(original))) return;
    await run(async () => {
      const sending: MediaUploadRecord = { ...original, phase: "sending", error: "" };
      setOperationPage(original.pageLabel);
      let retained: MediaUploadRecord | undefined;
      try {
        const admitted = startMediaUpload(ownerId, sending);
        setUploadCustody(admitted);
        retained = findMediaUpload(admitted, sending.body.requestId);
      }
      catch (error) { setUploadCustody(value => ({ ...value, error: "Не удалось сохранить точный запрос в этой вкладке. Отправка не началась; восстановите запись перед повтором." })); throw error; }
      let outcome: MediaUploadRecord;
      if (retained?.phase === "confirmed") outcome = retained;
      else {
        try {
          const receipt = await ofapiMediaActions.upload(sending.body);
          if (receipt.dryRun || !receipt.jobId || receipt.sourceId !== sending.body.sourceId || receipt.destination !== sending.body.destination || receipt.maxCredits !== sending.body.maxCredits) throw new Error("Сервер не подтвердил исходную загрузку.");
          outcome = { ...sending, phase: "confirmed", receipt };
        } catch (error) { outcome = { ...sending, ...mediaUploadFailure(error, recover) }; }
      }
      try {
        const settled = settleMediaUpload(ownerId, outcome);
        setUploadCustody(settled);
        outcome = findMediaUpload(settled, sending.body.requestId) ?? outcome;
      } catch {
        const local = mergeMediaUploadOutcome(readUploadCustody(), outcome);
        setUploadCustody({ ...local, error: "Исход получен, но не сохранился в этой вкладке. Сохраните номер задачи перед уходом." });
        outcome = findMediaUpload(local, sending.body.requestId) ?? outcome;
      }
      if (outcome.phase === "confirmed") {
        setPreviews(current => ({ ...current, [sending.body.pageId]: null }));
        setNotice(`Загрузка поставлена в очередь: ${outcome.receipt!.jobId}. Следите за её обработкой в истории исходного аккаунта.`);
      } else setError(outcome.error);
    }, original.body.pageId);
  }
  async function copyMaterial(
    input: Parameters<typeof ofapiMediaActions.handoff>[0],
  ) {
    await run(async () => {
      const result = await ofapiMediaActions.handoff(input);
      setHandoff(result);
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(result.materialId);
          setNotice("Проверенный ID скопирован. Выберите этот материал в ChatGoose перед отправкой.");
        } catch {
          setNotice("Материал проверен. Скопируйте ID из поля ниже: браузер не разрешил запись в буфер обмена.");
        }
      } else {
        setNotice("Материал проверен. Скопируйте ID из поля ниже.");
      }
    });
  }
  const source = saved.data?.sources.find((value) => value.id === sourceId);
  return (
    <div className="max-w-7xl space-y-6 p-4 md:p-0">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">
            Медиа OnlyFans
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Исходники, состояние загрузок и сохранённые сведения Vault.
          </p>
        </div>
        <Link className="text-accent text-sm" to={ofapiPageHref("/settings?tab=collection", requestedPage)}>
          Управление сбором
        </Link>
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="grid gap-1 text-sm text-text-muted">
          Страница
          <select
            disabled={busy || !pages.data?.pages.length}
            className={field}
            value={pages.data?.pages.find(page => page.id === pageId)?.label ?? ""}
            onChange={(event) => {
              selectPage(event.target.value);
            }}
          >
            {!pageId && <option value="">Выберите доступную страницу</option>}
            {pages.data?.pages.map((page) => (
              <option key={page.id} value={page.label}>
                {page.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className={button}
          disabled={busy || !pageId}
          onClick={() =>
            void Promise.all([saved.refetch(), pages.refetch()])
          }
        >
          Обновить экран
        </button>
      </div>
      <QueryNotice error={pages.isError} stale={pages.data !== undefined} retry={() => pages.refetch()} />
      {pages.isLoading && !pages.data && <StatusPanel title="Загружаем список страниц…" />}
      {pages.data && !pageId && <StatusPanel title={requestedPage !== null ? "Страница из ссылки недоступна" : "Нет доступных OnlyFans-страниц"} description="Для работы выберите доступный аккаунт в списке выше." />}
      {(uploadCustody.current || uploadCustody.error || uploadCustody.history.length > 0) && <section className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm" aria-label="Сохранённый исход загрузки">
        {uploadCustody.current && <>
          <h2 className="font-semibold text-text-primary">{uploadCustody.current.phase === "confirmed" ? "Загрузка поставлена в очередь" : uploadCustody.current.phase === "sending" ? "Отправляем исходную загрузку…" : "Проверьте исход загрузки"}</h2>
          <p className="break-words text-text-secondary">{uploadCustody.current.pageLabel} · {uploadCustody.current.sourceFilename} · {uploadCustody.current.body.destination === "vault" ? "Vault" : "Одноразовое вложение"} · до {uploadCustody.current.body.maxCredits} кр.</p>
          {uploadCustody.current.receipt?.jobId && <p className="break-all">Номер задачи: {uploadCustody.current.receipt.jobId}. Это подтверждение очереди, а не завершения загрузки.</p>}
          {uploadCustody.current.error && <p role="status" className="text-warning-dark">{uploadCustody.current.error}</p>}
          <details><summary className="cursor-pointer text-text-secondary">Исходные параметры</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify({ startedAt: uploadCustody.current.startedAt, ...uploadCustody.current.body }, null, 2)}</pre></details>
          <Link className="inline-block text-accent underline" to={ofapiPageHref("/ofapi-media", uploadCustody.current.pageLabel)}>Открыть историю исходного аккаунта</Link>
          {owner && uploadCustody.current.phase === "uncertain" && <>
            <p className="text-text-secondary">Восстановление отправит исходные параметры с тем же ID. Сервер вернёт эту же задачу, если она уже создана; иначе поставит в очередь одну исходную загрузку. После изменения политики восстановление может быть отклонено — это не доказывает отсутствие первой задачи.</p>
            <button type="button" className={button} disabled={busy || Boolean(uploadCustody.error)} onClick={() => void submitUpload(true)}>Восстановить исходную загрузку с тем же ID</button>
            <div className="space-y-2 border-t border-border pt-3"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={busy} checked={separateUploadAcknowledged} onChange={event => setSeparateUploadAcknowledged(event.target.checked)} />Я проверил историю и понимаю, что первая загрузка могла выполниться. Хочу разрешить отдельную новую загрузку с отдельным расходом.</label><button type="button" className={button} disabled={busy || !separateUploadAcknowledged || Boolean(uploadCustody.error)} onClick={() => {
              const original = readUploadCustody().current;
              if (!original || readBusy()) return;
              try { setUploadCustody(acknowledgeSeparateMediaUpload(ownerId, original.body.requestId, separateUploadAcknowledged)); setPreviews(current => ({ ...current, [original.body.pageId]: null })); setSeparateUploadAcknowledged(false); }
              catch (error) { setError(error instanceof Error ? error.message : "Не удалось сохранить решение"); }
            }}>Разрешить отдельную новую загрузку</button></div>
          </>}
        </>}
        {uploadCustody.error && <p role="alert" className="text-warning-dark">{uploadCustody.error} <button type="button" className="text-accent underline" disabled={busy} onClick={() => setUploadCustody(readMediaUploadCustody(ownerId))}>Повторить чтение записи</button></p>}
        {uploadCustody.history.length > 0 && <details><summary className="cursor-pointer text-text-secondary">Предыдущие запуски: {uploadCustody.history.length}</summary><div className="mt-2 space-y-2">{uploadCustody.history.map(item => <div key={item.body.requestId} className="rounded-lg border border-border p-3"><p className="break-words">{item.pageLabel} · {item.sourceFilename} · {item.receipt?.jobId ? `Задача ${item.receipt.jobId}` : item.phase === "refused" ? "Сервер отказал" : "Исход не подтверждён"}</p><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify({ startedAt: item.startedAt, ...item.body }, null, 2)}</pre></div>)}</div></details>}
      </section>}
      {(collectionCustody.launch || collectionCustody.storageError) && <section role="status" className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
        <p>Сбор метаданных: {collectionCustody.launch?.pageLabel ?? "сохранённый запуск"}{collectionCustody.launch?.jobId ? ` · задача ${collectionCustody.launch.jobId}` : ""}.</p>
        <p className="text-text-secondary">{collectionCustody.storageError || collectionCustody.launch?.error || (collectionCustody.pending ? "Ожидаем подтверждение постановки в очередь." : "Результат и исходные параметры сохранены в управлении сбором.")}</p>
        <Link className="inline-block text-accent underline" to={ofapiPageHref("/settings?tab=collection", collectionCustody.launch?.pageLabel ?? requestedPage)}>Проверить задачу и восстановить запуск</Link>
      </section>}
      {error && (
        <p
          role="alert"
          className="rounded border border-red-500/40 p-3 text-red-400 text-sm"
        >
          {operationPage && <strong>{operationPage}: </strong>}{error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded bg-hover p-3 text-sm text-text-primary"
        >
          {operationPage && <strong>{operationPage}: </strong>}{notice}
          {operationPage && operationPage !== requestedPage && <Link className="ml-2 text-accent underline" to={ofapiPageHref("/ofapi-media", operationPage)}>Открыть аккаунт</Link>}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-text-muted">
          {operationPage}: обрабатываем подтверждённое действие…
        </p>
      )}
      {owner && pageId > 0 && (
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold text-text-primary">
            Загрузка медиа
          </h2>
          <ol className="grid gap-2 text-sm text-text-secondary sm:grid-cols-3">
            <li className="rounded-lg bg-hover p-3"><strong>1. Сохранить исходник</strong><br />Hub проверит файл и контрольную сумму.</li>
            <li className="rounded-lg bg-hover p-3"><strong>2. Проверить загрузку</strong><br />Выберите назначение и лимит кредитов.</li>
            <li className="rounded-lg bg-hover p-3"><strong>3. Подтвердить один раз</strong><br />Следите за обработкой в истории ниже.</li>
          </ol>
          <p className="text-sm text-text-muted">
            Файлы до 100 МБ. Сохранённый исходник можно повторно выбрать для отдельной
            подтверждённой загрузки. Сервер проверяет тип, размер и контрольную сумму.
            Цена загрузки — 3 кредита за МБ (1 000 000 байт), минимум 1 кредит.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm text-text-muted">
              Фото, видео или аудио
              <input
                disabled={busy}
                className={field}
                key={pageId}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  reset();
                }}
              />
            </label>
            <button
              className={button}
              disabled={busy || !file || !pageId}
              onClick={() => void saveSource()}
            >
              1. Сохранить исходник
            </button>
            {file && (
              <span className="text-text-muted text-sm">
                {file.name} · {(file.size / 1000000).toFixed(2)} MB
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm text-text-muted">
              Сохранённый исходник
              <select
                disabled={busy}
                className={field}
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
                <option value="">Выберите исходник</option>
                {saved.data?.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.filename} · {(source.bytes / 1000000).toFixed(2)} MB
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm text-text-muted">
              Назначение
              <select
                disabled={busy}
                className={field}
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value as "vault" | "cdn");
                  reset();
                }}
              >
                <option value="vault">В Vault для повторного использования</option>
                <option value="cdn">Одноразовое вложение в сообщение</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm text-text-muted">
              Лимит кредитов
              <input
                disabled={busy}
                className={field}
                type="number"
                min={1}
                max={300}
                value={maxCredits}
                onChange={(event) => {
                  setMaxCredits(Number(event.target.value));
                  reset();
                }}
              />
            </label>
            <button
              className={button}
              disabled={busy || uploadBlocked || !source || !pages.data}
              onClick={() => void previewUpload()}
            >
              2. Проверить загрузку
            </button>
          </div>
          {source && <details className="text-xs text-text-muted"><summary className="cursor-pointer">Сведения о проверенном исходнике</summary><p className="mt-2 break-all">{source.mimeType} · SHA256 {source.sha256}</p></details>}
          {preview && (
            <div className="rounded border border-border p-3 text-sm text-text-secondary">
              <p className="font-medium">
                {preview.pageLabel} (страница {preview.body.pageId}) ·{" "}
                {preview.sourceFilename}
              </p>
              <p className="break-all text-xs text-text-muted">
                Исходник {preview.body.sourceId} · SHA256 {preview.receipt.sha256}
              </p>
              <p>
                {preview.receipt.destination === "vault"
                  ? "Vault для повторного использования"
                  : "Одноразовый CDN"}{" "}
                · {(preview.receipt.bytes / 1000000).toFixed(2)} МБ ·
                оценка {preview.receipt.estimatedCredits} кр. · лимит
                {preview.receipt.maxCredits} кр. Проверка статуса ограничена 99 запросами.
              </p>
              <button
                className={`${button} mt-3`}
                disabled={busy || uploadBlocked}
                onClick={() => void submitUpload(false)}
              >
                3. Подтвердить одну загрузку
              </button>
            </div>
          )}
        </section>
      )}
      {pageId > 0 && <section className="space-y-3">
        <h2 className="font-semibold text-text-primary">История загрузок</h2>
        <QueryNotice error={saved.isError} stale={saved.data !== undefined} retry={() => saved.refetch()} />
        {saved.isLoading && !saved.data && <StatusPanel title="Загружаем историю и каталог…" />}
        {saved.data && !saved.data.uploads.length && !saved.isError && (
          <p className="text-sm text-text-muted">
            Для этой страницы ещё нет заданий загрузки.
          </p>
        )}
        {saved.data?.uploads.map((job) => (
          <div
            key={job.id}
            className="rounded-xl border border-border bg-card p-4 space-y-2 text-sm"
          >
            <div className="flex flex-wrap justify-between">
              <strong className="text-text-primary">
                {job.destination === "vault" ? "Vault" : "Одноразовое вложение"} ·{" "}
                {job.reason === "indeterminate"
                  ? "Результат неизвестен · нужна проверка"
                  : (job.uploadStatus ?? job.state)}
              </strong>
              <span className="text-text-muted">
                {new Date(job.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-text-secondary">
              Обработка: {ready(job.isReady)} · Расход у провайдера:{" "}
              {job.actualCredits === null
                ? "пока неизвестен"
                : `${job.actualCredits} credits`}{" "}
              · Учтённый лимит / расход: {job.spentCredits}
            </p>
            {job.reason && job.reason !== "upload_processing" && (
              <p className="text-text-muted">
                {job.reason.replaceAll("_", " ")}
              </p>
            )}
            {owner &&
              job.state === "blocked" &&
              [
                "background_paused",
                "job_unavailable",
                "collection_off",
                "on_demand_only",
              ].includes(job.reason ?? "") && (
                <button
                  className={button}
                  disabled={busy || !pages.data || pages.data.backgroundPaused}
                  onClick={() =>
                    void run(async () => {
                      await ofapiMediaActions.resume(job.id, {
                        expectedRowVersion: job.rowVersion,
                        expectedPolicyRevision: pages.data!.revision,
                        reason:
                          "Resume reviewed upload with original allowance",
                      });
                      setNotice(
                        "Загрузка продолжена с прежним исходником и лимитом.",
                      );
                    })
                  }
                >
                  Продолжить подтверждённую загрузку
                </button>
              )}
            {owner && job.state === "complete" && (
              <div className="flex gap-2 flex-wrap">
                <button
                  className={button}
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
                  Проверить и скопировать ID
                </button>
                {job.destination === "vault" && job.mediaRef && (
                  <button
                    className={button}
                    disabled={busy || collectionCustody.blocked || !pages.data}
                    onClick={() =>
                      setCollectionPreview({
                        selection: [`vault_item:${job.mediaRef}`],
                        revision: pages.data!.revision,
                        pageId,
                        pageLabel:
                          pages.data!.pages.find((page) => page.id === pageId)
                            ?.label ?? `Page ${pageId}`,
                      })
                    }
                  >
                    Проверить параметры обновления готовности
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </section>}
      {handoff && (
        <section className="rounded border border-border p-4 space-y-2">
          <p className="text-sm text-text-secondary">{handoff.note}</p>
          <input
            disabled={busy}
            aria-label="Verified media ID"
            className={`${field} w-full font-mono`}
            readOnly
            value={handoff.materialId}
          />
          <button className={button} onClick={() => setHandoff(null)}>
            Скрыть ID
          </button>
        </section>
      )}
      {pageId > 0 && <section className="space-y-3">
        <div className="flex flex-wrap justify-between gap-3">
          <h2 className="font-semibold text-text-primary">
            Сохранённый каталог Vault{saved.data ? ` · ${saved.data.inventory.state}` : ""}
          </h2>
          {owner && (
            <button
              className={button}
              disabled={busy || collectionCustody.blocked || !pageId || !pages.data}
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
                  pageLabel:
                    pages.data!.pages.find((page) => page.id === pageId)
                      ?.label ?? `Page ${pageId}`,
                })
              }
            >
              Проверить параметры сбора каталога
            </button>
          )}
        </div>
        <p className="text-sm text-text-muted">{saved.data?.inventory.note}</p>
        {collectionPreview && (
          <div className="rounded border border-border p-3 text-sm text-text-secondary">
            <p>
              {collectionPreview.pageLabel} (страница {collectionPreview.pageId}) ·
              Получить{" "}
              {collectionPreview.selection.length === 1
                ? "один выбранный материал"
                : "каталог Vault, списки, согласия и доступные отметки пользователей"}
              . Не более 10 запросов, 10 кредитов и 4 МиБ. Прерванный обход
              останется частичным. Получаем только сведения о материалах, без самих файлов.
            </p>
            <button
              className={`${button} mt-2`}
              disabled={busy || collectionCustody.blocked}
              onClick={() =>
                void run(async () => {
                  const accepted = await collectionCustody.submit({
                    pageId: collectionPreview.pageId,
                    category: "vault_catalog",
                    expectedRevision: collectionPreview.revision,
                    maxCredits: 10,
                    maxCalls: 10,
                    maxBytes: 4 * 1024 * 1024,
                    from: null,
                    to: null,
                    selection: collectionPreview.selection,
                  }, collectionPreview.pageLabel, frozen => ofapiMediaActions.collect(frozen));
                  if (!accepted) return;
                  setCollectionPreview(null);
                  setNotice(
                    "Сбор метаданных с лимитами поставлен в очередь. Для большого каталога может потребоваться отдельное задание в управлении сбором.",
                  );
                })
              }
            >
              Подтвердить сбор метаданных
            </button>
          </div>
        )}
        {saved.data && !saved.data.media.length && !saved.isError && <StatusPanel title={offset > 0 ? "На этой странице каталога нет материалов" : "В сохранённом каталоге нет материалов"} description="Полнота каталога определяется результатом сбора, а не отсутствием строк." action={offset > 0 ? <button type="button" className={button} onClick={() => setOffset(0)}>К началу каталога</button> : undefined} />}
        {!!saved.data?.media.length && <div className="overflow-x-auto rounded border border-border">
          <table className="min-w-full text-sm text-left">
            <thead className="text-text-muted">
              <tr>
                <th className="p-3">Материал</th>
                <th className="p-3">Готовность</th>
                <th className="p-3">Сведения</th>
                <th className="p-3">Согласия</th>
                <th className="p-3">Действие</th>
              </tr>
            </thead>
            <tbody>
              {saved.data?.media.map((media) => (
                <tr
                  key={`${media.materialKind}:${media.mediaRef}`}
                  className="border-t border-border text-text-secondary"
                >
                  <td className="p-3">
                    {media.materialKind === "cdn"
                      ? "Одноразовое вложение"
                      : media.mediaRef}
                    <p className="text-xs text-text-muted">
                      {media.filename ??
                        media.providerType ??
                        "Тип неизвестен"}
                    </p>
                  </td>
                  <td className="p-3">
                    {ready(media.isReady)}
                    {media.hasError && " · ошибка провайдера"}
                  </td>
                  <td className="p-3">
                    {media.width ?? "?"}×{media.height ?? "?"} ·{" "}
                    {media.bytes === null
                      ? "размер неизвестен"
                      : `${media.bytes} bytes`}
                  </td>
                  <td className="p-3">
                    {media.releaseForms.length
                      ? media.releaseForms
                          .map(
                            (form) =>
                              `${form.name ?? form.id}${form.status ? ` (${form.status})` : ""}`,
                          )
                          .join(", ")
                      : "Нет сохранённых сведений"}
                  </td>
                  <td className="p-3">
                    {owner && media.materialKind === "vault" && (
                      <button
                        className={button}
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
                        Проверить и скопировать ID
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
        {saved.data && saved.data.totalMedia > 0 && <div className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
          <button
            className={button}
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Назад
          </button>
          <span>
            {Math.min(offset + 1, saved.data.totalMedia)}–{Math.min(offset + 50, saved.data.totalMedia)} из{" "}
            {saved.data.totalMedia}
          </span>
          <button
            className={button}
            disabled={busy || offset + 50 >= (saved.data?.totalMedia ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            Далее
          </button>
        </div>}
      </section>}
    </div>
  );
}
