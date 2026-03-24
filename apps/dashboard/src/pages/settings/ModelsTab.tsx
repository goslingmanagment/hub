import { useState } from "react";
import type { ModelListItem } from "@agency_hub_core/contracts";
import { useAdminModels, useAdminDeleteModel } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { toast } from "sonner";
import { CreateModelModal } from "./CreateModelModal.js";
import { EditModelModal } from "./EditModelModal.js";

export function ModelsTab() {
  const { data: models, isLoading } = useAdminModels();
  const [showCreate, setShowCreate] = useState(false);
  const [editModel, setEditModel] = useState<ModelListItem | null>(null);
  const [deleteModel, setDeleteModel] = useState<ModelListItem | null>(null);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading models...</div>
    );
  }

  const items = models ?? [];

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary">Models</h2>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90"
          >
            Create Model
          </button>
        </div>

        {items.length === 0 && (
          <p className="text-sm text-text-muted">No models configured.</p>
        )}
        {items.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Slug", "Name", "Pages", "Actions"].map((col) => (
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
                {items.map((model) => (
                  <tr key={model.id} className="border-t border-border">
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">
                      {model.slug}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{model.name}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{model.pageCount}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditModel(model)}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteModel(model)}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                        >
                          Delete
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

  async function handleConfirm() {
    try {
      await deleteModel.mutateAsync();
      toast.success("Model deleted");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete model");
    }
  }

  return (
    <ConfirmModal
      title={`Delete model: ${model.slug}`}
      message={
        model.pageCount > 0
          ? `This model has ${model.pageCount} page(s). You must remove all pages before deleting.`
          : `Are you sure you want to delete the model "${model.name}"? This action cannot be undone.`
      }
      isPending={deleteModel.isPending}
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
