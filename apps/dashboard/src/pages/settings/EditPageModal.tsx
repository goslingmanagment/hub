import { useState } from "react";
import { Link } from "react-router";
import type { AssignedPage, ModelListItem, UpdatePageBody } from "@agency_hub_core/contracts";
import { useAdminConfig } from "@/api/adminConfig";
import { useAdminUpdatePage } from "@/api/queries";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { Spinner } from "@/components/ui/Skeleton";
import { toast } from "sonner";
import { pageLabelUses, PAGE_LABEL_KEYS } from "./pages/pageLabelUses.js";
import { PLATFORM_NAMES } from "./pages/pagesView.js";
import { isConflict, toastWriteError } from "./settingsFeedback.js";

/**
 * «Изменить страницу»: the name and the model; the platform is fixed. The body
 * holds only what changed, nothing changed sends nothing. A new name takes a
 * second step that names the parameters still holding the old one: Hub does not
 * rewrite them, and the extension on the page would quietly lose its functions.
 * The target is the row's page (the path's `pageLabel`).
 */
export function EditPageModal({
  page,
  models,
  onClose,
}: {
  page: AssignedPage;
  models: ModelListItem[];
  onClose: () => void;
}) {
  const updatePage = useAdminUpdatePage(page.label);
  const config = useAdminConfig();
  const [label, setLabel] = useState(page.label);
  const [modelSlug, setModelSlug] = useState(page.modelSlug);
  const [step, setStep] = useState<"form" | "rename">("form");
  const [conflict, setConflict] = useState(false);

  const newLabel = label.trim();
  const renamed = newLabel !== page.label;
  const moved = modelSlug !== page.modelSlug;
  const modelName = (slug: string) => models.find((model) => model.slug === slug)?.name ?? slug;

  function body(): UpdatePageBody {
    const next: UpdatePageBody = {};
    if (renamed) next.label = newLabel;
    if (moved) next.modelSlug = modelSlug;
    return next;
  }

  async function save() {
    const next = body();
    if (!next.label && !next.modelSlug) {
      onClose();
      return;
    }
    try {
      await updatePage.mutateAsync(next);
      toast.success("Страница сохранена");
      onClose();
    } catch (error) {
      if (isConflict(error)) {
        setConflict(true);
        setStep("form");
      } else {
        toastWriteError(error, "Не удалось сохранить страницу");
      }
    }
  }

  function submitForm() {
    if (renamed) setStep("rename");
    else void save();
  }

  const close = () => { if (!updatePage.isPending) onClose(); };

  if (step === "rename") {
    const uses = config.data ? pageLabelUses(config.data, page.label) : null;
    return (
      <ModalShell title={`Переименовать ${page.label} в ${newLabel}?`} onClose={close} size="confirm">
        <p className="dialog-text">Старое имя перестанет работать в ссылках и закладках. Hub не поправит параметры, где оно записано.</p>
        <dl className="confirm-facts">
          <dt>Где записано</dt>
          <dd>
            {uses === null ? (
              `Не удалось проверить параметры. Имя могут хранить: ${PAGE_LABEL_KEYS.slice(0, 4).map((entry) => entry.name).join(", ")}`
            ) : uses.length === 0 ? (
              "Нигде: параметры его не называют"
            ) : (
              <ul className="settings-fact-list">
                {uses.map((use) => (
                  <li key={use.key}><Link to={use.to} className="link" target="_blank" rel="noopener">{use.name}</Link></li>
                ))}
              </ul>
            )}
          </dd>
          {(uses === null || uses.length > 0) && (
            <>
              <dt>Что будет</dt>
              <dd>Пока вы не поправите эти параметры, функции на новом имени не работают. В расширении страница останется без функций.</dd>
            </>
          )}
          {moved && (
            <>
              <dt>Модель</dt>
              <dd>{page.modelName} → {modelName(modelSlug)}</dd>
            </>
          )}
          <dt>Отменить</dt>
          <dd>Можно: переименуйте обратно</dd>
        </dl>
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={updatePage.isPending} onClick={() => setStep("form")} data-autofocus>Назад</button>
          <button type="button" className="btn btn-primary" disabled={updatePage.isPending} onClick={() => void save()}>
            {updatePage.isPending && <Spinner />}
            {updatePage.isPending ? "Сохраняем…" : "Переименовать"}
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`Изменить страницу ${page.label}`} onClose={close}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{PLATFORM_NAMES[page.platform] ?? page.platform}. Площадку страницы изменить нельзя.</p>
        <Field label="Название страницы" error={conflict ? "Страница с таким названием уже есть." : undefined}>
          <input
            value={label}
            aria-invalid={conflict}
            onChange={(event) => { setLabel(event.target.value); setConflict(false); }}
            autoComplete="off"
            spellCheck={false}
            className="input"
          />
        </Field>
        <Field label="Модель">
          <select
            value={modelSlug}
            onChange={(event) => setModelSlug(event.target.value)}
            className="select"
          >
            {models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        {(renamed || moved) && newLabel && (
          <dl className="confirm-facts">
            {renamed && (
              <>
                <dt>Было → стало</dt>
                <dd>{page.label} → {newLabel}</dd>
              </>
            )}
            {moved && (
              <>
                <dt>Модель</dt>
                <dd>{page.modelName} → {modelName(modelSlug)}</dd>
              </>
            )}
          </dl>
        )}
      </div>

      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={updatePage.isPending} className="btn">
          Отмена
        </button>
        <button
          type="button"
          disabled={updatePage.isPending || !newLabel}
          onClick={submitForm}
          className="btn btn-primary"
        >
          {updatePage.isPending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </ModalShell>
  );
}
