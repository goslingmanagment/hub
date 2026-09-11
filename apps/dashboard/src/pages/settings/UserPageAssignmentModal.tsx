import { useState } from "react";
import type { AuthUser } from "@agency_hub_core/contracts";
import { useAdminPages, useAdminAssignPage, useAdminUnassignPage } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { toast } from "sonner";
import { PageAssignmentsEditor } from "./PageAssignmentsEditor.js";

export function UserPageAssignmentModal({
  user,
  onClose,
}: {
  user: AuthUser;
  onClose: () => void;
}) {
  const pagesQuery = useAdminPages();
  const allPages = pagesQuery.data;
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
        <QueryNotice error={pagesQuery.isError} stale={allPages !== undefined} retry={pagesQuery.refetch} />
        {!allPages && !pagesQuery.isError && <p role="status" className="text-sm text-text-muted">Загружаем каталог страниц для назначения…</p>}
        {allPages?.length === 0 && <p className="text-sm text-text-muted">В каталоге пока нет доступных страниц.</p>}
        <PageAssignmentsEditor
          assignedPages={user.assignedPages}
          availablePages={availablePages}
          selectedLabel={selectedLabel}
          onSelectedLabelChange={setSelectedLabel}
          onAssign={handleAssign}
          onUnassign={handleUnassign}
          assignPending={assignPage.isPending || allPages === undefined}
          unassignPending={unassignPage.isPending}
        />
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
