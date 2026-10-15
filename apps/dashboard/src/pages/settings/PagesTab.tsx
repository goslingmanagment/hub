import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import type { AssignedPage, ConnectionItem, ModelListItem } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import {
  useAdminConnections,
  useAdminDeleteModel,
  useAdminDeletePage,
  useAdminModels,
  useAdminPages,
  useAdminReorderModels,
  useAdminVerifyPage,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { ModalShell } from "@/components/shared/ModalShell";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { syncStateLabel, syncTone } from "@/components/shared/syncUxDisplay";
import { RowMenu } from "@/components/ui/RowMenu";
import { formatRelativeTime } from "@/lib/format";
import { buildPageRoute, buildPageSyncRoute } from "@/lib/navigation";
import { BrowserProfilesSection, browserDraftRoute } from "./BrowserProfilesSection.js";
import { CreateModelModal } from "./CreateModelModal.js";
import { CreatePageModal } from "./CreatePageModal.js";
import { CredentialsModal, type CredentialsModalConnection } from "./CredentialsModal.js";
import { EditModelModal } from "./EditModelModal.js";
import { EditPageModal } from "./EditPageModal.js";
import type { Platform } from "./PlatformCredentialsFields.js";

type Connection = ConnectionItem;

function formatPageMetric(metric: AssignedPage["subscriberCount"]) {
  return metric.available && typeof metric.value === "number"
    ? metric.value.toLocaleString("ru-RU")
    : "—";
}

const TONE_DOT = { ok: "status-dot-ok", warn: "status-dot-warn", error: "status-dot-error", muted: "" } as const;

/** What the owner needs to know about a page's access, in one cell. */
export function pageAccess(page: AssignedPage, connection: Connection | undefined): {
  label: string;
  tone: keyof typeof TONE_DOT;
  hint?: string | undefined;
} {
  if (!connection) return { label: "Нет данных", tone: "muted" };
  if (page.platform === "fansly" && !connection.proxyUrl) {
    return { label: "Нет прокси", tone: "error", hint: "Без прокси страница Fansly не читается." };
  }
  return {
    label: syncStateLabel(connection.syncUx, page.platform),
    tone: syncTone(connection.syncUx),
    hint: connection.syncUx.detail ?? undefined,
  };
}

/**
 * «Модели и страницы»: the agency's catalog. Models are groups, each with its
 * pages; a page's access state sits in its row with the action that fixes it.
 * This one screen replaces three tabs (pages, models and connections) that
 * listed the same rows with different buttons.
 */
export function PagesTab() {
  const pagesQuery = useAdminPages();
  const modelsQuery = useAdminModels();
  const connectionsQuery = useAdminConnections();
  const reorder = useAdminReorderModels();

  const [adding, setAdding] = useState<{ modelSlug?: string } | null>(null);
  const [create, setCreate] = useState<{ platform: Platform; modelSlug?: string } | null>(null);
  const [showCreateModel, setShowCreateModel] = useState(false);
  const [editModel, setEditModel] = useState<ModelListItem | null>(null);
  const [deleteModel, setDeleteModel] = useState<ModelListItem | null>(null);
  const [editPage, setEditPage] = useState<AssignedPage | null>(null);
  const [deletePage, setDeletePage] = useState<AssignedPage | null>(null);
  const [credsConnection, setCredsConnection] = useState<CredentialsModalConnection | null>(null);

  const { data: pages } = pagesQuery;
  const { data: models } = modelsQuery;
  const { data: connections } = connectionsQuery;

  if (pagesQuery.isLoading && !pages) {
    return <div role="status" className="py-12 text-center text-sm text-text-secondary">Загружаем страницы…</div>;
  }
  if (pagesQuery.isError && !pages) {
    return (
      <StatusPanel
        title="Не удалось загрузить страницы"
        description={pagesQuery.error instanceof Error ? pagesQuery.error.message : "Список страниц недоступен."}
        tone="error"
      />
    );
  }

  const items = pages ?? [];
  const modelList = models ?? [];
  const connectionList = connections ?? [];
  const modelsUnavailable = !models;
  const connectionsUnavailable = !connections;

  function openCredentials(page: AssignedPage) {
    if (connectionsUnavailable) {
      toast.error("Состояние подключений недоступно — попробуйте позже");
      return;
    }
    const conn = connectionList.find((c) => c.label === page.label);
    setCredsConnection({
      label: page.label,
      platform: page.platform,
      proxyUrl: conn?.proxyUrl ?? null,
      proxyHasAuth: conn?.proxyHasAuth ?? false,
    });
  }

  async function moveModel(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= modelList.length || reorder.isPending) return;
    const current = modelList[index]!;
    const neighbor = modelList[target]!;
    if (typeof current.sortOrder !== "number" || typeof neighbor.sortOrder !== "number") {
      toast.error("Порядок моделей недоступен. Обновите страницу.");
      return;
    }
    try {
      await reorder.mutateAsync([
        { slug: current.slug, sortOrder: neighbor.sortOrder },
        { slug: neighbor.slug, sortOrder: current.sortOrder },
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось изменить порядок");
    }
  }

  // Models in their order; pages of a model the catalog no longer lists still show.
  const groups: Array<{ model: ModelListItem | null; slug: string; name: string; pages: AssignedPage[] }> = modelList.map((model) => ({
    model,
    slug: model.slug,
    name: model.name,
    pages: items.filter((page) => page.modelSlug === model.slug),
  }));
  for (const page of items) {
    if (groups.some((group) => group.slug === page.modelSlug)) continue;
    groups.push({ model: null, slug: page.modelSlug, name: page.modelName, pages: items.filter((p) => p.modelSlug === page.modelSlug) });
  }

  return (
    <>
      <div className="space-y-5">
        {pagesQuery.isError && pages && <StaleDataNotice error={pagesQuery.error} />}
        {modelsQuery.isError && models && <StaleDataNotice title="Не удалось обновить модели — показаны прежние" error={modelsQuery.error} />}
        {connectionsQuery.isError && connections && <StaleDataNotice title="Не удалось обновить подключения — показаны прежние" error={connectionsQuery.error} />}
        {modelsQuery.isLoading && !models && (
          <div role="status" className="notice">Загружаем модели…</div>
        )}
        {modelsQuery.isError && !models && (
          <div className="notice notice-warning">
            {modelsQuery.error instanceof Error ? modelsQuery.error.message : "Список моделей недоступен"} — добавлять и изменять страницы пока нельзя.
          </div>
        )}
        {connectionsQuery.isError && !connections && (
          <div className="notice notice-warning">
            {connectionsQuery.error instanceof Error ? connectionsQuery.error.message : "Подключения недоступны"} — данные входа пока нельзя обновить.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn" onClick={() => setShowCreateModel(true)}>
            <Plus size={16} aria-hidden /> Новая модель
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={modelsUnavailable || modelList.length === 0}
            title={modelList.length === 0 && !modelsUnavailable ? "Сначала добавьте модель" : undefined}
            onClick={() => setAdding({})}
          >
            <Plus size={16} aria-hidden /> Добавить страницу
          </button>
        </div>

        {!modelsUnavailable && modelList.length === 0 && (
          <StatusPanel
            title="Моделей пока нет"
            description="Добавьте модель — потом подключите к ней страницы Fansly и OnlyFans."
            action={<button type="button" className="btn btn-primary" onClick={() => setShowCreateModel(true)}>Новая модель</button>}
          />
        )}

        {groups.map((group, index) => (
          <section key={group.slug} className="card" aria-label={`Модель ${group.name}`}>
            <div className="card-header">
              <div className="min-w-0">
                <h3 className="card-title">{group.name}</h3>
                <p className="card-description">
                  {group.pages.length === 0 ? "Страниц нет" : `${group.pages.length} ${pluralPages(group.pages.length)}`}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {group.model && (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={`Поднять модель ${group.name}`}
                      disabled={index === 0 || reorder.isPending}
                      onClick={() => void moveModel(index, -1)}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={`Опустить модель ${group.name}`}
                      disabled={index >= modelList.length - 1 || reorder.isPending}
                      onClick={() => void moveModel(index, 1)}
                    >
                      <ArrowDown size={16} />
                    </button>
                    <RowMenu
                      label={`Действия с моделью ${group.name}`}
                      items={[
                        { label: "Добавить страницу", onSelect: () => setAdding({ modelSlug: group.slug }) },
                        { label: "Переименовать", onSelect: () => setEditModel(group.model) },
                        {
                          label: "Удалить модель",
                          danger: true,
                          disabled: group.model.pageCount > 0,
                          title: group.model.pageCount > 0 ? "Сначала отключите страницы модели" : undefined,
                          onSelect: () => setDeleteModel(group.model),
                        },
                      ]}
                    />
                  </>
                )}
              </div>
            </div>
            {group.pages.length > 0 && (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Страница</th>
                      <th>Состояние</th>
                      <th className="num">Подписчики</th>
                      <th className="num">Фолловеры</th>
                      <th>Обновлено</th>
                      <th aria-label="Действия" />
                    </tr>
                  </thead>
                  <tbody>
                    {group.pages.map((page) => (
                      <PageRow
                        key={page.id}
                        page={page}
                        connection={connectionList.find((c) => c.label === page.label)}
                        onEdit={() => setEditPage(page)}
                        onDelete={() => setDeletePage(page)}
                        onCredentials={() => openCredentials(page)}
                        editDisabled={modelsUnavailable}
                        credentialsDisabled={connectionsUnavailable}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}

        {/* Project Browser PR 16: a new page through its own server browser. */}
        <BrowserProfilesSection />
      </div>

      {adding && (
        <AddPageChooser
          onClose={() => setAdding(null)}
          onChoose={(platform) => {
            setCreate({ platform, ...(adding.modelSlug ? { modelSlug: adding.modelSlug } : {}) });
            setAdding(null);
          }}
        />
      )}
      {create && (
        <CreatePageModal
          models={modelList}
          initialPlatform={create.platform}
          {...(create.modelSlug ? { initialModelSlug: create.modelSlug } : {})}
          onClose={() => setCreate(null)}
        />
      )}
      {showCreateModel && <CreateModelModal onClose={() => setShowCreateModel(false)} />}
      {editModel && <EditModelModal model={editModel} onClose={() => setEditModel(null)} />}
      {deleteModel && <DeleteModelConfirm model={deleteModel} onClose={() => setDeleteModel(null)} />}
      {editPage && !modelsUnavailable && modelList.length > 0 && (
        <EditPageModal page={editPage} models={modelList} onClose={() => setEditPage(null)} />
      )}
      {deletePage && <DeletePageConfirm page={deletePage} onClose={() => setDeletePage(null)} />}
      {credsConnection && <CredentialsModal connection={credsConnection} onClose={() => setCredsConnection(null)} />}
    </>
  );
}

function pluralPages(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "страница";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "страницы";
  return "страниц";
}

function PageRow({
  page,
  connection,
  onEdit,
  onDelete,
  onCredentials,
  editDisabled,
  credentialsDisabled,
}: {
  page: AssignedPage;
  connection: Connection | undefined;
  onEdit: () => void;
  onDelete: () => void;
  onCredentials: () => void;
  editDisabled: boolean;
  credentialsDisabled: boolean;
}) {
  const verifyPage = useAdminVerifyPage(page.label);
  const navigate = useNavigate();
  const access = pageAccess(page, connection);
  const needsLogin = Boolean(connection?.syncUx.requiresAction) || access.label === "Нет прокси";

  async function handleVerify() {
    try {
      const result = await verifyPage.mutateAsync();
      if (result.verified) {
        if (result.syncUnblocked === false) {
          toast.warning(`${page.label}: вход подтверждён, но сбор всё ещё остановлен. Подробности — в «Система → Сбор данных».`);
        } else {
          toast.success(`${page.label}: вход подтверждён — @${result.username ?? "неизвестно"}`);
        }
      } else {
        toast.error(`${page.label}: вход не подтверждён`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Проверка не удалась");
    }
  }

  const menu = [
    { label: "Изменить", onSelect: onEdit, disabled: editDisabled },
    ...(page.platform === "fansly"
      ? [{ label: verifyPage.isPending ? "Проверяем…" : "Проверить вход", onSelect: () => void handleVerify(), disabled: verifyPage.isPending }]
      : []),
    { label: "Сбор данных", onSelect: () => navigate(buildPageSyncRoute(page.platform, page.label)) },
    { label: "Отключить страницу", onSelect: onDelete, danger: true },
  ];

  return (
    <tr>
      <td>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={buildPageRoute(page.label)} className="font-medium text-text-primary hover:text-accent">{page.label}</Link>
          <PlatformBadge platform={page.platform} />
        </div>
        <div className="text-[12px] text-text-secondary">@{page.username ?? page.displayName ?? "неизвестно"}</div>
      </td>
      <td>
        <span className="inline-flex items-center gap-2" title={access.hint}>
          <span className={`status-dot ${TONE_DOT[access.tone]}`} aria-hidden="true" />
          <span className={access.tone === "error" ? "font-medium text-danger" : undefined}>{access.label}</span>
        </span>
        {page.platform === "onlyfans" && <div className="text-[12px] text-text-secondary">доступ через OFAPI</div>}
      </td>
      <td className="num">{formatPageMetric(page.subscriberCount)}</td>
      <td className="num">{page.platform === "fansly" ? formatPageMetric(page.followerCount) : "—"}</td>
      <td className="muted">{page.lastLightSyncAt ? formatRelativeTime(page.lastLightSyncAt) : "—"}</td>
      <td>
        <div className="flex items-center justify-end gap-1">
          {page.platform === "fansly" && (
            <button
              type="button"
              className={`btn btn-sm ${needsLogin ? "btn-primary" : ""}`}
              disabled={credentialsDisabled}
              onClick={onCredentials}
            >
              {needsLogin ? "Обновить вход" : "Данные входа"}
            </button>
          )}
          <RowMenu label={`Действия со страницей ${page.label}`} items={menu} />
        </div>
      </td>
    </tr>
  );
}

function AddPageChooser({ onClose, onChoose }: { onClose: () => void; onChoose: (platform: Platform) => void }) {
  const navigate = useNavigate();
  const options: Array<{ title: string; text: string; action: () => void; recommended?: boolean }> = [
    {
      title: "Fansly через серверный браузер",
      text: "Вставьте прокси — Hub сам войдёт в аккаунт в отдельном браузере. Надёжнее всего.",
      action: () => navigate(browserDraftRoute()),
      recommended: true,
    },
    {
      title: "Fansly по данным входа",
      text: "Вставьте заголовок Authorization из браузера, где вы уже вошли, и прокси страницы.",
      action: () => onChoose("fansly"),
    },
    {
      title: "OnlyFans",
      text: "Подключите аккаунт в OFAPI, затем укажите здесь его имя на OnlyFans.",
      action: () => onChoose("onlyfans"),
    },
  ];
  return (
    <ModalShell title="Добавить страницу" onClose={onClose}>
      <div className="grid gap-2">
        {options.map((option) => (
          <button
            key={option.title}
            type="button"
            onClick={option.action}
            className="rounded-xl border border-border p-4 text-left transition-colors hover:border-border-strong hover:bg-hover-alt"
          >
            <span className="flex items-center gap-2 font-semibold text-text-primary">
              {option.title}
              {option.recommended && <span className="badge badge-success">рекомендуется</span>}
            </span>
            <span className="mt-1 block text-sm text-text-secondary">{option.text}</span>
          </button>
        ))}
      </div>
    </ModalShell>
  );
}

function DeleteModelConfirm({ model, onClose }: { model: ModelListItem; onClose: () => void }) {
  const deleteModel = useAdminDeleteModel(model.slug);

  async function handleConfirm() {
    try {
      await deleteModel.mutateAsync();
      toast.success("Модель удалена");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось удалить модель");
    }
  }

  return (
    <ConfirmModal
      title={`Удалить модель «${model.name}»?`}
      message="Модель исчезнет из списка. Это действие нельзя отменить."
      confirmLabel="Удалить модель"
      isPending={deleteModel.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

function DeletePageConfirm({ page, onClose }: { page: AssignedPage; onClose: () => void }) {
  const deletePage = useAdminDeletePage(page.label);

  async function handleConfirm() {
    try {
      await deletePage.mutateAsync();
      toast.success("Страница отключена — история сохранена");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось отключить страницу");
    }
  }

  return (
    <ConfirmModal
      title={`Отключить страницу ${page.label}?`}
      message={`«${page.label}» пропадёт из активных страниц, сбор данных остановится. Собранная история и данные входа сохранятся. Включить страницу обратно из интерфейса пока нельзя.`}
      confirmLabel="Отключить"
      isPending={deletePage.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
