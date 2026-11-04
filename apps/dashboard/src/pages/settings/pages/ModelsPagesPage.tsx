import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { Plus } from "lucide-react";
import type { AssignedPage, ModelListItem } from "@agency_hub_core/contracts";
import {
  useAdminConnections,
  useAdminModels,
  useAdminPages,
  useAdminReorderModels,
  useAdminUsers,
  useSyncEnginePages,
  useSyncOverview,
} from "@/api/queries";
import { useOfapiStatusQuery } from "@/api/waiting";
import { staleDataText } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { buildPageSectionRoute } from "@/lib/navigation";
import { engineStatusState } from "../engine/engineDisplay.js";
import { CreateModelModal } from "../CreateModelModal.js";
import { CreatePageModal } from "../CreatePageModal.js";
import { EditModelModal } from "../EditModelModal.js";
import { EditPageModal } from "../EditPageModal.js";
import { toastError } from "../settingsFeedback.js";
import { AddPageWindow } from "./AddPageWindow.js";
import { ModelCard } from "./ModelCard.js";
import { DeleteModelConfirm, DeletePageConfirm } from "./PageConfirms.js";
import { pageCollection } from "./pageCollection.js";
import { modelGroups, workersByPage } from "./pagesView.js";
import { UnfinishedConnections } from "./UnfinishedConnections.js";

/** How long a page reached by its anchor keeps its soft background. */
const FLASH_MS = 2_000;

