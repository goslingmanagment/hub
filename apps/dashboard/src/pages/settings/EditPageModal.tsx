import { useState } from "react";
import type { AssignedPage, ModelListItem, UpdatePageBody } from "@agency_hub_core/contracts";
import { useAdminUpdatePage } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { toast } from "sonner";

export function EditPageModal({
  page,
  models,
  onClose,
}: {
  page: AssignedPage;
  models: ModelListItem[];
  onClose: () => void;
}) {
  const updatePage = useAdminUpdatePage(page.label);
  const [label, setLabel] = useState(page.label);
  const [modelSlug, setModelSlug] = useState(page.modelSlug);

  async function handleSubmit() {
    const body: UpdatePageBody = {};
    if (label.trim() !== page.label) body.label = label.trim();
    if (modelSlug !== page.modelSlug) body.modelSlug = modelSlug;

    if (!body.label && !body.modelSlug) {
      onClose();
      return;
    }

    try {
      await updatePage.mutateAsync(body);
      toast.success("Page updated");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update page");
    }
  }

  return (
    <ModalShell title={`Edit page: ${page.label}`} onClose={onClose}>
      <div className="mb-4 flex items-center gap-2">
        <PlatformBadge platform={page.platform} />
        <span className="text-sm text-text-muted">Platform cannot be changed</span>
      </div>

      <div className="space-y-4">
        <Field label="Label">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Model">
          <select
            value={modelSlug}
            onChange={(event) => setModelSlug(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name} ({m.slug})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={updatePage.isPending || !label.trim()}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}
