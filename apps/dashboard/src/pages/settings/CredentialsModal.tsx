import { useState } from "react";
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

  const title = `Данные входа — ${connection.label}`;

  function updateField<K extends keyof PlatformCredentialsValues>(
    field: K,
    value: PlatformCredentialsValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit() {
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
        toast.warning("Вход подтверждён, но сбор данных всё ещё остановлен");
        return;
      }
      toast.success("Данные входа обновлены");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить данные входа");
    }
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      {syncStillBlocked && (
        <div role="alert" className="notice notice-warning mb-4">
          Вход подтверждён, но снять остановку сбора не удалось: сбор данных страницы всё ещё на паузе, инцидент
          открыт. Сохраните ещё раз; если не поможет — загляните в «Система → Сбор данных → Fansly».
        </div>
      )}
      <div className="space-y-4">
        {connection.platform === "fansly" && (
          <p className="text-sm text-text-secondary">
            Чтобы сменить только прокси, поля входа оставьте пустыми.
          </p>
        )}
        <PlatformCredentialsFields
          platform={connection.platform}
          values={values}
          onChange={updateField}
          initialStoredProxy={hadStoredProxy ? { url: connection.proxyUrl!, hasAuth: connection.proxyHasAuth } : null}
        />
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="btn">
          Отмена
        </button>
        <button
          type="button"
          disabled={updateCredentials.isPending || Boolean(proxyError)}
          onClick={handleSubmit}
          className="btn btn-primary"
        >
          {updateCredentials.isPending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </ModalShell>
  );
}
