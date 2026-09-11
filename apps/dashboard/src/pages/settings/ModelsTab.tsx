import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ModelListItem } from "@agency_hub_core/contracts";
import { useAdminModels, useAdminDeleteModel, useAdminReorderModels } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { SearchInput } from "@/components/shared/SearchInput";
import { toast } from "sonner";
import { CreateModelModal } from "./CreateModelModal.js";
import { EditModelModal } from "./EditModelModal.js";

export function ModelsTab() {
  const { data: models, isError, error, refetch } = useAdminModels({ suppressGlobalError: true });
  const reorder = useAdminReorderModels();
  const reorderInFlight = useRef(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editModel, setEditModel] = useState<ModelListItem | null>(null);
  const [deleteModel, setDeleteModel] = useState<ModelListItem | null>(null);

  const [search, setSearch] = useSearchParams();
  const query = search.get("modelQuery") ?? "";
  const items = models ?? [];
  const visibleItems = items.filter((model) => `${model.name} ${model.slug}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function updateSearch(value: string) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set("modelQuery", value); else next.delete("modelQuery");
      return next;
    });
  }

  async function moveModel(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length || reorderInFlight.current || reorder.isPending || query.trim()) {
      return;
    }
    const current = items[index];
    const neighbor = items[target];

    if (!current || !neighbor) return;

    if (typeof current.sortOrder !== "number" || typeof neighbor.sortOrder !== "number") {
      toast.error("Порядок моделей недоступен. Обновите список и повторите.");
      return;
    }

    reorderInFlight.current = true;
    try {
      await reorder.mutateAsync([
        { slug: current.slug, sortOrder: neighbor.sortOrder },
        { slug: neighbor.slug, sortOrder: current.sortOrder },
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось изменить порядок моделей");
      void refetch();
    } finally {
      reorderInFlight.current = false;
    }
  }

  return (
    <>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-text-primary">Модели</h2>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
          >
            Добавить модель
          </button>
        </div>

        {isError && models && (
          <div className="mb-3"><StaleDataNotice title="Показан последний загруженный список моделей" error={error} /><button type="button" className="mt-2 text-sm font-semibold text-accent" onClick={() => void refetch()}>Повторить загрузку</button></div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <SearchInput value={query} onChange={updateSearch} placeholder="Найти модель по имени или коду…" />
          {query && <button type="button" className="text-sm font-medium text-accent" onClick={() => updateSearch("")}>Сбросить поиск</button>}
          {models && <span className="text-xs text-text-muted">{visibleItems.length} из {models.length}</span>}
        </div>
        {query.trim() && <p className="mb-3 text-xs text-text-muted">Чтобы менять общий порядок моделей, сбросьте поиск.</p>}
        {!models ? (
          <StatusPanel title={isError ? "Не удалось загрузить модели" : "Модели"} description={isError ? error instanceof Error ? error.message : "Каталог моделей недоступен." : "Загружаем список моделей…"} tone={isError ? "error" : "default"} action={isError ? <button type="button" className="font-semibold text-accent" onClick={() => void refetch()}>Повторить загрузку</button> : undefined} />
        ) : visibleItems.length === 0 ? (
          <StatusPanel title={items.length === 0 ? "Моделей пока нет" : "Модель не найдена"} description={items.length === 0 ? "Добавьте модель, затем подключите её страницы." : "Попробуйте другое имя или сбросьте поиск."} />
        ) : (
          <section className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[580px] border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Код", "Имя", "Страницы", "Действия"].map((col) => (
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
                {visibleItems.map((model) => (
                  <tr key={model.id} className="border-t border-border">
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">
                      {model.slug}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{model.name}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary"><Link className="inline-flex min-h-10 items-center whitespace-nowrap text-accent hover:underline" to={`/settings?${new URLSearchParams({ tab: "pages", model: model.slug })}`} aria-label={`Страницы модели ${model.name}: ${model.pageCount}`}>{model.pageCount} · Открыть</Link></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <div className="mr-1 flex flex-col">
                          <button
                            type="button"
                            onClick={() => moveModel(items.indexOf(model), -1)}
                            disabled={items.indexOf(model) === 0 || reorder.isPending || Boolean(query.trim())}
                            aria-label={`Поднять модель ${model.name}`}
                            className="min-h-8 min-w-8 rounded p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <ChevronUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveModel(items.indexOf(model), 1)}
                            disabled={items.indexOf(model) === items.length - 1 || reorder.isPending || Boolean(query.trim())}
                            aria-label={`Опустить модель ${model.name}`}
                            className="min-h-8 min-w-8 rounded p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <ChevronDown size={14} />
                          </button>
                        </div>
                        <button
                          type="button"
                          aria-label={`Изменить модель ${model.name}`}
                          onClick={() => setEditModel(model)}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                        >
                          Изменить
                        </button>
                        <button
                          type="button"
                          aria-label={`Удалить модель ${model.name}`}
                          onClick={() => setDeleteModel(model)}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                        >
                          Удалить
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {showCreate && <CreateModelModal onClose={() => setShowCreate(false)} />}
      {editModel && <EditModelModal model={editModel} onClose={() => setEditModel(null)} />}
      {deleteModel && (
        <DeleteModelConfirm model={deleteModel} onClose={() => setDeleteModel(null)} />
      )}
    </>
  );
}

function DeleteModelConfirm({
  model,
  onClose,
}: {
  model: ModelListItem;
  onClose: () => void;
}) {
  const deleteModel = useAdminDeleteModel(model.slug);
  const inFlight = useRef(false);

  function requestClose() {
    if (!inFlight.current) onClose();
  }

  async function handleConfirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await deleteModel.mutateAsync();
      toast.success("Модель удалена");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось удалить модель");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <ConfirmModal
      title={`Удалить модель: ${model.name}`}
      confirmLabel="Удалить"
      message={
        model.pageCount > 0
          ? `У модели ${model.pageCount} страниц. Сначала нужно убрать все связанные страницы.`
          : `Удалить модель «${model.name}»? Это действие нельзя отменить.`
      }
      isPending={deleteModel.isPending}
      onConfirm={handleConfirm}
      onClose={requestClose}
    />
  );
}
