import { useState } from "react";
import type { ConnectionItem } from "@agency_hub_core/contracts";
import { useAdminUpdateCredentials } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { toast } from "sonner";
import { buildCredentialsBody, PlatformCredentialsFields, type PlatformCredentialsValues } from "./PlatformCredentialsFields.js";

export type CredentialsModalConnection = Pick<ConnectionItem, "label" | "platform" | "proxyUrl" | "proxyHasAuth">;

export function CredentialsModal({
  connection,
  onClose,
}: {
  connection: CredentialsModalConnection;
  onClose: () => void;
}) {
  const updateCredentials = useAdminUpdateCredentials(connection.label);
  const [values, setValues] = useState<PlatformCredentialsValues>({
    authorization: "",
    fanslyClientId: "",
    fanslyClientCheck: "",
    fanslySessionId: "",
    onlyFansToken: "",
    onlyFansUsername: "",
    proxyRaw: connection.proxyUrl ?? "",
  });

  const hadStoredProxy = connection.proxyUrl != null;

  const title = `Update ${connection.label} credentials`;

  function updateField<K extends keyof PlatformCredentialsValues>(
    field: K,
    value: PlatformCredentialsValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit() {
    try {
      await updateCredentials.mutateAsync(buildCredentialsBody({
        platform: connection.platform,
        values,
        requireCredentials: false,
        hadStoredProxy,
        initialStoredProxy: hadStoredProxy ? { url: connection.proxyUrl!, hasAuth: connection.proxyHasAuth } : null,
      }));
      toast.success("Credentials updated");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update credentials");
    }
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <div className="space-y-4">
        <PlatformCredentialsFields
          platform={connection.platform}
          values={values}
          onChange={updateField}
          initialStoredProxy={hadStoredProxy ? { url: connection.proxyUrl!, hasAuth: connection.proxyHasAuth } : null}
        />
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
          disabled={updateCredentials.isPending}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}
