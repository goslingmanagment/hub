import type { AdminVoiceAccountResponse } from "@agency_hub_core/contracts";

import { useAdminVoiceAccount } from "@/api/adminAiAccounts";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";

type VoiceAccountCheck = NonNullable<AdminVoiceAccountResponse["check"]>;

function chars(value: number): string {
  return value.toLocaleString("ru-RU");
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATE_BADGES: Record<VoiceAccountCheck["state"], { label: string; className: string; title: string }> = {
  healthy: {
    label: "в порядке",
    className: "badge badge-success",
    title: "Ключ принят, подписка активна, символов хватает",
  },
  characters_low: {
    label: "символы на исходе",
    className: "badge badge-warning",
    title: "Осталось меньше порога: пополните аккаунт или дождитесь сброса",
  },
  characters_out: {
    label: "символы кончились",
    className: "badge badge-danger",
    title: "Осталось меньше, чем нужно на одно голосовое: голосовые не создаются",
  },
  subscription_inactive: {
    label: "подписка не активна",
    className: "badge badge-danger",
    title: "Продлите или оплатите подписку в ElevenLabs",
  },
  key_rejected: {
    label: "ключ не принят",
    className: "badge badge-danger",
    title: "ElevenLabs не принимает ELEVENLABS_API_KEY: замените ключ на сервере и перезапустите хаб",
  },
  unreadable: {
    label: "ключ не видит аккаунт",
    className: "badge badge-warning",
    title: "У ключа нет права читать аккаунт (user_read): хаб не видит символы и подписку",
  },
  check_failed: {
    label: "проверка не удалась",
    className: "badge",
    title: "Сеть или ElevenLabs не ответили. Это не проблема аккаунта: хаб проверит снова через полчаса",
  },
};

function CheckTable({ check, enabled }: { check: VoiceAccountCheck; enabled: boolean }) {
  const badge = STATE_BADGES[check.state];
  const left = check.charactersUsed !== null && check.charactersLimit !== null
    ? Math.max(0, check.charactersLimit - check.charactersUsed)
    : null;
  const failedTitle = check.httpStatus !== null && check.httpStatus > 0
    ? `${badge.title} (HTTP ${check.httpStatus})`
    : badge.title;

  return (
    <>
      {!enabled && (
        <div role="status" className="notice notice-warning mx-4 mt-3">
          Голосовые выключены — хаб не проверяет аккаунт. Ниже последнее, что он видел.
        </div>
      )}
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Аккаунт</th>
              <th className="num">Использовано</th>
              <th className="num">Осталось</th>
              <th className="num">Сброс символов</th>
              <th className="num">Проверено</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="min-w-56">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">ElevenLabs</span>
                  <span className={badge.className} title={failedTitle}>{badge.label}</span>
                </div>
                {(check.tier !== null || check.subscriptionStatus !== null) && (
                  <div className="whitespace-nowrap text-xs text-text-muted">
                    {check.tier !== null && `тариф ${check.tier}`}
                    {check.tier !== null && check.subscriptionStatus !== null && " · "}
                    {check.subscriptionStatus !== null && `подписка ${check.subscriptionStatus}`}
                  </div>
                )}
              </td>
              <td className="num">
                {check.charactersUsed !== null && check.charactersLimit !== null
                  ? `${chars(check.charactersUsed)} из ${chars(check.charactersLimit)}`
                  : "—"}
              </td>
              <td className="num">
                <span className="font-semibold tabular-nums">{left !== null ? chars(left) : "—"}</span>
                {check.lowThresholdChars !== null && (
                  <div className="whitespace-nowrap text-xs text-text-muted">
                    напишем в Telegram, когда меньше {chars(check.lowThresholdChars)}
                  </div>
                )}
              </td>
              <td className="num whitespace-nowrap">{check.nextResetAt ? dateTime(check.nextResetAt) : "—"}</td>
              <td className="num">
                <span className="whitespace-nowrap">{dateTime(check.checkedAt)}</span>
                {check.readAt !== null && check.readAt !== check.checkedAt && (
                  <div className="whitespace-nowrap text-xs text-text-muted">
                    данные от {dateTime(check.readAt)}
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The ElevenLabs account behind voice notes: what Hub's 30-min check last
 * saw — characters used and left, the reset, the state. */
export function VoiceAccountSection() {
  const { data, isLoading, isError, refetch, isFetching } = useAdminVoiceAccount();

  let content;
  if (isLoading) {
    content = <TableSkeleton rows={1} columns={5} />;
  } else if (isError && !data) {
    content = (
      <StatusPanel
        title="Не удалось загрузить аккаунт ElevenLabs"
        description="Сервер не ответил."
        tone="error"
        action={<button type="button" className="btn btn-sm" onClick={() => void refetch()} disabled={isFetching}>Повторить</button>}
      />
    );
  } else if (!data || !data.configured) {
    content = (
      <p className="muted px-4 py-6 text-sm">
        Голосовые не настроены: на сервере нет ELEVENLABS_API_KEY или сервисного прокси.
      </p>
    );
  } else if (!data.check) {
    content = (
      <p className="muted px-4 py-6 text-sm">
        {data.enabled
          ? "Аккаунт ещё не проверялся: первая проверка — в течение получаса."
          : "Голосовые выключены — хаб не проверяет аккаунт."}
      </p>
    );
  } else {
    content = <CheckTable check={data.check} enabled={data.enabled} />;
  }

  return (
    <section aria-labelledby="voice-account-title" className="card">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="voice-account-title" className="card-title">ElevenLabs — голосовые</h2>
          <p className="card-description">
            Пока голосовые включены, хаб каждые полчаса смотрит аккаунт и пишет в Telegram, если ключ не принят,
            подписка не активна или символы на исходе.
          </p>
        </div>
      </div>
      {content}
    </section>
  );
}
