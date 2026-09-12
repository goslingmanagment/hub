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
  pagesLoading = false,
  pagesError = false,
  onRetryPages,
}: {
  assignedPages: AssignedPageLike[];
  availablePages: AvailablePageLike[];
  selectedLabel: string;
  onSelectedLabelChange: (value: string) => void;
  onAssign: () => void;
  onUnassign: (pageLabel: string) => void;
  assignPending: boolean;
  unassignPending: boolean;
  pagesLoading?: boolean;
  pagesError?: boolean;
  onRetryPages?: () => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">Assigned Pages</h3>
      {assignedPages.length === 0 ? (
        <p className="text-sm text-text-muted">No pages assigned.</p>
      ) : (
        <div className="space-y-1.5">
          {assignedPages.map((page) => (
            <div
              key={page.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text-primary">
                {page.label}
                <PlatformBadge platform={page.platform} />
                <span className="text-text-muted">{page.modelName}</span>
              </div>
              <button
                type="button"
                disabled={unassignPending || assignPending}
                onClick={() => onUnassign(page.label)}
                className="rounded px-2 py-0.5 text-xs font-medium text-danger hover:bg-hover disabled:opacity-50"
              >
                Unassign
              </button>
            </div>
          ))}
        </div>
      )}

      {pagesLoading && <p className="mt-3 text-sm text-text-muted">Loading available pages…</p>}
      {pagesError && <p role="alert" className="mt-3 text-sm text-danger">
        Available pages could not be refreshed. Your selection is kept; retry before assigning.
        {onRetryPages && <button type="button" onClick={onRetryPages} className="ml-2 underline">Retry</button>}
      </p>}

      {availablePages.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Assign a Page</h3>
          <div className="flex items-center gap-2">
            <select
              aria-label="Page to assign"
              value={selectedLabel}
              disabled={pagesLoading || pagesError || assignPending || unassignPending}
              onChange={(event) => onSelectedLabelChange(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">Select a page...</option>
              {availablePages.map((page) => (
                <option key={page.id} value={page.label}>
                  {page.label} ({page.platform} / {page.modelName})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedLabel || !availablePages.some((page) => page.label === selectedLabel) || assignPending || unassignPending || pagesLoading || pagesError}
              onClick={onAssign}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              Assign
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