/** The page an anchor `#page-<label>` points at: scrolled to and lit for two seconds. */
function useAnchoredPage(ready: boolean): string | null {
  const { hash } = useLocation();
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!ready || !hash.startsWith("#page-")) return;
    const label = decodeURIComponent(hash.slice("#page-".length));
    const row = document.getElementById(`page-${label}`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    setLit(label);
    const timer = window.setTimeout(() => setLit(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [hash, ready]);
  return lit;
}

function CatalogSkeleton() {
  return (
    <div className="stack" aria-hidden="true">
      {[3, 2].map((rows, index) => (
        <div key={index} className="card">
          <div className="card-header"><div className="space-y-2"><Skeleton width={140} /><Skeleton width={80} /></div></div>
          <div className="card-body space-y-4">
            {Array.from({ length: rows }, (_, row) => (
              <div key={row} className="flex gap-6"><Skeleton width={120} /><Skeleton width={110} /><Skeleton width={160} /></div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * «Модели и страницы»: what the agency consists of. Models with their pages, each
 * page's collection in one word and who works on it, and the pages begun and not
 * finished. Owner only; no page filter, no period (design/screens/settings.md §1).
 */
export function ModelsPagesPage() {
  const pagesQuery = useAdminPages();
  const modelsQuery = useAdminModels();
  const connectionsQuery = useAdminConnections();
  const overviewQuery = useSyncOverview();
  const engineQuery = useSyncEnginePages();
  const usersQuery = useAdminUsers();
  const ofapiQuery = useOfapiStatusQuery("owner");
  const reorder = useAdminReorderModels();

  const [adding, setAdding] = useState<{ modelSlug?: string } | null>(null);
  const [create, setCreate] = useState<{ modelSlug?: string } | null>(null);
  const [showCreateModel, setShowCreateModel] = useState(false);
  const [editModel, setEditModel] = useState<ModelListItem | null>(null);
  const [deleteModel, setDeleteModel] = useState<ModelListItem | null>(null);
  const [editPage, setEditPage] = useState<AssignedPage | null>(null);
  const [deletePage, setDeletePage] = useState<AssignedPage | null>(null);

  const pages = pagesQuery.data;
  const models = modelsQuery.data;
  const modelList = models ?? [];
  const modelsUnavailable = !models;
  const lit = useAnchoredPage(pages !== undefined);
  const workersOf = useMemo(() => workersByPage(usersQuery.data), [usersQuery.data]);

  const engineStatusOf = (pageLabel: string) => {
    if (engineQuery.data === undefined && engineQuery.isLoading) return { kind: "loading" } as const;
    if (engineQuery.data === undefined && engineQuery.isError) return { kind: "error" } as const;
    return engineStatusState(engineQuery.data?.pages.find((entry) => entry.pageLabel === pageLabel));
  };
  const collectionOf = (page: AssignedPage) => pageCollection(page, {
    overview: overviewQuery.data,
    overviewFailed: overviewQuery.isError,
    engineStatusOf,
    connection: connectionsQuery.data?.find((connection) => connection.label === page.label),
    connectionsFailed: connectionsQuery.isError,
    ofapi: ofapiQuery.status,
    ofapiLoading: ofapiQuery.isLoading,
  });

  const refetchAll = () => {
    void pagesQuery.refetch();
    void modelsQuery.refetch();
    void connectionsQuery.refetch();
    void overviewQuery.refetch();
    void engineQuery.refetch();
    void usersQuery.refetch();
    ofapiQuery.refetch();
  };
  const refreshing = pagesQuery.isFetching || modelsQuery.isFetching || usersQuery.isFetching;

  async function moveModel(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= modelList.length || reorder.isPending) return;
    const current = modelList[index]!;
    const neighbor = modelList[target]!;
    if (typeof current.sortOrder !== "number" || typeof neighbor.sortOrder !== "number") {
      toastError("Порядок моделей недоступен. Обновите экран.");
      return;
    }
    try {
      await reorder.mutateAsync([
        { slug: current.slug, sortOrder: neighbor.sortOrder },
        { slug: neighbor.slug, sortOrder: current.sortOrder },
      ]);
    } catch {
      // Two requests are not atomic: say so honestly.
      toastError("Порядок мог измениться наполовину. Обновите экран и проверьте порядок.");
    }
  }

  const addPageDisabled = modelsUnavailable || modelList.length === 0;
  const header = (
    <PageHeader
      actions={(
        <>
          {models !== undefined && modelList.length === 0 && <span className="settings-header-reason">Сначала добавьте модель</span>}
          <button type="button" className="btn" onClick={() => setShowCreateModel(true)}>
            <Plus size={16} aria-hidden="true" /> Новая модель
          </button>
          <button type="button" className="btn btn-primary" disabled={addPageDisabled} onClick={() => setAdding({})}>
            <Plus size={16} aria-hidden="true" /> Добавить страницу
          </button>
        </>
      )}
      fresh={pagesQuery.dataUpdatedAt ? { at: pagesQuery.dataUpdatedAt, onRefresh: refetchAll, refreshing } : undefined}
    />
  );

  if (pagesQuery.isLoading && !pages) {
    return <>{header}<CatalogSkeleton /></>;
  }
  if (!pages) {
    return (
      <>
        {header}
        <StatusPanel
          tone="error"
          title="Hub не ответил"
          description="Список страниц не пришёл. Это не значит, что страниц нет."
          action={<button type="button" className="btn btn-sm" onClick={refetchAll}>Повторить</button>}
        />
      </>
    );
  }

  const groups = modelGroups(modelList, pages);
  const collections = new Map(pages.map((page) => [page.label, collectionOf(page)]));
  const loginPages = pages.filter((page) => page.platform === "fansly" && collections.get(page.label)?.kind === "login").map((page) => page.label);

  // One quiet notice for every part that did not come (no more than two notices with the login one).
  const partial: string[] = [];
  if (pagesQuery.isError) partial.push(staleDataText(pagesQuery.dataUpdatedAt));
  if (modelsQuery.isError && !models) partial.push("Список моделей не загрузился: добавлять и изменять страницы пока нельзя.");
  if ((connectionsQuery.isError && !connectionsQuery.data) || (overviewQuery.isError && !overviewQuery.data)) partial.push("Состояние сбора не загрузилось.");
  if (usersQuery.isError && !usersQuery.data) partial.push("Список сотрудников не загрузился.");

  return (
    <>
      {header}
      <div className="stack">
        {(loginPages.length > 0 || partial.length > 0) && (
          <div className="settings-notices">
            {loginPages.length === 1 && (
              <Notice
                tone="danger"
                action={<Link to={buildPageSectionRoute(loginPages[0]!, "browser-login")} className="btn btn-sm">Войти в Fansly</Link>}
              >
                {loginPages[0]}: Fansly просит войти заново. Новые сообщения не приходят.
              </Notice>
            )}
            {loginPages.length > 1 && (
              <Notice tone="danger">
                Нужен вход на {loginPages.length} страницах:{" "}
                {loginPages.map((label, index) => (
                  <span key={label}>
                    <Link to={buildPageSectionRoute(label, "browser-login")} className="link">{label}</Link>
                    {index < loginPages.length - 1 ? ", " : "."}
                  </span>
                ))}
              </Notice>
            )}
            {partial.length > 0 && (
              <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={refetchAll}>Повторить</button>}>
                {partial.join(" ")}
              </Notice>
            )}
          </div>
        )}

        {!modelsUnavailable && modelList.length === 0 && (
          <StatusPanel
            title="Моделей пока нет"
            description="Добавьте модель, потом подключите к ней страницы."
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setShowCreateModel(true)}>Новая модель</button>}
          />
        )}

        {groups.map((group, index) => (
          <ModelCard
            key={group.slug}
            group={group}
            first={index === 0}
            last={index >= modelList.length - 1}
            reorderPending={reorder.isPending}
            modelsUnavailable={modelsUnavailable}
            highlighted={lit}
            collectionOf={(page) => collections.get(page.label) ?? collectionOf(page)}
            workersOf={workersOf}
            onMove={(direction) => void moveModel(index, direction)}
            onAddPage={() => setAdding({ modelSlug: group.slug })}
            onRename={() => group.model && setEditModel(group.model)}
            onDelete={() => group.model && setDeleteModel(group.model)}
            onEditPage={setEditPage}
            onDeletePage={setDeletePage}
          />
        ))}

        <UnfinishedConnections />

        <Disclosure label="Подробнее">
          <p>Порядок моделей задаёт порядок в фильтре страницы и в списках консоли.</p>
          <p>«Кто работает»: чаттеры с доступом к странице; доступы меняются в «Команда → Сотрудники».</p>
          <p>Отключённая страница сохраняет собранную историю.</p>
        </Disclosure>
      </div>

      {adding && (
        <AddPageWindow
          ofapi={ofapiQuery.status}
          onClose={() => setAdding(null)}
          onChooseOnlyFans={() => {
            setCreate(adding.modelSlug ? { modelSlug: adding.modelSlug } : {});
            setAdding(null);
          }}
        />
      )}
      {create && ofapiQuery.status === "on" && (
        <CreatePageModal
          models={modelList}
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
      {deletePage && (
        <DeletePageConfirm
          page={deletePage}
          workers={workersOf ? workersOf(deletePage.label).map((worker) => worker.username) : null}
          onClose={() => setDeletePage(null)}
        />
      )}
    </>
  );
}
