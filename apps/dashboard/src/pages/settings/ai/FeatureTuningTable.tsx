import { useState } from "react";
import { Link } from "react-router";
import type { ConfigViewResponse } from "@agency_hub_core/contracts";
import { AI_SETTINGS_FEATURES, type AiSettingsFeature } from "@agency_hub_core/shared";
import { Notice } from "@/components/ui/Notice";
import { RowMenu } from "@/components/ui/RowMenu";
import { formatAiUsd } from "@/lib/format";
import type { TuningKind } from "./featureSettingPatch.js";
import { TUNING_KEYS } from "./featureSettingPatch.js";
import { FeatureSettingWindow } from "./FeatureSettingWindow.js";
import { featureCeilings, FEATURE_BUTTONS, FOLLOWS_REPLY, tuningFeatureName, tuningKey, valueWord } from "./tuningView.js";

const KIND_WORD: Readonly<Record<TuningKind, string>> = { model: "модель", effort: "усилие", window: "окно" };

/**
 * «Модель, усилие и окно»: a row per AI feature, what it runs on now. Each value
 * changes in its own window, one key, one request (design/screens/settings.md §4.4).
 */
export function FeatureTuningTable({ data, stale }: { data: ConfigViewResponse; stale: boolean }) {
  const [editing, setEditing] = useState<{ kind: TuningKind; feature: AiSettingsFeature } | null>(null);
  const keys = {
    model: tuningKey(data, "model", stale),
    effort: tuningKey(data, "effort", stale),
    window: tuningKey(data, "window", stale),
  };
  const ceilings = featureCeilings(data);
  const ownOf = (kind: TuningKind, feature: AiSettingsFeature) => keys[kind].values?.[feature];
  const followers = (kind: TuningKind) => [...FOLLOWS_REPLY].filter((feature) => ownOf(kind, feature) === undefined);

  /** A model or an effort: its own, or Reply's for Fix, Hi and Voice, or the default. */
  function Value({ kind, feature }: { kind: "model" | "effort"; feature: AiSettingsFeature }) {
    if (keys[kind].values === null) return <span className="muted">—</span>;
    const own = ownOf(kind, feature);
    if (own !== undefined) return <>{valueWord(kind, own)}</>;
    const reply = FOLLOWS_REPLY.has(feature) ? ownOf(kind, "fast-reply") : undefined;
    if (reply !== undefined) return <>{valueWord(kind, reply)}<span className="settings-second">как у Reply</span></>;
    return <span className="muted">По умолчанию</span>;
  }

  const blocks = (["model", "effort", "window"] as const).filter((kind) => keys[kind].blocked !== null);
  const pending = (["model", "effort", "window"] as const).some((kind) => keys[kind].item?.pendingApply);
  const editingItem = editing ? keys[editing.kind].item : undefined;

  return (
    <section className="card" id="tuning" aria-labelledby="tuning-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="tuning-title" className="card-title">Модель, усилие и окно</h2>
          <p className="card-description">Какая модель отвечает в каждой функции, сколько она думает и сколько сообщений читает.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table settings-tuning-table">
          <thead>
            <tr>
              <th>Функция</th>
              <th>Модель</th>
              <th>Усилие</th>
              <th className="num">Окно, сообщений</th>
              <th className="num">Потолок в день</th>
              <th><span className="sr-only">Действия</span></th>
            </tr>
          </thead>
          <tbody>
            {AI_SETTINGS_FEATURES.map((feature) => {
              const name = tuningFeatureName(feature);
              const windowOwn = ownOf("window", feature);
              const ceiling = ceilings === null ? undefined : ceilings[feature];
              const item = (kind: TuningKind, label: string) => ({
                label,
                disabled: keys[kind].blocked !== null,
                hint: keys[kind].blocked ?? undefined,
                onSelect: () => setEditing({ kind, feature }),
              });
              return (
                <tr key={feature}>
                  <td>
                    <div className="font-medium">{name}</div>
                    <div className="settings-second">{FEATURE_BUTTONS[feature]}</div>
                  </td>
                  <td><Value kind="model" feature={feature} /></td>
                  <td><Value kind="effort" feature={feature} /></td>
                  <td className="num">
                    {keys.window.values === null ? <span className="muted">—</span> : windowOwn !== undefined ? windowOwn : <span className="muted settings-wrap">Как просит расширение</span>}
                  </td>
                  <td className="num">
                    {ceilings === null ? <span className="muted">—</span> : ceiling === undefined ? <span className="muted">нет</span> : formatAiUsd(ceiling)}
                  </td>
                  <td>
                    <div className="settings-actions">
                      <RowMenu
                        label={`Настройки: ${name}`}
                        items={[item("model", "Изменить модель"), item("effort", "Изменить усилие"), item("window", "Изменить окно")]}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(blocks.length > 0 || pending) && (
        <div className="card-footer settings-notices">
          {pending && <Notice>Сохранено. Ждём, пока настройку подхватят все части Hub, обычно до минуты.</Notice>}
          {blocks.length > 0 && (
            <Notice tone="warning" role="status">
              Править здесь сейчас нельзя: {[...new Set(blocks.map((kind) => keys[kind].blocked!.toLowerCase()))].join("; ")}.
              Значения видны во «Всех параметрах»:{" "}
              {blocks.map((kind, index) => (
                <span key={kind}>
                  <Link className="link" to={`/system/dev/config#config-${TUNING_KEYS[kind]}`}>{KIND_WORD[kind]}</Link>
                  {index < blocks.length - 1 ? ", " : "."}
                </span>
              ))}
            </Notice>
          )}
        </div>
      )}
      {editing && editingItem && (
        <FeatureSettingWindow
          kind={editing.kind}
          feature={editing.feature}
          item={editingItem}
          followers={followers(editing.kind)}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
