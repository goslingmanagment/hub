import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AdminAiAccount, AdminVoiceAccountResponse } from "@agency_hub_core/contracts";
import { sumMicroUsd } from "@agency_hub_core/shared";
import { useAdminAiAccounts, useAdminUpdateAiAccount, useAdminVoiceAccount } from "@/api/adminAiAccounts";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { RowMenu } from "@/components/ui/RowMenu";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatAiUsd, formatCount, formatDate, formatDateTime } from "@/lib/format";
import { AI_ACCOUNT_STATUS, VOICE_STATUS } from "@/lib/statusWords";
import { callsWord, daysLeftLabel } from "./aiShared.js";

const working = (account: AdminAiAccount) => account.enabled && account.configured && account.status === "active";

function accountStatus(account: AdminAiAccount) {
  if (!account.configured) return AI_ACCOUNT_STATUS.missing!;
  if (!account.enabled) return AI_ACCOUNT_STATUS.disabled!;
  if (account.status === "exhausted") return AI_ACCOUNT_STATUS.exhausted!;
  if (account.status === "invalid") return AI_ACCOUNT_STATUS.invalid!;
  return account.serving ? AI_ACCOUNT_STATUS.serving! : AI_ACCOUNT_STATUS.queued!;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The balance of an account and its form, in the row's own cell. */
function BalanceCell({ account, busy, editing, onEdit, onCancel, onSave }: {
  account: AdminAiAccount;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (microUsd: number) => void;
}) {
  const [draft, setDraft] = useState(() => (account.balance ? String(account.balance.estimatedMicroUsd / 1_000_000) : ""));
  if (editing) {
    // The same check and conversion as before the move: logic of the write, not of the look.
    const parsed = Number(draft.replace(",", ".").replace(/[$\s]/g, ""));
    const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
    return (
      <form
        className="ai-balance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSave(Math.round(parsed * 1_000_000));
        }}
      >
        <span className="ai-balance-label">Остаток {account.label} из консоли Anthropic</span>
        <span className="flex items-center justify-end gap-2">
          <span className="text-text-secondary">$</span>
          <input
            className="input w-28 text-right"
            inputMode="decimal"
            autoFocus
            aria-label={`Остаток счёта ${account.label} в консоли Anthropic, долларов`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={!valid || busy}>Сохранить</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Отмена</button>
        </span>
      </form>
    );
  }
  if (!account.balance) {
    return <button type="button" className="btn btn-sm" onClick={onEdit} disabled={busy}>Указать остаток</button>;
  }
  const { balance } = account;
  return (
    <div className="text-right">
      <button type="button" className="ai-balance" title="Изменить: введите остаток из консоли Anthropic" onClick={onEdit} disabled={busy}>
        ≈ {formatAiUsd(balance.estimatedMicroUsd)}
      </button>
      <div className={`ai-sub${balance.low ? " ai-warn" : ""}`}>
        {balance.estimatedMicroUsd === 0
          ? "по расчёту потрачен"
          : balance.daysLeft !== null && `хватит на ${daysLeftLabel(balance.daysLeft)}`}
        {balance.estimatedMicroUsd > 0 && balance.runsOutAt && `, до ${formatDateTime(balance.runsOutAt)}`}
      </div>
    </div>
  );
}

type Voice = AdminVoiceAccountResponse;
const VOICE_HINT: Readonly<Record<string, string>> = {
  healthy: "Ключ принят, подписка активна, символов хватает",
  characters_low: "Осталось меньше порога: пополните аккаунт или дождитесь сброса",
  characters_out: "Осталось меньше, чем нужно на одно голосовое: голосовые не создаются",
  subscription_inactive: "Продлите или оплатите подписку в ElevenLabs",
  key_rejected: "ElevenLabs не принимает ключ: замените его на сервере и перезапустите Hub",
  unreadable: "У ключа нет права читать аккаунт: Hub не видит символы и подписку",
  check_failed: "Сеть или ElevenLabs не ответили. Это не проблема аккаунта: Hub проверит снова через полчаса",
};

