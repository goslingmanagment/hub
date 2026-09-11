import { useRef, useState } from "react";
import type { AuthUser } from "@agency_hub_core/contracts";
import { useAdminPages, useAdminAssignPage, useAdminUnassignPage } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { toast } from "sonner";
import { PageAssignmentsEditor } from "./PageAssignmentsEditor.js";

export function UserPageAssignmentModal({
  user,
  onClose,
  actionsDisabled = false,
}: {
  user: AuthUser;
  onClose: () => void;
  actionsDisabled?: boolean;
}) {
  const pagesQuery = useAdminPages({ suppressGlobalError: true });
  const allPages = pagesQuery.data;
  const assignPage = useAdminAssignPage(user.username);
  const unassignPage = useAdminUnassignPage(user.username);
  const [selectedLabel, setSelectedLabel] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const busy = pending || assignPage.isPending || unassignPage.isPending;

  function requestClose() {
    if (!inFlight.current && !busy) onClose();
  }

  const assignedLabels = new Set(user.assignedPages.map((p) => p.label));
  const availablePages = (allPages ?? []).filter((p) => !assignedLabels.has(p.label));

  async function handleAssign() {
    if (inFlight.current || busy || actionsDisabled || !availablePages.some((page) => page.label === selectedLabel)) return;
    inFlight.current = true;
    setPending(true);
    setActionError("");
    try {
      await assignPage.mutateAsync({ pageLabel: selectedLabel });
      toast.success(`${selectedLabel}: назначена пользователю ${user.username}`);
      setSelectedLabel("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Не удалось назначить страницу");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function handleUnassign(pageLabel: string) {
    if (inFlight.current || busy || actionsDisabled) return;
    inFlight.current = true;
    setPending(true);
    setActionError("");
    try {
      await unassignPage.mutateAsync(pageLabel);
      toast.success(`${pageLabel}: прямое назначение снято. Доступ через модель, если он есть, сохраняется.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Не удалось снять назначение страницы");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <ModalShell title={`Доступ: ${user.username}`} onClose={requestClose} closeDisabled={busy} closeLabel="Закрыть">
      <div className="space-y-4">
        {actionsDisabled && <p role="status" className="text-sm text-warning-dark">Актуальный активный пользователь недоступен. Выбор сохранён; изменения пока заблокированы.</p>}
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
          assignPending={assignPage.isPending}
          unassignPending={unassignPage.isPending}
          disabled={busy || actionsDisabled}
          availablePagesLoaded={allPages !== undefined}
          hasAllPageAccess={user.role === "owner"}
        />
        {actionError && <p role="alert" className="break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{actionError}</p>}
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button
          type="button"
          onClick={requestClose}
          disabled={busy}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
        >
          Готово
        </button>
      </div>
    </ModalShell>
  );
}
