import { useState } from "react";
import type { ConnectionItem, VerifyCredentialsBody } from "@agency_hub_core/contracts";
import { useAdminUpdateCredentials } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";

export type CredentialsModalConnection = Pick<ConnectionItem, "label" | "platform" | "proxyConfigured">;

export function CredentialsModal({
  connection,
  onClose,
}: {
  connection: CredentialsModalConnection;
  onClose: () => void;
}) {
  const updateCredentials = useAdminUpdateCredentials(connection.label);
  const [authorization, setAuthorization] = useState("");
  const [fanslyClientId, setFanslyClientId] = useState("");
  const [fanslyClientCheck, setFanslyClientCheck] = useState("");
  const [fanslySessionId, setFanslySessionId] = useState("");
  const [onlyFansToken, setOnlyFansToken] = useState("");
  const [onlyFansUsername, setOnlyFansUsername] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [clearStoredProxy, setClearStoredProxy] = useState(false);

  const title = `Update ${connection.label} credentials`;
  const hasProxy = proxyUrl.trim().length > 0;

  async function handleSubmit() {
    const body: VerifyCredentialsBody = connection.platform === "fansly"
      ? {
        platform: "fansly",
        session: {
          authorization: authorization.trim(),
          fanslyClientId: fanslyClientId.trim() || undefined,
          fanslyClientCheck: fanslyClientCheck.trim() || undefined,
          fanslySessionId: fanslySessionId.trim() || undefined,
        },
        proxy: clearStoredProxy
          ? null
          : hasProxy
            ? {
              url: proxyUrl.trim(),
              username: proxyUsername.trim() || null,
              password: proxyPassword.trim() || null,
            }
            : undefined,
      }
      : {
        platform: "onlyfans",
        auth: {
          token: onlyFansToken.trim(),
        },
        username: onlyFansUsername.trim(),
        proxy: clearStoredProxy
          ? null
          : hasProxy
            ? {
              url: proxyUrl.trim(),
              username: proxyUsername.trim() || null,
              password: proxyPassword.trim() || null,
            }
            : undefined,
      };

    try {
      await updateCredentials.mutateAsync(body);
      toast.success("Credentials updated");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update credentials");
    }
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <div className="space-y-4">
        {connection.platform === "fansly" ? (
          <>
            <Field label="Authorization">
              <textarea
                value={authorization}
                onChange={(event) => setAuthorization(event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="fansly-client-id (optional)">
              <input
                value={fanslyClientId}
                onChange={(event) => setFanslyClientId(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
            <Field label="fansly-client-check (optional)">
              <input
                value={fanslyClientCheck}
                onChange={(event) => setFanslyClientCheck(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
            <Field label="fansly-session-id (optional)">
              <input
                value={fanslySessionId}
                onChange={(event) => setFanslySessionId(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Auth token">
              <textarea
                value={onlyFansToken}
                onChange={(event) => setOnlyFansToken(event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              />
            </Field>
            <Field label="Username">
              <input
                value={onlyFansUsername}
                onChange={(event) => setOnlyFansUsername(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </Field>
          </>
        )}

        {connection.proxyConfigured && (
          <label className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={clearStoredProxy}
              onChange={(event) => setClearStoredProxy(event.target.checked)}
            />
            Remove the currently stored proxy on save
          </label>
        )}

        <div className="grid grid-cols-3 gap-3">
          <Field label="Proxy URL (optional)">
            <input
              value={proxyUrl}
              onChange={(event) => {
                setProxyUrl(event.target.value);
                if (event.target.value.trim().length > 0) {
                  setClearStoredProxy(false);
                }
              }}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
          <Field label="Proxy username">
            <input
              value={proxyUsername}
              onChange={(event) => setProxyUsername(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
          <Field label="Proxy password">
            <input
              type="password"
              value={proxyPassword}
              onChange={(event) => setProxyPassword(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </div>
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
