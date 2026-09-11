import { useRef, useState } from "react";
import type { ConnectionItem } from "@agency_hub_core/contracts";
import { getProxyStringError } from "@agency_hub_core/shared";
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
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [syncStillBlocked, setSyncStillBlocked] = useState(false);
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
  const proxyError = getProxyStringError(values.proxyRaw);

  const title = `Доступ к ${connection.label}`;

  function updateField<K extends keyof PlatformCredentialsValues>(
    field: K,
    value: PlatformCredentialsValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setSyncStillBlocked(false);
    try {
      const result = await updateCredentials.mutateAsync(buildCredentialsBody({
        platform: connection.platform,
        values,
        requireCredentials: false,
        hadStoredProxy,
        initialStoredProxy: hadStoredProxy ? { url: connection.proxyUrl!, hasAuth: connection.proxyHasAuth } : null,
      }));
      // W3.3 (D4-N1): verified but the auth block could not be cleared —
      // streams are still paused, so an all-clear toast would be a lie.
      if (result.syncUnblocked === false) {
        setSyncStillBlocked(true);
        toast.warning("Доступ проверен, синхронизация остаётся приостановленной");
        return;
      }
      toast.success(`${connection.label} · доступ обновлён`);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Не удалось обновить доступ. Поля сохранены — проверьте их и повторите.");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <ModalShell title={title} onClose={() => { if (!inFlight.current) onClose(); }} closeDisabled={updateCredentials.isPending}>
      {syncStillBlocked && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          Доступ проверен, но снять блокировку синхронизации не удалось. Потоки остаются
          приостановленными. Повторите проверку; если ошибка сохранится, откройте состояние синхронизации.
        </div>
      )}
      {error && <p role="alert" className="mb-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
      <fieldset disabled={updateCredentials.isPending} className="space-y-4">
        <PlatformCredentialsFields
          platform={connection.platform}
          values={values}
          onChange={updateField}
          initialStoredProxy={hadStoredProxy ? { url: connection.proxyUrl!, hasAuth: connection.proxyHasAuth } : null}
        />
      </fieldset>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={updateCredentials.isPending}
          onClick={() => { if (!inFlight.current) onClose(); }}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          Отмена
        </button>
        <button
          type="button"
          disabled={updateCredentials.isPending || Boolean(proxyError)}
          onClick={handleSubmit}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {updateCredentials.isPending ? "Проверяем и сохраняем…" : "Проверить и сохранить"}
        </button>
      </div>
    </ModalShell>
  );
}
