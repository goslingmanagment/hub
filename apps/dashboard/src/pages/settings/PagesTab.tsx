import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AssignedPage } from "@agency_hub_core/contracts";
import {
  useAdminPages,
  useAdminModels,
  useAdminConnections,
  useAdminDeletePage,
  useAdminVerifyPage,
} from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { SearchInput } from "@/components/shared/SearchInput";
import { formatRelativeTime } from "@/lib/format";
import { buildPageRoute, buildSettingsRoute } from "@/lib/navigation";
import { toast } from "sonner";
import { CreatePageModal } from "./CreatePageModal.js";
import { EditPageModal } from "./EditPageModal.js";
import { CredentialsModal, type CredentialsModalConnection } from "./CredentialsModal.js";

function formatPageMetric(metric: AssignedPage["subscriberCount"]) {
  return metric.available && typeof metric.value === "number"
    ? metric.value.toLocaleString()
    : "Нет данных";
}

export function PagesTab() {
  const {
    data: pages,
    isError: pagesError,
    error: pagesErrorValue,
    refetch: refetchPages,
  } = useAdminPages({ suppressGlobalError: true });
  const {
    data: models,
    isLoading: modelsLoading,
    isError: modelsError,
    error: modelsErrorValue,
    refetch: refetchModels,
  } = useAdminModels({ suppressGlobalError: true });
  const {
    data: connections,
    isLoading: connectionsLoading,
    isError: connectionsError,
    error: connectionsErrorValue,
    refetch: refetchConnections,
  } = useAdminConnections({ suppressGlobalError: true });

  const [showCreate, setShowCreate] = useState(false);
  const [editPage, setEditPage] = useState<AssignedPage | null>(null);
  const [deletePage, setDeletePage] = useState<AssignedPage | null>(null);
  const [credsConnection, setCredsConnection] = useState<CredentialsModalConnection | null>(null);
  const verificationFlights = useRef(new Set<number>());
  const [verifyingPages, setVerifyingPages] = useState<number[]>([]);

  function startVerification(pageId: number) {
    if (verificationFlights.current.has(pageId)) return false;
    verificationFlights.current.add(pageId);
    setVerifyingPages([...verificationFlights.current]);
    return true;
  }

  function finishVerification(pageId: number) {
    verificationFlights.current.delete(pageId);
    setVerifyingPages([...verificationFlights.current]);
  }

  const [search, setSearch] = useSearchParams();
  const query = search.get("pageQuery") ?? search.get("page") ?? "";
  const modelFilter = search.get("model") ?? "";
  function updateSearch(changes: Record<string, string | null>) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("page");
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value); else next.delete(key);
      }
      return next;
    });
  }

  const items = pages ?? [];
  const visibleItems = items.filter((page) => (!modelFilter || page.modelSlug === modelFilter) && `${page.label} ${page.username ?? ""} ${page.displayName ?? ""} ${page.modelName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const modelList = models ?? [];
  const connectionList = connections ?? [];
  const modelsDependencyLoading = modelsLoading && !models;
  const modelsDependencyError = modelsError && !models;
  const connectionsDependencyLoading = connectionsLoading && !connections;
  const connectionsDependencyError = connectionsError && !connections;
  const modelsUnavailable = !models;
  const connectionsUnavailable = !connections;
  const createDisabled = modelsUnavailable || modelList.length === 0;

  function openCredentials(page: AssignedPage) {
    if (connectionsUnavailable) {
      toast.error("Каталог подключений недоступен");
      return;
    }

    const conn = connectionList.find((c) => c.label === page.label);
    if (!conn) {
      toast.error("Подключение этой страницы не найдено. Обновите каталог подключений.");
      void refetchConnections();
      return;
    }
    setCredsConnection({
      label: page.label,
      platform: page.platform,
      proxyUrl: conn.proxyUrl,
      proxyHasAuth: conn.proxyHasAuth,
    });
  }

  return (
    <>
      <div className="min-w-0">
        {pagesError && pages && (
          <div className="mb-3"><StaleDataNotice title="Показан последний загруженный список страниц" error={pagesErrorValue} /><button type="button" className="mt-2 text-sm font-semibold text-accent" onClick={() => void refetchPages()}>Повторить загрузку страниц</button></div>
        )}
        {modelsError && models && (
          <div className="mb-3"><StaleDataNotice title="Модели не обновились" error={modelsErrorValue} /><button type="button" className="mt-2 text-sm font-semibold text-accent" onClick={() => void refetchModels()}>Повторить загрузку моделей</button></div>
        )}
        {connectionsError && connections && (
          <div className="mb-3"><StaleDataNotice title="Подключения не обновились" error={connectionsErrorValue} /><button type="button" className="mt-2 text-sm font-semibold text-accent" onClick={() => void refetchConnections()}>Повторить загрузку подключений</button></div>
        )}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-text-primary">Страницы</h2>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={createDisabled}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Добавить страницу
          </button>
        </div>

        {(modelsUnavailable || connectionsUnavailable) && (
          <div className="mb-3 rounded-lg border border-border bg-hover-alt px-3 py-2 text-sm text-text-muted">
            {modelsDependencyLoading && (
              <p>Загружаем модели. Создание и редактирование страниц станут доступны после загрузки.</p>
            )}
            {modelsDependencyError && <p role="alert">{modelsErrorValue instanceof Error ? modelsErrorValue.message : "Каталог моделей недоступен. Создание и редактирование страниц пока недоступны."} <button type="button" className="font-semibold text-accent" onClick={() => void refetchModels()}>Повторить загрузку моделей</button></p>}
            {connectionsDependencyLoading && (
              <p>Загружаем подключения. Данные доступа станут доступны после загрузки.</p>
            )}
            {connectionsDependencyError && <p role="alert">{connectionsErrorValue instanceof Error ? connectionsErrorValue.message : "Каталог подключений недоступен. Данные доступа пока недоступны."} <button type="button" className="font-semibold text-accent" onClick={() => void refetchConnections()}>Повторить загрузку подключений</button></p>}
          </div>
        )}

        {!modelsUnavailable && modelList.length === 0 && (
          <p className="mb-3 text-sm text-text-muted">Сначала <Link to="/settings?tab=models" className="text-accent hover:underline">добавьте модель</Link>, затем подключите её страницы.</p>
        )}

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <SearchInput value={query} onChange={(value) => updateSearch({ pageQuery: value })} placeholder="Найти страницу или аккаунт…" />
          <label className="w-full min-w-0 text-xs text-text-secondary sm:w-64">
            <span className="mb-1 block">Модель</span>
            <select value={modelFilter} onChange={(event) => updateSearch({ model: event.target.value })} className="min-h-10 w-full min-w-0 max-w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary">
              <option value="">Все модели</option>
              {modelFilter && !modelList.some((model) => model.slug === modelFilter) && <option value={modelFilter}>{modelFilter} · нет в каталоге</option>}
              {modelList.map((model) => <option key={model.slug} value={model.slug}>{model.name}</option>)}
            </select>
          </label>
          {(query || modelFilter) && <button type="button" className="py-2 text-sm font-medium text-accent" onClick={() => updateSearch({ pageQuery: null, model: null })}>Сбросить фильтры</button>}
          {pages && <span className="py-2 text-xs text-text-muted">{visibleItems.length} из {pages.length}</span>}
        </div>
        {verifyingPages.length > 0 && <p role="status" className="mb-3 text-xs text-text-muted">Проверяем доступ: {items.filter((page) => verifyingPages.includes(page.id)).map((page) => page.label).join(", ") || `${verifyingPages.length} стр.`}. Результат появится в уведомлении.</p>}
        <p className="mb-3 text-xs text-text-muted">Подписчики и фолловеры — отдельные показатели доступа и аудитории. Откройте страницу для дохода и подробной истории.</p>
        {!pages ? (
          <StatusPanel title={pagesError ? "Не удалось загрузить страницы" : "Страницы"} description={pagesError ? pagesErrorValue instanceof Error ? pagesErrorValue.message : "Каталог страниц недоступен." : "Загружаем список страниц…"} tone={pagesError ? "error" : "default"} action={pagesError ? <button type="button" className="font-semibold text-accent" onClick={() => void refetchPages()}>Повторить загрузку страниц</button> : undefined} />
        ) : visibleItems.length === 0 ? (
          <StatusPanel title={items.length === 0 ? "Страниц пока нет" : "Страницы не найдены"} description={items.length === 0 ? "Подключите страницу к одной из моделей." : "Попробуйте другой запрос или сбросьте фильтр модели."} />
        ) : (
          <section className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[920px] border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Страница", "Платформа", "Модель", "Аккаунт", "Подписчики", "Фолловеры", "Обновление", "Действия"].map((col) => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((page) => (
                  <PageRow
                    key={page.id}
                    page={page}
                    onEdit={() => setEditPage(page)}
                    onDelete={() => setDeletePage(page)}
                    onCredentials={() => openCredentials(page)}
                    editDisabled={modelsUnavailable || modelList.length === 0}
                    credentialsDisabled={connectionsUnavailable}
                    verifyPending={verifyingPages.includes(page.id)}
                    onVerifyStart={() => startVerification(page.id)}
                    onVerifyEnd={() => finishVerification(page.id)}
                  />
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {showCreate && (
        <CreatePageModal models={modelList} {...(modelList.some((model) => model.slug === modelFilter) ? { initialModelSlug: modelFilter } : {})} onClose={() => setShowCreate(false)} />
      )}
      {editPage && (
        <EditPageModal page={editPage} models={modelList} onClose={() => setEditPage(null)} />
      )}
      {deletePage && (
        <DeletePageConfirm page={deletePage} onClose={() => setDeletePage(null)} />
      )}
      {credsConnection && (
        <CredentialsModal connection={credsConnection} onClose={() => setCredsConnection(null)} />
      )}
    </>
  );
}

function PageRow({
  page,
  onEdit,
  onDelete,
  onCredentials,
  editDisabled,
  credentialsDisabled,
  verifyPending,
  onVerifyStart,
  onVerifyEnd,
}: {
  page: AssignedPage;
  onEdit: () => void;
  onDelete: () => void;
  onCredentials: () => void;
  editDisabled: boolean;
  credentialsDisabled: boolean;
  verifyPending: boolean;
  onVerifyStart: () => boolean;
  onVerifyEnd: () => void;
}) {
  const verifyPage = useAdminVerifyPage(page.label, page.id);

  async function handleVerify() {
    if (verifyPage.isPending || !onVerifyStart()) return;
    try {
      const result = await verifyPage.mutateAsync();
      if (result.verified) {
        if (result.syncUnblocked === false) {
          toast.warning(`${page.label}: доступ проверен, но синхронизация заблокирована. Откройте раздел «Синхронизация».`);
        } else {
          toast.success(`${page.label}: доступ проверен${result.username ? ` · @${result.username}` : ""}`);
        }
      } else {
        toast.error(`${page.label}: проверка не пройдена`);
      }
    } catch (error) {
      toast.error(`${page.label}: ${error instanceof Error ? error.message : "Не удалось проверить доступ"}`);
    } finally {
      onVerifyEnd();
    }
  }

  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3 text-sm font-medium text-text-primary"><Link className="inline-block hover:text-accent hover:underline" to={buildPageRoute(page.label)}>{page.label}</Link></td>
      <td className="px-4 py-3">
        <PlatformBadge platform={page.platform} />
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary"><Link className="inline-block text-accent hover:underline" to={`/settings?${new URLSearchParams({ tab: "models", modelQuery: page.modelSlug })}`}>{page.modelName}</Link></td>
      <td className="px-4 py-3 text-sm text-text-secondary">
        {page.username ? `@${page.username}` : page.displayName ?? "Имя не получено"}
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary">{formatPageMetric(page.subscriberCount)}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">{formatPageMetric(page.followerCount)}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">
        {page.lastLightSyncAt ? formatRelativeTime(page.lastLightSyncAt) : "\u2014"}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-label={`Изменить страницу ${page.label}`}
            onClick={onEdit}
            disabled={editDisabled}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
          >
            Изменить
          </button>
          {page.platform === "onlyfans" ? (
            <Link
              to={buildSettingsRoute("sync", page.label)}
              title="Доступом к OnlyFans управляет OFAPI. Откройте синхронизацию для проверки подключения."
              className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
            >
              Подключение
            </Link>
          ) : (
            <>
              <button
                type="button"
                disabled={verifyPending || verifyPage.isPending}
                aria-label={`Проверить доступ к ${page.label}`}
                onClick={handleVerify}
                className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
              >
                {verifyPending || verifyPage.isPending ? "Проверяем…" : "Проверить"}
              </button>
              <button
                type="button"
                disabled={credentialsDisabled}
                aria-label={`Данные доступа к ${page.label}`}
                onClick={onCredentials}
                className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
              >
                Данные доступа
              </button>
            </>
          )}
          <button
            type="button"
            aria-label={`Деактивировать страницу ${page.label}`}
            onClick={onDelete}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
          >
            Деактивировать
          </button>
        </div>
      </td>
    </tr>
  );
}

function DeletePageConfirm({
  page,
  onClose,
}: {
  page: AssignedPage;
  onClose: () => void;
}) {
  const deletePage = useAdminDeletePage(page.label);
  const inFlight = useRef(false);

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleConfirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await deletePage.mutateAsync();
      toast.success("Страница деактивирована. История сохранена");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось деактивировать страницу");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <ConfirmModal
      title={`Деактивировать страницу: ${page.label}`}
      message={`Страница «${page.label}» исчезнет из активных страниц, синхронизация остановится. Собранная история и сохранённые данные доступа останутся. Повторная активация в этом интерфейсе недоступна.`}
      confirmLabel="Деактивировать"
      isPending={deletePage.isPending}
      onConfirm={handleConfirm}
      onClose={requestClose}
    />
  );
}