/** «Голосовые (ElevenLabs)»: the last line of the sheet, what the 30-minute check saw. */
function VoiceLine() {
  const query = useAdminVoiceAccount();
  const data: Voice | undefined = query.data;
  let content;
  if (!data) {
    content = query.isError
      ? <span className="text-text-secondary">Голосовые: Hub не ответил. <button type="button" className="link" onClick={() => void query.refetch()}>Повторить</button></span>
      : <span className="text-text-secondary">Проверяем…</span>;
  } else if (!data.configured) {
    content = <span className="text-text-secondary">Голосовые не настроены на сервере.</span>;
  } else if (!data.check) {
    content = (
      <span className="text-text-secondary">
        {data.enabled ? "Аккаунт ещё не проверялся: первая проверка в течение получаса." : "Голосовые выключены: Hub не проверяет аккаунт."}
      </span>
    );
  } else {
    const check = data.check;
    const left = check.charactersUsed !== null && check.charactersLimit !== null ? Math.max(0, check.charactersLimit - check.charactersUsed) : null;
    const word = VOICE_STATUS[check.state];
    const subscription = check.subscriptionStatus === null ? null : check.subscriptionStatus === "active" ? "активна" : check.subscriptionStatus;
    content = (
      <div className="min-w-0">
        <div className="ai-voice-main">
          {word && <StatusBadge status={word} title={VOICE_HINT[check.state]} />}
          {left !== null && <span>Осталось {formatCount(left)} символов из {formatCount(check.charactersLimit)}</span>}
          {check.nextResetAt && <span className="text-text-secondary">Сброс {formatDateTime(check.nextResetAt)}</span>}
        </div>
        <p className="ai-sub">
          {!data.enabled && "Голосовые выключены: Hub не проверяет аккаунт. Ниже последнее, что он видел. "}
          {check.tier !== null && `Тариф ${check.tier}`}
          {subscription !== null && `${check.tier !== null ? ", подписка" : "Подписка"} ${subscription}. `}
          {check.charactersUsed !== null && `Использовано ${formatCount(check.charactersUsed)}. `}
          {check.lowThresholdChars !== null && `Напишем в Telegram, когда останется меньше ${formatCount(check.lowThresholdChars)}. `}
          Проверено {formatDateTime(check.checkedAt)}
          {check.readAt !== null && check.readAt !== check.checkedAt && `, данные от ${formatDateTime(check.readAt)}`}.
        </p>
      </div>
    );
  }
  return (
    <div className="ai-voice">
      <span className="ai-voice-title">Голосовые (ElevenLabs)</span>
      {content}
    </div>
  );
}

