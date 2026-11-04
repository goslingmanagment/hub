import { useState } from "react";
import type { ConfigItem } from "@agency_hub_core/contracts";
import { AI_SETTINGS_EFFORTS, AI_SETTINGS_MODELS, AI_SETTINGS_WINDOW_MAX, type AiSettingsFeature } from "@agency_hub_core/shared";
import { toast } from "sonner";
import { useUpdateConfig } from "@/api/adminConfig";
import { ModalShell } from "@/components/shared/ModalShell";
import { Field } from "@/components/shared/Field";
import { Notice } from "@/components/ui/Notice";
import { Spinner } from "@/components/ui/Skeleton";
import { CONFIG_COPY_RU } from "../configCopyRu.js";
import { captureConfigSnapshot, configSnapshotChanged, type ConfigSnapshot } from "../ConfigurationEditors.js";
import { errorStatus, isConflict, isUnknownOutcome, UNKNOWN_OUTCOME } from "../settingsFeedback.js";
import { featureSettingPatch, parseTuning, type TuningKind } from "./featureSettingPatch.js";
import { FEATURE_BUTTONS, FOLLOWS_REPLY, tuningFeatureName, valueWord } from "./tuningView.js";

const KIND_NOUN: Readonly<Record<TuningKind, string>> = { model: "Модель", effort: "Усилие", window: "Окно" };
const KIND_VERB: Readonly<Record<TuningKind, string>> = { model: "Изменить модель", effort: "Изменить усилие", window: "Изменить окно" };

/**
 * One value of one feature: the model, the effort or the window. The window keeps
 * the version it was opened with; a refresh never moves it. Step one picks, step two
 * says what was and what will be, then one request of the same `adminConfigUpdate`.
 */
export function FeatureSettingWindow({ kind, feature, item, followers, onClose }: {
  kind: TuningKind;
  feature: AiSettingsFeature;
  /** The live row: compared with the snapshot before the write. */
  item: ConfigItem;
  /** Features without their own value that follow Reply now. */
  followers: readonly AiSettingsFeature[];
  onClose: () => void;
}) {
  const update = useUpdateConfig();
  const [snapshot] = useState<ConfigSnapshot>(() => captureConfigSnapshot(item));
  const opened = parseTuning(kind, snapshot.value) ?? {};
  const own = opened[feature];
  const follows = FOLLOWS_REPLY.has(feature) && kind !== "window";
  const [choice, setChoice] = useState<string>(own === undefined ? "" : String(own));
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [moved, setMoved] = useState(false);

  const name = tuningFeatureName(feature);
  const windowValue = choice.trim() === "" ? null : Number(choice);
  const windowValid = kind !== "window" || windowValue === null || (Number.isInteger(windowValue) && windowValue >= 1 && windowValue <= AI_SETTINGS_WINDOW_MAX);
  const next: string | number | null = choice === "" ? null : kind === "window" ? windowValue : choice;
  const changed = (own === undefined ? null : own) !== next;
  const defaultWord = kind === "window" ? "Как просит расширение" : follows ? "Как у Reply" : "По умолчанию";

  const shown = (value: string | number | null | undefined) => (value === null || value === undefined ? defaultWord : valueWord(kind, value));
  const reach = feature === "fast-reply" && kind !== "window"
    ? followers.length > 0
      ? `${name} и все, кто следует за Reply: ${followers.map((entry) => FEATURE_BUTTONS[entry]).join(", ")}`
      : `${name}; Fix, Hi и Voice заданы отдельно`
    : "Только эту функцию";

  function send() {
    // The row changed since the window opened: nothing is sent.
    if (configSnapshotChanged(snapshot, item)) {
      setMoved(true);
      return;
    }
    const body = featureSettingPatch(snapshot, kind, feature, next);
    if (body === null) {
      setMoved(true);
      return;
    }
    update.mutate(body, {
      onSuccess: () => {
        toast.success(`Сохранено: ${name}, ${shown(next)}`);
        onClose();
      },
    });
  }

  const conflict = moved || (update.error !== null && isConflict(update.error));
  const failure = update.error && !isConflict(update.error)
    ? isUnknownOutcome(update.error) ? `${UNKNOWN_OUTCOME} Закройте окно и посмотрите таблицу.` : errorStatus(update.error) === 400 ? "Hub не принял значение." : "Не получилось. Hub вернул ошибку."
    : null;
  const close = () => { if (!update.isPending) onClose(); };

  if (step === "confirm") {
    return (
      <ModalShell title={`${KIND_VERB[kind]}: ${name}?`} onClose={close} size="confirm">
        <dl className="confirm-facts">
          <dt>Было → стало</dt>
          <dd>{shown(own)} → {shown(next)}</dd>
          <dt>Цена</dt>
          <dd>{CONFIG_COPY_RU[item.key]?.warning ?? "Влияет на расходы."}</dd>
          <dt>Кого затронет</dt>
          <dd>{reach}</dd>
          <dt>Когда</dt>
          <dd>Со следующего запроса ИИ, у всех чаттеров</dd>
          <dt>Отменить</dt>
          <dd>Можно: верните прежнее значение здесь же</dd>
        </dl>
        {conflict && <Notice tone="warning" role="alert">Пока вы выбирали, настройку изменили. Закройте окно и проверьте новое значение.</Notice>}
        {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
        <div className="dialog-actions">
          {conflict || failure ? (
            <button type="button" className="btn" onClick={close} data-autofocus>Закрыть</button>
          ) : (
            <>
              <button type="button" className="btn" disabled={update.isPending} onClick={() => setStep("pick")}>Назад</button>
              <button type="button" className="btn btn-primary" disabled={update.isPending} onClick={send}>
                {update.isPending && <Spinner />}
                {update.isPending ? "Сохраняем…" : KIND_VERB[kind]}
              </button>
            </>
          )}
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`${KIND_NOUN[kind]}: ${name}`} onClose={close} size="confirm">
      <div className="space-y-4">
        {kind === "window" ? (
          <Field
            label="Сколько последних сообщений читает функция"
            hint={`От 1 до ${AI_SETTINGS_WINDOW_MAX.toLocaleString("ru-RU")}. Пусто: как просит расширение.`}
            error={windowValid ? undefined : `Нужно целое число от 1 до ${AI_SETTINGS_WINDOW_MAX.toLocaleString("ru-RU")}.`}
          >
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={AI_SETTINGS_WINDOW_MAX}
              className="input tabular-nums"
              value={choice}
              aria-invalid={!windowValid}
              placeholder="Как просит расширение"
              onChange={(event) => setChoice(event.target.value)}
            />
          </Field>
        ) : (
          <Field label={KIND_NOUN[kind]}>
            <select className="select" value={choice} onChange={(event) => setChoice(event.target.value)}>
              <option value="">{defaultWord}</option>
              {(kind === "model" ? AI_SETTINGS_MODELS : AI_SETTINGS_EFFORTS).map((value) => (
                <option key={value} value={value}>{valueWord(kind, value)}</option>
              ))}
            </select>
          </Field>
        )}
        <p className="settings-second">Сейчас: {shown(own)}</p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={close}>Отмена</button>
        <button type="button" className="btn btn-primary" disabled={!changed || !windowValid} onClick={() => { update.reset(); setStep("confirm"); }}>
          Дальше
        </button>
      </div>
    </ModalShell>
  );
}
