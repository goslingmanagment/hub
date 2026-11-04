import { useState } from "react";
import { useNavigate } from "react-router";
import type { AdminAiPersonaCreateBody } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useAdminCreateAiPersona } from "@/api/queries";
import { Field } from "@/components/shared/Field";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Skeleton";
import { isConflict, isUnknownOutcome } from "../settingsFeedback.js";
import { DISPLAY_NAME_MAX, PERSONA_KEY_PATTERN, PersonaFields, useLeaveGuard } from "./PersonaFields.js";
import { personaRoute } from "./PersonasPage.js";

/**
 * A new persona: a page, not a window, because the instruction is long. The key
 * stands before the big text now, where it cannot be missed (design/screens/settings.md §3.6).
 */
export function NewPersonaPage() {
  const navigate = useNavigate();
  const create = useAdminCreateAiPersona();
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [systemBlock, setSystemBlock] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<"taken" | "refused" | "unknown" | null>(null);
  const [created, setCreated] = useState(false);

  const keyValid = PERSONA_KEY_PATTERN.test(key.trim());
  const filled = key.trim() !== "" && displayName.trim() !== "" && /\S/.test(systemBlock);
  const dirty = !created && (key !== "" || displayName !== "" || systemBlock !== "");
  const leaveGuard = useLeaveGuard(dirty, displayName.trim() || "Новая персона");

  async function handleSubmit() {
    setTouched(true);
    if (!keyValid) return;
    setError(null);
    const body: AdminAiPersonaCreateBody = {
      key: key.trim(),
      displayName: displayName.trim(),
      systemBlock,
    };
    try {
      await create.mutateAsync(body);
      setCreated(true);
      toast.success("Персона добавлена");
      // The guard reads `created` after this render: leave on the next tick.
      window.setTimeout(() => navigate(personaRoute(body.key)), 0);
    } catch (cause) {
      setError(isConflict(cause) ? "taken" : isUnknownOutcome(cause) ? "unknown" : "refused");
    }
  }

  const keyError = error === "taken"
    ? "Персона с таким внутренним именем уже есть."
    : touched && key.trim() !== "" && !keyValid
      ? "Только латинские буквы, цифры, двоеточие, дефис или подчёркивание; первым — буква или цифра."
      : undefined;

  return (
    <>
      <PageHeader
        title="Новая персона"
        description="Новый образ для ответов ИИ."
        actions={(
          <button type="button" className="btn btn-primary" disabled={!filled || create.isPending} onClick={() => void handleSubmit()}>
            {create.isPending && <Spinner />}
            {create.isPending ? "Сохраняем…" : "Добавить персону"}
          </button>
        )}
      />
      <div className="stack">
        {error === "refused" && <Notice tone="danger" role="alert">Не сохранено: Hub не принял персону. Введённое осталось на экране.</Notice>}
        {error === "unknown" && (
          <Notice tone="danger" role="alert">Hub не ответил: неизвестно, сохранилось ли. Введённое осталось на экране. Проверьте список персон, прежде чем добавлять снова.</Notice>
        )}
        <PersonaFields
          displayName={displayName}
          systemBlock={systemBlock}
          touched={touched}
          onDisplayNameChange={setDisplayName}
          onSystemBlockChange={setSystemBlock}
          between={(
            <Field
              label="Внутреннее имя"
              hint="Латинские буквы, цифры, двоеточие, дефис или подчёркивание. По нему приложения узнают персону, изменить его потом нельзя."
              error={keyError}
            >
              <input
                value={key}
                maxLength={DISPLAY_NAME_MAX}
                aria-invalid={keyError !== undefined}
                onChange={(event) => { setKey(event.target.value); if (error === "taken") setError(null); }}
                placeholder="например, custom:milly"
                autoComplete="off"
                spellCheck={false}
                className="input"
              />
            </Field>
          )}
        />
      </div>
      {leaveGuard}
    </>
  );
}
