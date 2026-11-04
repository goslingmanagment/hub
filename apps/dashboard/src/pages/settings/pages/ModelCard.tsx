import { ArrowDown, ArrowUp } from "lucide-react";
import type { AssignedPage } from "@agency_hub_core/contracts";
import { RowMenu } from "@/components/ui/RowMenu";
import type { PageCollection } from "./pageCollection.js";
import { PageRow, type PageWorker } from "./PageRow.js";
import { pagesCount, type ModelGroup } from "./pagesView.js";

/** A model and its pages: its order, its menu, a row per page. */
export function ModelCard({
  group,
  first,
  last,
  reorderPending,
  modelsUnavailable,
  highlighted,
  collectionOf,
  workersOf,
  onMove,
  onAddPage,
  onRename,
  onDelete,
  onEditPage,
  onDeletePage,
}: {
  group: ModelGroup;
  first: boolean;
  last: boolean;
  reorderPending: boolean;
  modelsUnavailable: boolean;
  highlighted: string | null;
  collectionOf: (page: AssignedPage) => PageCollection;
  workersOf: ((label: string) => PageWorker[]) | null;
  onMove: (direction: -1 | 1) => void;
  onAddPage: () => void;
  onRename: () => void;
  onDelete: () => void;
  onEditPage: (page: AssignedPage) => void;
  onDeletePage: (page: AssignedPage) => void;
}) {
  const { model } = group;
  return (
    <section className="card" aria-label={`Модель ${group.name}`}>
      <div className="card-header settings-model-head">
        <div className="min-w-0">
          <h2 className="card-title">{group.name}</h2>
          <p className="card-description">{pagesCount(group.pages.length)}</p>
        </div>
        {model && (
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={`Поднять модель ${group.name}`}
              title="Поднять"
              disabled={first || reorderPending}
              onClick={() => onMove(-1)}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={`Опустить модель ${group.name}`}
              title="Опустить"
              disabled={last || reorderPending}
              onClick={() => onMove(1)}
            >
              <ArrowDown size={16} aria-hidden="true" />
            </button>
            <RowMenu
              label={`Действия с моделью ${group.name}`}
              items={[
                {
                  label: "Добавить страницу",
                  onSelect: onAddPage,
                  disabled: modelsUnavailable,
                },
                { label: "Переименовать", onSelect: onRename },
                {
                  label: "Удалить модель",
                  danger: true,
                  disabled: model.pageCount > 0,
                  hint: model.pageCount > 0 ? "Сначала отключите страницы модели" : undefined,
                  onSelect: onDelete,
                },
              ]}
            />
          </div>
        )}
      </div>
      {group.pages.length > 0 && (
        <div className="table-wrap">
          <table className="data-table settings-pages-table">
            <colgroup>
              <col className="settings-col-page" />
              <col className="settings-col-status" />
              <col />
              <col className="settings-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>Страница</th>
                <th>Сбор данных</th>
                <th>Кто работает</th>
                <th><span className="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {group.pages.map((page) => {
                const workers = workersOf?.(page.label) ?? null;
                return (
                  <PageRow
                    key={page.id}
                    page={page}
                    collection={collectionOf(page)}
                    workers={workers}
                    editDisabled={modelsUnavailable}
                    highlighted={highlighted === page.label}
                    onEdit={() => onEditPage(page)}
                    onDelete={() => onDeletePage(page)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
