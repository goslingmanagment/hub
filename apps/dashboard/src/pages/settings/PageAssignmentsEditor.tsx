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
}: {
  assignedPages: AssignedPageLike[];
  availablePages: AvailablePageLike[];
  selectedLabel: string;
  onSelectedLabelChange: (value: string) => void;
  onAssign: () => void;
  onUnassign: (pageLabel: string) => void;
  assignPending: boolean;
  unassignPending: boolean;
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
              className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2"
            >
              <div className="flex items-center gap-2 text-sm text-text-primary">
                {page.label}
                <PlatformBadge platform={page.platform} />
                <span className="text-text-muted">{page.modelName}</span>
              </div>
              <button
                type="button"
                disabled={unassignPending}
                onClick={() => onUnassign(page.label)}
                className="rounded px-2 py-0.5 text-xs font-medium text-danger hover:bg-hover disabled:opacity-50"
              >
                Unassign
              </button>
            </div>
          ))}
        </div>
      )}

      {availablePages.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Assign a Page</h3>
          <div className="flex items-center gap-2">
            <select
              value={selectedLabel}
              onChange={(event) => onSelectedLabelChange(event.target.value)}
              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
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
              disabled={!selectedLabel || assignPending}
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
