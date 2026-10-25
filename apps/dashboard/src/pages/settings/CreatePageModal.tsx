import { useEffect, useRef, useState } from "react";
import type {
  CreatePageBody,
  ModelListItem,
  VerifyCredentialsResponse,
} from "@agency_hub_core/contracts";
import { useAdminCreatePage, useAdminVerifyCredentials } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { toast } from "sonner";

type VerifyState = "idle" | "verifying" | "verified" | "verify-failed";

/** A new OnlyFans page: its account found in OnlyFans API by its username. A
 *  Fansly page is connected through its own server browser instead
 *  (`BrowserProfilesSection`). */
export function CreatePageModal({
  models,
  onClose,
  initialModelSlug,
}: {
  models: ModelListItem[];
  onClose: () => void;
  initialModelSlug?: string | undefined;
}) {
  const createPage = useAdminCreatePage();
  const verifyCredentials = useAdminVerifyCredentials();

  const [modelSlug, setModelSlug] = useState(initialModelSlug ?? models[0]?.slug ?? "");
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");

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

  async function handleVerify() {
    const revision = ++verificationRevision.current;
    setVerifyState("verifying");
    setVerifyError("");
    try {
      const result = await verifyCredentials.mutateAsync({ platform: "onlyfans", username: username.trim() });
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
      const body: CreatePageBody = {
        platform: "onlyfans",
        username: username.trim(),
        modelSlug,
        label: label.trim(),
      };
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

  const canVerify = username.trim().length > 0;
  const canCreate = verifyState === "verified" &&
    label.trim().length > 0 &&
    modelSlug.length > 0;

  return (
    <ModalShell title="Добавить страницу OnlyFans" onClose={onClose}>
      <div className="space-y-5">
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
            placeholder="например, lora-of"
            autoComplete="off"
            spellCheck={false}
            className="input"
          />
        </Field>

        <section className="space-y-4 border-t border-border-light pt-5" aria-label="Аккаунт">
          <h3 className="card-title">Аккаунт</h3>
          <Field
            label="Имя пользователя на OnlyFans"
            hint="Сначала подключите этот аккаунт в OnlyFans API — Hub читает страницу через него, прокси и пароль здесь не нужны."
          >
            <input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                resetVerify();
              }}
              placeholder="например, devlora"
              autoComplete="off"
              spellCheck={false}
              className="input"
            />
          </Field>
        </section>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              disabled={!canVerify || verifyState === "verifying" || verifyState === "verified"}
              onClick={handleVerify}
              className="btn"
            >
              {verifyState === "verifying" ? "Проверяем…" : "Проверить аккаунт"}
            </button>
            {verifyState !== "verified" && verifyState !== "verify-failed" && (
              <span className="text-xs text-text-secondary">Hub найдёт этот аккаунт в OnlyFans API.</span>
            )}
          </div>
          {verifyState === "verified" && verifyResult && (
            <div role="status" className="notice notice-success">
              Аккаунт найден: @{verifyResult.username ?? "неизвестно"}
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
          <span className="mr-auto text-xs text-text-secondary">Создать можно после проверки аккаунта.</span>
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
