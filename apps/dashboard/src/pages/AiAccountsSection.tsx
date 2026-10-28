import { useState } from "react";
import type { AdminAiAccount } from "@agency_hub_core/contracts";

import { useAdminAiAccounts, useAdminUpdateAiAccount } from "@/api/adminAiAccounts";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { ruPlural } from "@/lib/plural";

function usd(microUsd: number): string {
  const value = microUsd / 1_000_000;
  if (microUsd > 0 && value < 0.01) {
    return "< $0.01";
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** When a balance runs out: "3 нояб., 14:00". */
function runsOutLabel(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "~6 дней", "~1,5 дня": whole days from two on, one decimal below. */
function daysLeftLabel(value: number): string {
  if (value >= 2) {
    const days = Math.round(value);
    return `~${days} ${ruPlural(days, "день", "дня", "дней")}`;
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded)
    ? `~${rounded} ${ruPlural(rounded, "день", "дня", "дней")}`
    : `~${String(rounded).replace(".", ",")} дня`;
}

function StatusBadge({ account }: { account: AdminAiAccount }) {
  if (!account.configured) {
    return <span className="badge" title="Ключа этого аккаунта больше нет в настройках сервера">нет ключа</span>;
  }
  if (!account.enabled) {
    return <span className="badge">выключен</span>;
  }
  if (account.status === "exhausted") {
    return (
      <span className="badge badge-danger" title={account.statusReason ?? undefined}>
        кончился кредит
      </span>
    );
  }
  if (account.status === "invalid") {
    return (
      <span className="badge badge-danger" title={account.statusReason ?? undefined}>
        ключ не принят
      </span>
    );
  }
  if (account.serving) {
    return <span className="badge badge-success">тратится сейчас</span>;
  }
  return <span className="badge badge-info">в очереди</span>;
}

function BalanceCell({
  account,
  busy,
  onSave,
}: {
  account: AdminAiAccount;
  busy: boolean;
  onSave: (microUsd: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    const parsed = Number(draft.replace(",", ".").replace(/[$\s]/g, ""));
    const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
    return (
      <form
        className="flex items-center justify-end gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSave(Math.round(parsed * 1_000_000));
          setEditing(false);
        }}
      >
        <span className="text-text-muted">$</span>
        <input
          className="input w-24 text-right"
          inputMode="decimal"
          autoFocus
          aria-label={`Остаток аккаунта ${account.label} в консоли Anthropic, долларов`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!valid || busy}>Сохранить</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Отмена</button>
      </form>
    );
  }

  const startEditing = () => {
    setDraft(account.balance ? String(account.balance.estimatedMicroUsd / 1_000_000) : "");
    setEditing(true);
  };

  if (!account.balance) {
    return (
      <button type="button" className="btn btn-sm" onClick={startEditing} disabled={busy}>
        Указать остаток
      </button>
    );
  }
  const { balance } = account;
  return (
    <div className="text-right">
      <button
        type="button"
        className="font-semibold tabular-nums underline decoration-dotted underline-offset-4"
        title="Изменить: введите остаток из консоли Anthropic"
        onClick={startEditing}
        disabled={busy}
      >
        ≈ {usd(balance.estimatedMicroUsd)}
      </button>
      <div className={`whitespace-nowrap text-xs ${balance.low ? "font-medium text-danger" : "text-text-muted"}`}>
        {balance.estimatedMicroUsd === 0
          ? "по расчёту потрачен"
          : balance.daysLeft !== null && `хватит на ${daysLeftLabel(balance.daysLeft)}`}
        {balance.estimatedMicroUsd > 0 && balance.runsOutAt && ` · до ${runsOutLabel(balance.runsOutAt)}`}
      </div>
      {balance.provider && (
        <div
          className="whitespace-nowrap text-xs text-text-muted"
          title="Тот же остаток из консоли минус то, что Anthropic выставил по своим отчётам с тех пор"
        >
          по счёту Anthropic ≈ {usd(balance.provider.estimatedMicroUsd)}
          {balance.provider.runsOutAt && balance.provider.estimatedMicroUsd > 0 && `, до ${runsOutLabel(balance.provider.runsOutAt)}`}
        </div>
      )}
      <div
        className="whitespace-nowrap text-xs text-text-muted"
        title="Остаток из консоли Anthropic на момент сверки минус траты хаба с тех пор"
      >
        {dateTime(balance.readAt)}: {usd(balance.readMicroUsd)} − {usd(balance.spentSinceMicroUsd)}
      </div>
    </div>
  );
}

/** The Anthropic accounts Hub spends one after another: which one is being
 * spent, what each cost, and the balance left by the last console reading. */
export function AiAccountsSection() {
  const { data, isLoading, isError, refetch, isFetching } = useAdminAiAccounts();
  const update = useAdminUpdateAiAccount();
  const [error, setError] = useState<string | null>(null);

  const change = (accountId: number, body: Parameters<typeof update.mutate>[0]["body"]) => {
    setError(null);
    update.mutate({ accountId, body }, {
      onError: (cause) => setError(cause instanceof Error ? cause.message : "Не удалось сохранить"),
    });
  };

  let content;
  if (isLoading) {
    content = <TableSkeleton rows={3} columns={6} />;
  } else if (isError && !data) {
    content = (
      <StatusPanel
        title="Не удалось загрузить аккаунты"
        description="Сервер не ответил."
        tone="error"
        action={<button type="button" className="btn btn-sm" onClick={() => void refetch()} disabled={isFetching}>Повторить</button>}
      />
    );
  } else if (!data || data.accounts.length === 0) {
    content = (
      <p className="muted px-4 py-6 text-sm">
        Ключи Anthropic не заданы: на сервере нет ни ANTHROPIC_API_KEYS, ни ANTHROPIC_API_KEY.
      </p>
    );
  } else {
    const accounts = data.accounts;
    content = (
      <>
        {error && <div role="alert" className="notice notice-warning mx-4 mt-3">{error}</div>}
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Аккаунт</th>
                <th className="num">За сутки</th>
                <th className="num">За 7 дней</th>
                <th className="num">За 30 дней</th>
                <th className="num">Остаток</th>
                <th className="num">Очередь</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account, index) => (
                <tr key={account.id} className={account.enabled && account.configured ? undefined : "opacity-60"}>
                  <td className="min-w-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{account.label}</span>
                      <StatusBadge account={account} />
                    </div>
                    <div className="whitespace-nowrap text-xs text-text-muted">
                      {account.keyHint && `ключ …${account.keyHint}`}
                      {account.status !== "active" && account.statusChangedAt && ` · с ${dateTime(account.statusChangedAt)}`}
                    </div>
                    {account.lastUsedAt && (
                      <div className="whitespace-nowrap text-xs text-text-muted">
                        последний запрос {dateTime(account.lastUsedAt)}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {usd(account.spent.last24hMicroUsd)}
                    <div className="text-xs text-text-muted">
                      {account.requests.last24h} {ruPlural(account.requests.last24h, "запрос", "запроса", "запросов")}
                    </div>
                  </td>
                  <td className="num">{usd(account.spent.last7dMicroUsd)}</td>
                  <td className="num">{usd(account.spent.last30dMicroUsd)}</td>
                  <td className="num">
                    <BalanceCell
                      account={account}
                      busy={update.isPending}
                      onSave={(microUsd) => change(account.id, { balanceMicroUsd: microUsd })}
                    />
                  </td>
                  <td className="num whitespace-nowrap">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-icon"
                      aria-label={`Поднять ${account.label} в очереди`}
                      disabled={index === 0 || update.isPending}
                      onClick={() => change(account.id, { move: "up" })}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-icon"
                      aria-label={`Опустить ${account.label} в очереди`}
                      disabled={index === accounts.length - 1 || update.isPending}
                      onClick={() => change(account.id, { move: "down" })}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm ml-1"
                      disabled={update.isPending || !account.configured}
                      onClick={() => change(account.id, { enabled: !account.enabled })}
                    >
                      {account.enabled ? "Выключить" : "Включить"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-text-muted">
          В среднем уходит {usd(data.dailyBurnMicroUsd)} в день (по последним 3 дням); остаток краснеет, когда его хватит меньше чем на {daysLeftLabel(data.balanceWarnDays).replace("~", "")}.
          {data.unattributed30dMicroUsd > 0
            && ` Ещё ${usd(data.unattributed30dMicroUsd)} за 30 дней потрачено до того, как хаб начал отмечать аккаунт.`}
        </p>
      </>
    );
  }

  return (
    <section aria-labelledby="ai-accounts-title" className="card">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="ai-accounts-title" className="card-title">Аккаунты Anthropic</h2>
          <p className="card-description">
            Хаб тратит их по очереди: сначала верхний, а когда на нём кончается кредит — сам переходит к следующему.
            Траты — по расчёту хаба. Остатка Anthropic не сообщает: введите его из консоли Anthropic, хаб будет вычитать свои траты.
          </p>
        </div>
      </div>
      {content}
    </section>
  );
}
