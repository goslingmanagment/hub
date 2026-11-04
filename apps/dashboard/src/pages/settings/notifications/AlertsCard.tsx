import { useState } from "react";
import { Link } from "react-router";
import type { NotificationsSettingsResponse } from "@agency_hub_core/contracts";
import { useUpdateNotificationsSettings } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Switch } from "@/components/ui/Switch";
import { toastError } from "../settingsFeedback.js";

/**
 * What failures are sent. «Сбои, кроме ИИ» is honest about what it covers: the
 * old «Сбои сбора данных» switched off everything but the AI. Switching it off
 * asks first; the AI and voice switch acts at once, as it did.
 */
export function AlertsCard({ settings, writesUnavailable, update, muted }: {
  settings: NotificationsSettingsResponse;
  writesUnavailable: boolean;
  update: ReturnType<typeof useUpdateNotificationsSettings>;
  muted: boolean;
}) {
  const [confirmOff, setConfirmOff] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  function set(field: "syncFailureAlertsEnabled" | "aiCriticalAlertsEnabled", value: boolean, fromConfirm = false) {
    if (writesUnavailable) return;
    setConfirmError(null);
    update.mutate({ [field]: value }, {
      onSuccess: () => setConfirmOff(false),
      onError: () => {
        if (fromConfirm) setConfirmError("Настройка не сохранилась. Оповещения о сбоях остались включены.");
        else toastError("Настройка не сохранилась");
      },
    });
  }

  return (
    <section className={`card ${muted ? "settings-muted" : ""}`} aria-labelledby="alerts-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="alerts-title" className="card-title">Оповещения о сбоях</h2>
          <p className="card-description">Сбои видны на экране «Сбои», даже если сообщения выключены.</p>
        </div>
      </div>
      <div className="settings-card-switches">
        <div className="switch-row settings-switch-row">
          <div className="switch-text">
            <span className="font-medium">Сбои, кроме ИИ</span>
            <small>Сбор данных и вход в Fansly, публикации («Пост не вышел»), письма OnlyFans странице, база данных, вкладка ChatSpace. Сообщение при открытии и закрытии сбоя и сводка раз в сутки.</small>
          </div>
          <div className="switch-control">
            {settings.syncFailureAlertsEnabled ? "Включены" : "Выключены"}
            <Switch
              checked={settings.syncFailureAlertsEnabled}
              label="Сбои, кроме ИИ"
              disabled={writesUnavailable}
              onChange={(next) => {
                if (next) set("syncFailureAlertsEnabled", true);
                else { setConfirmError(null); setConfirmOff(true); }
              }}
            />
          </div>
        </div>
        <div className="switch-row settings-switch-row">
          <div className="switch-text">
            <span className="font-medium">Сбои ИИ и голоса</span>
            <small>Оплата и отказы поставщика ИИ, голосовой сервис ElevenLabs. Сообщение при открытии и закрытии.</small>
          </div>
          <div className="switch-control">
            {settings.aiCriticalAlertsEnabled ? "Включены" : "Выключены"}
            <Switch
              checked={settings.aiCriticalAlertsEnabled}
              label="Сбои ИИ и голоса"
              disabled={writesUnavailable}
              onChange={(next) => set("aiCriticalAlertsEnabled", next)}
            />
          </div>
        </div>
      </div>
      <div className="card-footer">
        <Link to="/system/failures" className="link">Посмотреть сбои</Link>
      </div>

      {confirmOff && (
        <ConfirmModal
          title="Выключить оповещения о сбоях, кроме ИИ?"
          message="Перестанут приходить вход в Fansly, «Пост не вышел», письма OnlyFans странице и база данных. По правилам OnlyFans поздний ответ на письмо может заморозить доход страницы. Сбои останутся на экране «Сбои»."
          facts={[{ label: "Отменить", value: "Можно: включите обратно" }]}
          confirmLabel="Выключить"
          pendingLabel="Выключаем…"
          tone="primary"
          error={confirmError ?? undefined}
          isPending={update.isPending}
          onConfirm={() => set("syncFailureAlertsEnabled", false, true)}
          onClose={() => setConfirmOff(false)}
        />
      )}
    </section>
  );
}
