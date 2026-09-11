import { useId, useState } from "react";
import { PlatformBadge } from "@/components/shared/PlatformBadge";

interface AssignedPageLike {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans";
  modelName: string;
}

interface AvailablePageLike {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans";
  modelName: string;
}

export function PageAssignmentsEditor({
  assignedPages,
  availablePages,
  selectedLabel,
  onSelectedLabelChange,
  onAssign,
  onUnassign,
  assignPending,
  unassignPending,
  disabled = false,
  availablePagesLoaded = true,
  hasAllPageAccess = false,
}: {
  assignedPages: AssignedPageLike[];
  availablePages: AvailablePageLike[];
  selectedLabel: string;
  onSelectedLabelChange: (value: string) => void;
  onAssign: () => void;
  onUnassign: (pageLabel: string) => void;
  assignPending: boolean;
  unassignPending: boolean;
  disabled?: boolean;
  availablePagesLoaded?: boolean;
  hasAllPageAccess?: boolean;
}) {
  const [query, setQuery] = useState("");
  const selectionId = useId();
  const matches = (page: AssignedPageLike) => `${page.label} ${page.modelName} ${page.platform}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const visibleAssigned = assignedPages.filter(matches);
  const visibleAvailable = availablePages.filter((page) => matches(page) || page.label === selectedLabel);
  const selectedAvailable = availablePages.some((page) => page.label === selectedLabel);
  const pending = disabled || assignPending || unassignPending;

  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-sm font-semibold text-text-primary">Доступ к страницам</h3>
      {hasAllPageAccess ? <p className="mb-3 text-sm text-text-secondary">Владелец имеет доступ ко всем страницам независимо от назначений ниже.</p> : <p className="mb-3 text-xs text-text-muted">Здесь показан действующий доступ. Эта форма меняет прямые назначения страниц; доступ через модель, если он есть, сохраняется.</p>}
      <label className="mb-3 block text-xs text-text-secondary">
        <span className="mb-1 block">Найти страницу</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название, модель или платформа" className="min-h-10 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none" />
      </label>
      <p className="mb-2 text-xs text-text-muted">В списке доступа: {assignedPages.length}{availablePagesLoaded ? ` · Доступно для назначения: ${availablePages.length}` : ""}</p>
      {visibleAssigned.length === 0 ? (
        <p className="text-sm text-text-muted">{assignedPages.length === 0 ? "Назначенных страниц нет." : "В текущем доступе страницы по этому запросу не найдены."}</p>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {visibleAssigned.map((page) => (
            <div
              key={page.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text-primary">
                <span className="break-all">{page.label}</span>
                <PlatformBadge platform={page.platform} />
                <span className="text-text-muted">{page.modelName}</span>
              </div>
              <button
                type="button"
                disabled={pending}
                aria-label={`Снять прямое назначение ${page.label}`}
                onClick={() => onUnassign(page.label)}
                className="min-h-8 shrink-0 rounded px-2 py-1 text-xs font-medium text-danger hover:bg-hover disabled:opacity-50"
              >
                Снять назначение
              </button>
            </div>
          ))}
        </div>
      )}

      {(availablePages.length > 0 || selectedLabel) && (
        <div className="mt-3">
          <label className="mb-2 block text-sm font-semibold text-text-primary" htmlFor={selectionId}>Назначить страницу</label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id={selectionId}
              value={selectedLabel}
              disabled={pending || !availablePagesLoaded}
              onChange={(event) => onSelectedLabelChange(event.target.value)}
              className="min-h-10 min-w-0 max-w-full flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="">Выберите страницу…</option>
              {selectedLabel && !selectedAvailable && <option value={selectedLabel}>{selectedLabel} · сейчас недоступна</option>}
              {visibleAvailable.map((page) => (
                <option key={page.id} value={page.label}>
                  {page.label} ({page.platform} / {page.modelName})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedAvailable || pending || !availablePagesLoaded}
              onClick={onAssign}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {assignPending ? "Назначаем…" : "Назначить"}
            </button>
          </div>
          {selectedLabel && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="break-all text-text-secondary">Выбрана: {selectedLabel}</span><button type="button" disabled={pending} onClick={() => onSelectedLabelChange("")} className="min-h-8 text-accent disabled:opacity-50">Сбросить выбор</button></div>}
          {selectedLabel && !selectedAvailable && <p role="status" className="mt-1 text-xs text-warning-dark">Выбранная страница больше не доступна для назначения. Выбор сохранён; обновите каталог или выберите другую страницу.</p>}
          {query && visibleAvailable.length === 0 && <p className="mt-2 text-xs text-text-muted">Для назначения по этому запросу ничего не найдено.</p>}
        </div>
      )}
    </div>
  );
}