/** «Деньги на ИИ»: what is left, how long it lasts, which account is spent; the queue's writes. */
export function AiMoneyBlock() {
  const { data, isLoading, refetch } = useAdminAiAccounts();
  const update = useAdminUpdateAiAccount();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [disabling, setDisabling] = useState<AdminAiAccount | null>(null);
  const [disableError, setDisableError] = useState<string | null>(null);

  // The write as it was: the target is the row's account, the body unchanged.
  const change = (accountId: number, body: Parameters<typeof update.mutate>[0]["body"], after?: () => void) => {
    setError(null);
    update.mutate({ accountId, body }, {
      onSuccess: () => after?.(),
      onError: (cause) => setError(errorText(cause)),
    });
  };

  let content;
  if (isLoading) {
    content = <TableSkeleton rows={3} columns={6} />;
  } else if (!data) {
    content = <div className="card-body"><NoAnswerPanel retry={refetch} /></div>;
  } else if (data.accounts.length === 0) {
    content = (
      <div className="card-body space-y-3">
        <p className="text-text-secondary">Ключи Anthropic не заданы на сервере.</p>
        <Disclosure label="Подробнее"><p>Hub читает ключи из переменных ANTHROPIC_API_KEYS или ANTHROPIC_API_KEY.</p></Disclosure>
      </div>
    );
  } else {
    const accounts = data.accounts;
    const workingAccounts = accounts.filter(working);
    const withBalance = workingAccounts.filter((account) => account.balance);
    const withoutBalance = workingAccounts.filter((account) => !account.balance);
    const left = sumMicroUsd(withBalance.map((account) => account.balance!.estimatedMicroUsd));
    const burn = data.dailyBurnMicroUsd;
    const days = burn > 0 && withBalance.length > 0 ? left / burn : null;
    const until = days !== null ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    content = (
      <>
        <div className="card-body pb-0">
          <StatGrid className="ai-strip">
            <Stat
              label="Осталось на счетах"
              value={withBalance.length > 0 ? `≈ ${formatAiUsd(left)}` : "—"}
              meta={withoutBalance.length > 0 ? `Без ${withoutBalance.map((account) => account.label).join(", ")}: остаток не указан` : "Ваш остаток минус траты Hub"}
            />
            <Stat
              label="Хватит на"
              value={days !== null ? daysLeftLabel(days) : "—"}
              meta={burn === 0
                ? "За 3 дня трат не было"
                : until
                  ? <span className={days !== null && days < data.balanceWarnDays ? "ai-warn" : undefined}>до {formatDate(until)}</span>
                  : "Остаток не указан"}
            />
            <Stat label="Уходит в день" value={formatAiUsd(burn)} meta="Среднее за 3 дня, все счета" />
          </StatGrid>
        </div>
        {error && (
          <div className="card-body pb-0">
            <Notice tone="warning" role="alert" detail={<Disclosure label="Подробнее"><p>{error}</p></Disclosure>}>
              Не удалось сохранить: Hub вернул ошибку. Значение прежнее.
            </Notice>
          </div>
        )}
        <div className="table-wrap mt-4">
          <table className="data-table" aria-label="Счета Anthropic">
            <thead>
              <tr>
                <th scope="col">Счёт</th>
                <th scope="col" className="num">За сутки</th>
                <th scope="col" className="num">За 7 дней</th>
                <th scope="col" className="num">За 30 дней</th>
                <th scope="col" className="num">Остаток</th>
                <th scope="col"><span className="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account, index) => {
                const expanded = open === account.id;
                const balance = account.balance;
                return (
                  <Fragment key={account.id}>
                    <tr className={account.enabled && account.configured ? undefined : "ai-muted-row"}>
                      <td>
                        <div className="ai-account">
                          <button
                            type="button"
                            className="home-expander"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Свернуть" : "Раскрыть"} счёт ${account.label}`}
                            onClick={() => setOpen(expanded ? null : account.id)}
                          >
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{account.label}</span>
                              <StatusBadge status={accountStatus(account)} />
                            </div>
                            {account.keyHint && <div className="ai-sub">ключ …{account.keyHint}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="num">
                        {formatAiUsd(account.spent.last24hMicroUsd)}
                        <div className="ai-sub">{callsWord(account.requests.last24h)}</div>
                      </td>
                      <td className="num">{formatAiUsd(account.spent.last7dMicroUsd)}</td>
                      <td className="num">{formatAiUsd(account.spent.last30dMicroUsd)}</td>
                      <td className="num">
                        <BalanceCell
                          key={`${account.id}-${editing === account.id}`}
                          account={account}
                          busy={update.isPending}
                          editing={editing === account.id}
                          onEdit={() => setEditing(account.id)}
                          onCancel={() => setEditing(null)}
                          onSave={(microUsd) => change(account.id, { balanceMicroUsd: microUsd }, () => setEditing(null))}
                        />
                      </td>
                      <td className="num">
                        <RowMenu
                          label={`Действия со счётом ${account.label}`}
                          items={[
                            { label: "Поднять в очереди", disabled: index === 0 || update.isPending, onSelect: () => change(account.id, { move: "up" }) },
                            { label: "Опустить в очереди", disabled: index === accounts.length - 1 || update.isPending, onSelect: () => change(account.id, { move: "down" }) },
                            { label: balance ? "Изменить остаток" : "Указать остаток", disabled: update.isPending, onSelect: () => setEditing(account.id) },
                            account.enabled
                              ? { label: "Выключить", danger: true, disabled: update.isPending || !account.configured, onSelect: () => { setDisableError(null); setDisabling(account); } }
                              : { label: "Включить", disabled: update.isPending || !account.configured, hint: account.configured ? undefined : "Ключа этого счёта нет на сервере", onSelect: () => change(account.id, { enabled: true }) },
                          ]}
                        />
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="row-detail">
                        <td colSpan={6}>
                          <div className="row-detail-body">
                            <KeyValue
                              rows={[
                                { label: "Ввели вы", value: balance ? `${formatDateTime(balance.readAt)}: ${formatAiUsd(balance.readMicroUsd)}` : null },
                                { label: "Потрачено с тех пор", value: balance ? formatAiUsd(balance.spentSinceMicroUsd) : null },
                                ...(balance?.provider ? [{
                                  label: "По счёту Anthropic",
                                  value: `≈ ${formatAiUsd(balance.provider.estimatedMicroUsd)}${balance.provider.runsOutAt && balance.provider.estimatedMicroUsd > 0 ? `, до ${formatDateTime(balance.provider.runsOutAt)}` : ""}`,
                                }] : []),
                                { label: "Последний вызов", value: account.lastUsedAt ? formatDateTime(account.lastUsedAt) : null },
                                { label: "Состояние с", value: account.statusChangedAt ? formatDateTime(account.statusChangedAt) : null },
                              ]}
                            />
                            {account.statusReason && <Disclosure label="Подробнее"><p>{account.statusReason}</p></Disclosure>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <VoiceLine />
        {data.unattributed30dMicroUsd > 0 && (
          <div className="card-footer justify-start">
            Ещё {formatAiUsd(data.unattributed30dMicroUsd)} за 30 дней потрачено до того, как Hub начал отмечать счёт.
          </div>
        )}
      </>
    );
  }

  const others = data?.accounts.filter((account) => account.id !== disabling?.id && working(account)) ?? [];
  const order = data?.accounts ?? [];
  const at = disabling ? order.findIndex((account) => account.id === disabling.id) : -1;
  const next = disabling ? [...order.slice(at + 1), ...order.slice(0, at)].find(working) ?? null : null;

  return (
    <section className="card" aria-labelledby="ai-money-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="ai-money-title" className="card-title">Деньги на ИИ<span className="ai-subtitle-note">сейчас</span></h2>
          <p className="card-description">
            Hub тратит счета по очереди. Кончились деньги — сам переходит к следующему. Остаток Anthropic не сообщает: его
            вводите вы, Hub вычитает свои траты.
          </p>
        </div>
      </div>
      {content}
      {disabling && (
        <ConfirmModal
          title={`Выключить счёт ${disabling.label}?`}
          message={others.length === 0
            ? "Других рабочих счетов нет: ИИ перестанет работать у всех чаттеров."
            : disabling.serving && next
              ? `Hub сразу перейдёт на счёт ${next.label}.`
              : "Hub будет пропускать этот счёт в очереди."}
          facts={[
            { label: "Какой счёт", value: `${disabling.label}${disabling.keyHint ? `, ключ …${disabling.keyHint}` : ""}` },
            { label: "Сейчас", value: `${accountStatus(disabling).word}${disabling.balance ? `, остаток ≈ ${formatAiUsd(disabling.balance.estimatedMicroUsd)}` : ""}` },
            { label: "Дальше тратится", value: next?.label ?? "ничего" },
            { label: "Отменить", value: "Можно: «Включить» в этой же строке" },
          ]}
          confirmLabel={`Выключить ${disabling.label}`}
          pendingLabel="Выключаем…"
          tone={others.length === 0 ? "danger" : "primary"}
          initialFocus={others.length === 0 ? "cancel" : "first"}
          error={disableError ? <>Не удалось сохранить: Hub вернул ошибку. Значение прежнее. <span className="text-text-secondary">{disableError}</span></> : undefined}
          isPending={update.isPending}
          onConfirm={() => update.mutate({ accountId: disabling.id, body: { enabled: false } }, {
            onSuccess: () => setDisabling(null),
            onError: (cause) => setDisableError(errorText(cause)),
          })}
          onClose={() => setDisabling(null)}
        />
      )}
    </section>
  );
}
