import { useState } from "react";
import type {
  CreatePageBody,
  ModelListItem,
  VerifyCredentialsResponse,
} from "@agency_hub_core/contracts";
import { useAdminCreatePage, useAdminVerifyCredentials } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";
import { buildCredentialsBody, PlatformCredentialsFields, type Platform, type PlatformCredentialsValues } from "./PlatformCredentialsFields.js";

type VerifyState = "idle" | "verifying" | "verified" | "verify-failed";

export function CreatePageModal({
  models,
  onClose,
}: {
  models: ModelListItem[];
  onClose: () => void;
}) {
  const createPage = useAdminCreatePage();
  const verifyCredentials = useAdminVerifyCredentials();

  // Common fields
  const [platform, setPlatform] = useState<Platform>("fansly");
  const [modelSlug, setModelSlug] = useState(models[0]?.slug ?? "");
  const [label, setLabel] = useState("");
  const [credentials, setCredentials] = useState<PlatformCredentialsValues>({
    authorization: "",
    fanslyClientId: "",
    fanslyClientCheck: "",
    fanslySessionId: "",
    onlyFansToken: "",
    onlyFansUsername: "",
    proxyRaw: "",
  });

  // Verify state
  const [verifyState, setVerifyState] = useState<VerifyState>("idle");
  const [verifyResult, setVerifyResult] = useState<VerifyCredentialsResponse | null>(null);
  const [verifyError, setVerifyError] = useState("");

  function resetVerify() {
    if (verifyState !== "idle") {
      setVerifyState("idle");
      setVerifyResult(null);
      setVerifyError("");
    }
  }

  function updateCredential<K extends keyof PlatformCredentialsValues>(
    field: K,
    value: PlatformCredentialsValues[K],
  ) {
    setCredentials((current) => ({ ...current, [field]: value }));
    resetVerify();
  }

  async function handleVerify() {
    setVerifyState("verifying");
    setVerifyError("");
    try {
      const result = await verifyCredentials.mutateAsync(buildCredentialsBody({
        platform,
        values: credentials,
      }));
      setVerifyResult(result);
      setVerifyState("verified");
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "Verification failed");
      setVerifyState("verify-failed");
    }
  }

  async function handleCreate() {
    const credBody = buildCredentialsBody({
      platform,
      values: credentials,
    });
    const body: CreatePageBody = {
      ...credBody,
      modelSlug,
      label: label.trim(),
    } as CreatePageBody;

    try {
      const result = await createPage.mutateAsync(body);
      if (result.syncQueued) {
        toast.success("Page created — initial sync queued");
      } else {
        toast.warning(result.syncWarning?.message ?? "Page created, but initial sync was not queued");
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create page");
    }
  }

  const canVerify =
    platform === "fansly"
      ? credentials.authorization.trim().length > 0
      : credentials.onlyFansToken.trim().length > 0 && credentials.onlyFansUsername.trim().length > 0;

  const canCreate = verifyState === "verified" && label.trim().length > 0 && modelSlug.length > 0;

  return (
    <ModalShell title="Create Page" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Platform">
          <div className="flex items-center gap-4">
            {(["fansly", "onlyfans"] as const).map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm text-text-primary">
                <input
                  type="radio"
                  name="platform"
                  value={p}
                  checked={platform === p}
                  onChange={() => {
                    setPlatform(p);
                    resetVerify();
                  }}
                />
                {p === "fansly" ? "Fansly" : "OnlyFans"}
              </label>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Model">
            <select
              value={modelSlug}
              onChange={(event) => setModelSlug(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">Select model...</option>
              {models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name} ({m.slug})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. alice-fansly"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </div>

        <PlatformCredentialsFields
          platform={platform}
          values={credentials}
          onChange={updateCredential}
        />

        {/* Verify result / error */}
        {verifyState === "verified" && verifyResult && (
          <div className="rounded-lg border border-green/30 bg-green/5 px-3 py-2 text-sm text-green">
            Verified: @{verifyResult.username ?? "unknown"}
            {verifyResult.displayName && ` (${verifyResult.displayName})`}
          </div>
        )}
        {verifyState === "verify-failed" && verifyError && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {verifyError}
          </div>
        )}
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
          disabled={!canVerify || verifyState === "verifying" || verifyState === "verified"}
          onClick={handleVerify}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary hover:bg-hover disabled:opacity-50"
        >
          {verifyState === "verifying" ? "Verifying..." : "Verify Credentials"}
        </button>
        <button
          type="button"
          disabled={!canCreate || createPage.isPending}
          onClick={handleCreate}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Create Page
        </button>
      </div>
    </ModalShell>
  );
}
