import { useState } from "react";
import type { AuthUser, AdminAssignPageBody } from "@agency_hub_core/contracts";
import { useAdminPages, useAdminAssignPage, useAdminUnassignPage } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { toast } from "sonner";

export function UserPageAssignmentModal({
  user,
  onClose,
}: {
  user: AuthUser;
  onClose: () => void;
}) {
  const { data: allPages } = useAdminPages();
  const assignPage = useAdminAssignPage(user.username);
  const unassignPage = useAdminUnassignPage(user.username);
  const [selectedLabel, setSelectedLabel] = useState("");

  const assignedLabels = new Set(user.assignedPages.map((p) => p.label));
  const availablePages = (allPages ?? []).filter((p) => !assignedLabels.has(p.label));

  async function handleAssign() {
    if (!selectedLabel) return;
    try {
      await assignPage.mutateAsync({ pageLabel: selectedLabel });
      toast.success(`Assigned ${selectedLabel} to ${user.username}`);
      setSelectedLabel("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to assign page");
    }
  }

  async function handleUnassign(pageLabel: string) {
    try {
      await unassignPage.mutateAsync(pageLabel);
      toast.success(`Unassigned ${pageLabel} from ${user.username}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unassign page");
    }
  }

  return (
    <ModalShell title={`Manage pages for ${user.username}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Assigned Pages</h3>
          {user.assignedPages.length === 0 && (
            <p className="text-sm text-text-muted">No pages assigned.</p>
          )}
          <div className="space-y-1.5">
            {user.assignedPages.map((page) => (
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
                  disabled={unassignPage.isPending}
                  onClick={() => handleUnassign(page.label)}
                  className="rounded px-2 py-0.5 text-xs font-medium text-danger hover:bg-hover disabled:opacity-50"
                >
                  Unassign
                </button>
              </div>
            ))}
          </div>
        </div>

        {availablePages.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">Assign a Page</h3>
            <div className="flex items-center gap-2">
              <select
                value={selectedLabel}
                onChange={(event) => setSelectedLabel(event.target.value)}
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
                disabled={!selectedLabel || assignPage.isPending}
                onClick={handleAssign}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Done
        </button>
      </div>
    </ModalShell>
  );
}
