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
  onClose,
  initialPlatform = "fansly",
  initialModelSlug,
}: {
  models: ModelListItem[];
  onClose: () => void;
  initialPlatform?: Platform | undefined;
  initialModelSlug?: string | undefined;
}) {
  const createPage = useAdminCreatePage();
  const verifyCredentials = useAdminVerifyCredentials();

  // Common fields
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
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
    setCredentials((current) => ({ ...current, [field]: value }));
    resetVerify();
  }

  async function handleVerify() {
    const revision = ++verificationRevision.current;
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
      setVerifyError(error instanceof Error ? error.message : "Проверка не удалась");
      setVerifyState("verify-failed");
    }
  }

  async function handleCreate() {
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
        toast.success("Страница добавлена — первый сбор данных уже в очереди");
      } else {
        toast.warning(result.syncWarning?.message ?? "Страница добавлена, но первый сбор данных не запустился");
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось добавить страницу");
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
    modelSlug.length > 0;

  return (
    <ModalShell title="Добавить страницу" onClose={onClose}>
      <div className="space-y-5">
        <fieldset>
          <legend className="field-label">Платформа</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["fansly", "onlyfans"] as const).map((p) => (
              <label
                key={p}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  platform === p ? "border-accent bg-accent-soft text-text-primary" : "border-border text-text-secondary hover:bg-hover-alt"
                }`}
              >
                <input
                  type="radio"
                  name="platform"
                  value={p}
                  checked={platform === p}
                  onChange={() => {
                    setPlatform(p);
                    resetVerify();
                  }}
                  className="accent-accent"
                />
                {p === "fansly" ? "Fansly" : "OnlyFans"}
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Модель">
          <select
            value={modelSlug}
            onChange={(event) => setModelSlug(event.target.value)}
            className="select"
          >
            <option value="">Выберите модель…</option>
            {models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Название страницы" hint="Так страница будет называться в Hub и у чаттеров.">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="например, lora-fansly"
            autoComplete="off"
            spellCheck={false}
            className="input"
          />
        </Field>

        <section className="space-y-4 border-t border-border-light pt-5" aria-label="Данные входа">
          <h3 className="card-title">Данные входа</h3>
          <PlatformCredentialsFields
            platform={platform}
            values={credentials}
            onChange={updateCredential}
          />
        </section>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              disabled={!canVerify || verifyState === "verifying" || verifyState === "verified"}
              onClick={handleVerify}
              className="btn"
            >
              {verifyState === "verifying" ? "Проверяем…" : "Проверить данные"}
            </button>
            {verifyState !== "verified" && verifyState !== "verify-failed" && (
              <span className="text-xs text-text-secondary">
                {platform === "fansly"
                  ? "Hub проверит вход через этот прокси и покажет, чей это аккаунт."
                  : "Hub найдёт этот аккаунт в OnlyFans API."}
              </span>
            )}
          </div>
          {verifyState === "verified" && verifyResult && (
            <div role="status" className="notice notice-success">
              {platform === "fansly" ? "Вход подтверждён" : "Аккаунт найден"}: @{verifyResult.username ?? "неизвестно"}
              {verifyResult.displayName && ` (${verifyResult.displayName})`}
            </div>
          )}
          {verifyState === "verify-failed" && verifyError && (
            <div role="alert" className="notice notice-danger">
              {verifyError}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        {verifyState !== "verified" && (
          <span className="mr-auto text-xs text-text-secondary">Создать можно после проверки данных.</span>
        )}
        <button type="button" onClick={onClose} className="btn">
          Отмена
        </button>
        <button
          type="button"
          disabled={!canCreate || createPage.isPending}
          onClick={handleCreate}
          className="btn btn-primary"
        >
          Создать страницу
        </button>
      </div>
    </ModalShell>
  );
}
