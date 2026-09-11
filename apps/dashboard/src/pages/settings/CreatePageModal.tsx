import { useEffect, useRef, useState } from "react";
import type {
  CreatePageBody,
  ModelListItem,
  VerifyCredentialsResponse,
} from "@agency_hub_core/contracts";
import { getProxyStringError } from "@agency_hub_core/shared";
import { useAdminCreatePage, useAdminVerifyCredentials } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";
import { buildCredentialsBody, PlatformCredentialsFields, type Platform, type PlatformCredentialsValues } from "./PlatformCredentialsFields.js";

type VerifyState = "idle" | "verifying" | "verified" | "verify-failed";

export function CreatePageModal({
  models,
  initialModelSlug,
  onClose,
}: {
  models: ModelListItem[];
  initialModelSlug?: string;
  onClose: () => void;
}) {
  const createPage = useAdminCreatePage();
  const verifyCredentials = useAdminVerifyCredentials();

  // Common fields
  const [platform, setPlatform] = useState<Platform>("fansly");
  const [modelSlug, setModelSlug] = useState(initialModelSlug ?? models[0]?.slug ?? "");
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
  const verificationRevision = useRef(0);
  const verificationInFlight = useRef<number | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const createInFlight = useRef(false);
  const pending = submitting || createPage.isPending;

  useEffect(() => () => { verificationRevision.current += 1; }, []);

  function resetVerify() {
    verificationRevision.current += 1;
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
    if (createInFlight.current) return;
    setCredentials((current) => ({ ...current, [field]: value }));
    resetVerify();
  }

  async function handleVerify() {
    if (createInFlight.current || !canVerify || verificationInFlight.current === verificationRevision.current) return;
    const revision = ++verificationRevision.current;
    verificationInFlight.current = revision;
    setVerifyState("verifying");
    setVerifyError("");
    try {
      const result = await verifyCredentials.mutateAsync(buildCredentialsBody({
        platform,
        values: credentials,
      }));
      if (revision !== verificationRevision.current) return;
      setVerifyResult(result);
      setVerifyState("verified");
    } catch (error) {
      if (revision !== verificationRevision.current) return;
      setVerifyError(error instanceof Error ? error.message : "Не удалось проверить доступ");
      setVerifyState("verify-failed");
    } finally {
      if (verificationInFlight.current === revision) verificationInFlight.current = null;
    }
  }

  function requestClose() {
    if (!createInFlight.current) onClose();
  }

  async function handleCreate() {
    if (createInFlight.current || !canCreate) return;
    createInFlight.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      const credBody = buildCredentialsBody({
        platform,
        values: credentials,
      });
      const body: CreatePageBody = {
        ...credBody,
        modelSlug,
        label: label.trim(),
      } as CreatePageBody;
      const result = await createPage.mutateAsync(body);
      if (result.syncQueued) {
        toast.success("Страница создана. Начальная синхронизация поставлена в очередь");
      } else {
        toast.warning(result.syncWarning?.message ?? "Страница создана, но начальная синхронизация не поставлена в очередь");
      }
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Не удалось создать страницу");
    } finally {
      createInFlight.current = false;
      setSubmitting(false);
    }
  }

  const proxyError = platform === "fansly" ? getProxyStringError(credentials.proxyRaw) : null;
  const hasRequiredCredentials = platform === "fansly"
      ? credentials.authorization.trim().length > 0
      : credentials.onlyFansUsername.trim().length > 0;
  const hasRequiredProxy = platform !== "fansly" || credentials.proxyRaw.trim().length > 0;
  const canVerify = !proxyError && hasRequiredCredentials && hasRequiredProxy;

  const canCreate = verifyState === "verified" &&
    !proxyError &&
    label.trim().length > 0 &&
    models.some((model) => model.slug === modelSlug);

  return (
    <ModalShell title="Добавить страницу" onClose={requestClose} closeLabel="Закрыть">
      <form aria-busy={pending} onSubmit={(event) => { event.preventDefault(); return handleCreate(); }}>
      <fieldset disabled={pending} className="space-y-4">
        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold text-text-secondary">Платформа</legend>
          <div className="flex flex-wrap items-center gap-4">
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
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Модель">
            <select
              value={modelSlug}
              required
              onChange={(event) => setModelSlug(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">Выберите модель…</option>
              {modelSlug && !models.some((model) => model.slug === modelSlug) && <option value={modelSlug}>{modelSlug} · нет в текущем каталоге</option>}
              {models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name} ({m.slug})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Название страницы">
            <input
              value={label}
              required
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Например, alice-fansly"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </Field>
        </div>
        {!models.some((model) => model.slug === modelSlug) && <p className="text-xs text-text-muted">Для создания страницы выберите модель из доступного каталога. Введённые данные сохранены.</p>}

        <PlatformCredentialsFields
          platform={platform}
          values={credentials}
          onChange={updateCredential}
        />

        {/* Verify result / error */}
        {verifyState === "verified" && verifyResult && (
          <div role="status" className="break-words rounded-lg border border-green/30 bg-green/5 px-3 py-2 text-sm text-green">
            Доступ проверен{verifyResult.username ? `: @${verifyResult.username}` : verifyResult.displayName ? `: ${verifyResult.displayName}` : ""}
            {verifyResult.username && verifyResult.displayName && ` (${verifyResult.displayName})`}
          </div>
        )}
        {verifyState === "verify-failed" && verifyError && (
          <div role="alert" className="break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {verifyError}
          </div>
        )}
      </fieldset>
      <p className="mt-4 text-xs text-text-muted">После проверки доступа можно создать страницу и запустить начальную синхронизацию.</p>
      {submitError && <p role="alert" className="mt-4 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{submitError}</p>}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={requestClose}
          disabled={pending}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="button"
          disabled={pending || !canVerify || verifyState === "verifying" || verifyState === "verified"}
          onClick={handleVerify}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-text-secondary hover:bg-hover disabled:opacity-50"
        >
          {verifyState === "verifying" ? "Проверяем…" : "Проверить доступ"}
        </button>
        <button
          type="submit"
          disabled={!canCreate || pending}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Создаём…" : "Создать страницу"}
        </button>
      </div>
      </form>
    </ModalShell>
  );
}
