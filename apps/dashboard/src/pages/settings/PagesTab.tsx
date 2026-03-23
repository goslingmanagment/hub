import { useState } from "react";
import type { AssignedPage } from "@agency_hub_core/contracts";
import {
  useAdminPages,
  useAdminModels,
  useAdminConnections,
  useAdminDeletePage,
  useAdminVerifyPage,
} from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { formatRelativeTime } from "@/lib/format";
import { toast } from "sonner";
import { CreatePageModal } from "./CreatePageModal";
import { EditPageModal } from "./EditPageModal";
import { CredentialsModal, type CredentialsModalConnection } from "./CredentialsModal";

export function PagesTab() {
  const { data: pages, isLoading: pagesLoading } = useAdminPages();
  const { data: models } = useAdminModels();
  const { data: connections } = useAdminConnections();

  const [showCreate, setShowCreate] = useState(false);
  const [editPage, setEditPage] = useState<AssignedPage | null>(null);
  const [deletePage, setDeletePage] = useState<AssignedPage | null>(null);
  const [credsConnection, setCredsConnection] = useState<CredentialsModalConnection | null>(null);

  if (pagesLoading) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading pages...</div>
    );
  }

  const items = pages ?? [];
  const modelList = models ?? [];
  const connectionList = connections ?? [];

  function openCredentials(page: AssignedPage) {
    const conn = connectionList.find((c) => c.label === page.label);
    setCredsConnection({
      label: page.label,
      platform: page.platform,
      proxyConfigured: conn?.proxyConfigured ?? false,
    });
  }

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary">Pages</h2>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={modelList.length === 0}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Create Page
          </button>
        </div>

        {modelList.length === 0 && (
          <p className="mb-3 text-sm text-text-muted">Create a model first before adding pages.</p>
        )}

        {items.length === 0 && modelList.length > 0 && (
          <p className="text-sm text-text-muted">No pages configured.</p>
        )}

        {items.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Label", "Platform", "Model", "Username", "Subs", "Followers", "Last Sync", "Actions"].map((col) => (
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
                {items.map((page) => (
                  <PageRow
                    key={page.id}
                    page={page}
                    onEdit={() => setEditPage(page)}
                    onDelete={() => setDeletePage(page)}
                    onCredentials={() => openCredentials(page)}
                  />
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {showCreate && (
        <CreatePageModal models={modelList} onClose={() => setShowCreate(false)} />
      )}
      {editPage && (
        <EditPageModal page={editPage} models={modelList} onClose={() => setEditPage(null)} />
      )}
      {deletePage && (
        <DeletePageConfirm page={deletePage} onClose={() => setDeletePage(null)} />
      )}
      {credsConnection && (
        <CredentialsModal connection={credsConnection} onClose={() => setCredsConnection(null)} />
      )}
    </>
  );
}

function PageRow({
  page,
  onEdit,
  onDelete,
  onCredentials,
}: {
  page: AssignedPage;
  onEdit: () => void;
  onDelete: () => void;
  onCredentials: () => void;
}) {
  const verifyPage = useAdminVerifyPage(page.label);

  async function handleVerify() {
    try {
      const result = await verifyPage.mutateAsync();
      if (result.verified) {
        toast.success(`${page.label} verified — @${result.username ?? "unknown"}`);
      } else {
        toast.error(`${page.label} verification failed`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed");
    }
  }

  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3 text-sm font-medium text-text-primary">{page.label}</td>
      <td className="px-4 py-3">
        <PlatformBadge platform={page.platform} />
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary">{page.modelName}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">
        @{page.username ?? page.displayName ?? "unknown"}
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary">{page.subscriberCount}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">{page.followerCount}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">
        {page.lastLightSyncAt ? formatRelativeTime(page.lastLightSyncAt) : "\u2014"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={verifyPage.isPending}
            onClick={handleVerify}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
          >
            {verifyPage.isPending ? "..." : "Verify"}
          </button>
          <button
            type="button"
            onClick={onCredentials}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
          >
            Creds
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function DeletePageConfirm({
  page,
  onClose,
}: {
  page: AssignedPage;
  onClose: () => void;
}) {
  const deletePage = useAdminDeletePage(page.label);

  async function handleConfirm() {
    try {
      await deletePage.mutateAsync();
      toast.success("Page deleted");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete page");
    }
  }

  return (
    <ConfirmModal
      title={`Delete page: ${page.label}`}
      message={`Are you sure you want to delete "${page.label}"? This will remove all associated data and cannot be undone.`}
      isPending={deletePage.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
