import { useState, type FormEvent, type ReactNode } from "react";
import { MOSCOW_TIME_ZONE, formatUsdFromMicroUsd, toBusinessDate } from "@agency_hub_core/shared";
import {
  useAuthMe,
  useChangeMyPassword,
  useMyDevices,
  useMyUsage,
  useRevokeMyDevice,
  useRevokeMyDevices,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import {
  START_GUIDE_URL,
  USAGE_WINDOW_DAYS,
  changePasswordProblem,
  dailyRowFor,
  featureLabel,
  groupPagesByPlatform,
  lastSeenLabel,
  roleLabel,
  usageWindow,
} from "./accountView.js";

// Decision 349: the cabinet. One person, their own account: who they are, the
// devices they are signed in on, their password, and what their AI work cost.
// Every route it calls is any-session and self-scoped — there is nothing here
// an owner could not also open about themselves.

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text-primary">{value}</p>
      {note && <p className="mt-0.5 text-xs text-text-muted">{note}</p>}
    </div>
  );
}

function WhoAmI() {
  const { data } = useAuthMe();
  if (!data) return null;
  const groups = groupPagesByPlatform(data.user.assignedPages);
  return (
    <Section title="Кто я">
      <p className="break-all text-2xl font-bold text-text-primary">{data.user.username}</p>
      <p className="mt-1 text-sm text-text-secondary">{roleLabel(data.user.role)}</p>
      {groups.length === 0
        ? <p className="mt-4 text-sm text-text-muted">Страницы пока не назначены — попроси владельца.</p>
        : (
          <dl className="mt-4 flex flex-col gap-3">
            {groups.map((group) => (
              <div key={group.platform}>
                <dt className="text-xs uppercase tracking-wide text-text-muted">{group.label}</dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {group.pages.map((page) => (
                    <span key={page.id} className="rounded-md border border-border px-2 py-1 text-sm text-text-secondary">
                      {page.label}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        )}
    </Section>
  );
}

function Devices() {
  const devices = useMyDevices();
  const revokeOne = useRevokeMyDevice();
  const revokeAll = useRevokeMyDevices();
  const [confirming, setConfirming] = useState(false);

  return (
    <Section title="Устройства">
      {devices.isLoading && <p role="status" className="text-sm text-text-muted">Загружаем…</p>}
      {devices.isError && <p role="alert" className="text-sm text-danger">Не удалось загрузить список. Обнови страницу.</p>}
      {devices.data?.length === 0 && (
        <p className="text-sm text-text-muted">Пока ни одного устройства. Войди в расширении или в приложении — оно появится здесь.</p>
      )}
      {devices.data && devices.data.length > 0 && (
        <ul className="flex flex-col gap-3">
          {devices.data.map((device) => (
            <li key={device.id} className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{device.label}</p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {device.lastClientVersion ? `версия ${device.lastClientVersion} · ` : ""}
                  {lastSeenLabel(device.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                disabled={revokeOne.isPending}
                onClick={() => revokeOne.mutate(device.id)}
                className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
              >
                Выйти с этого устройства
              </button>
            </li>
          ))}
        </ul>
      )}

      {revokeOne.isError && <p role="alert" className="mt-3 text-sm text-danger">Не получилось выйти. Попробуй ещё раз.</p>}

      <div className="mt-4 border-t border-border pt-4">
        {confirming
          ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-text-secondary">Выйти на всех устройствах? Придётся войти заново на каждом.</p>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="min-h-11 rounded-lg border border-border px-3 text-sm text-text-secondary hover:bg-hover"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={revokeAll.isPending}
                  onClick={() => revokeAll.mutate(undefined, { onSuccess: () => setConfirming(false) })}
                  className="min-h-11 rounded-lg bg-danger px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {revokeAll.isPending ? "Выходим…" : "Да, выйти"}
                </button>
              </div>
            </div>
          )
          : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="min-h-11 rounded-lg border border-border px-3 text-sm text-text-secondary hover:bg-hover"
            >
              Выйти на всех устройствах
            </button>
          )}
        {revokeAll.isError && <p role="alert" className="mt-3 text-sm text-danger">Не получилось. Попробуй ещё раз.</p>}
      </div>
    </Section>
  );
}

function ChangePassword() {
  const change = useChangeMyPassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  if (change.isSuccess) {
    return (
      <Section title="Сменить пароль">
        <p className="text-sm text-text-secondary">
          Пароль изменён. Все прежние входы завершены — войди заново с новым паролем.
        </p>
        <button
          type="button"
          // A full page load, so nothing cached under the dead session survives.
          onClick={() => window.location.assign("/login")}
          className="mt-4 min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:opacity-90"
        >
          Войти заново
        </button>
      </Section>
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (change.isPending || !current) return;
    const found = changePasswordProblem(next, confirmation);
    setProblem(found);
    if (found) return;
    change.mutate({ currentPassword: current, newPassword: next });
  }

  const serverProblem = change.isError
    ? (change.error instanceof KernelApiError && change.error.status === 401
      ? "Текущий пароль не подошёл."
      : change.error instanceof KernelApiError && change.error.status === 400
        ? "Новый пароль не подходит. Придумай другой."
        : "Не получилось сменить пароль. Попробуй ещё раз.")
    : null;

  return (
    <Section title="Сменить пароль">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-busy={change.isPending}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="account-current-password" className="text-sm text-text-secondary">Текущий пароль</label>
          <input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            disabled={change.isPending}
            onChange={(event) => { setCurrent(event.target.value); setProblem(null); change.reset(); }}
            required
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="account-new-password" className="text-sm text-text-secondary">Новый пароль</label>
          <input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            disabled={change.isPending}
            onChange={(event) => { setNext(event.target.value); setProblem(null); change.reset(); }}
            required
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="account-new-password-again" className="text-sm text-text-secondary">Повтори новый пароль</label>
          <input
            id="account-new-password-again"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            disabled={change.isPending}
            onChange={(event) => { setConfirmation(event.target.value); setProblem(null); change.reset(); }}
            required
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        {(problem ?? serverProblem) && <p role="alert" className="text-sm text-danger">{problem ?? serverProblem}</p>}
        <button
          type="submit"
          disabled={change.isPending || !current || !next || !confirmation}
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 sm:self-start"
        >
          {change.isPending ? "Меняем…" : "Сменить пароль"}
        </button>
      </form>
    </Section>
  );
}

function Spend() {
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const range = usageWindow(today);
  const usage = useMyUsage(range);

  if (usage.isLoading) {
    return <Section title="Мои AI-траты"><p role="status" className="text-sm text-text-muted">Считаем…</p></Section>;
  }
  if (usage.isError || !usage.data) {
    return <Section title="Мои AI-траты"><p role="alert" className="text-sm text-danger">Не удалось посчитать траты. Обнови страницу.</p></Section>;
  }

  const { row, daily } = usage.data;
  const todayRow = dailyRowFor(daily, today);
  const peak = daily.reduce((max, entry) => Math.max(max, entry.costMicroUsd), 0);
  const features = [...row.featureBreakdown].sort((a, b) => b.costMicroUsd - a.costMicroUsd);

  return (
    <Section title="Мои AI-траты">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat
          label="Сегодня"
          value={formatUsdFromMicroUsd(todayRow.costMicroUsd)}
          note={`${todayRow.requestCount} запросов`}
        />
        <Stat
          label={`${USAGE_WINDOW_DAYS} дней`}
          value={formatUsdFromMicroUsd(row.cost.microUsd, { approximate: row.cost.approximate })}
          note={`${row.totalGenerations} запросов`}
        />
      </div>

      {daily.length > 0 && (
        <div className="mt-6">
          <p className="text-xs uppercase tracking-wide text-text-muted">По дням</p>
          <div className="mt-2 flex h-20 items-end gap-[2px]" role="img" aria-label={`Траты по дням за ${USAGE_WINDOW_DAYS} дней`}>
            {daily.map((entry) => (
              <div
                key={entry.date}
                title={`${entry.date}: ${formatUsdFromMicroUsd(entry.costMicroUsd)}`}
                className="min-h-[2px] flex-1 rounded-t bg-accent/70"
                style={{ height: `${peak > 0 ? Math.round((entry.costMicroUsd / peak) * 100) : 0}%` }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-6">
        <p className="text-xs uppercase tracking-wide text-text-muted">По возможностям</p>
        {features.length === 0
          ? <p className="mt-2 text-sm text-text-muted">За этот период трат не было.</p>
          : (
            <ul className="mt-2 flex flex-col gap-2">
              {features.map((feature) => (
                <li key={feature.feature} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-text-secondary">{featureLabel(feature.feature)}</span>
                  <span className="shrink-0 text-text-primary">
                    {feature.requestCount} · {formatUsdFromMicroUsd(feature.costMicroUsd, { approximate: feature.costApproximate })}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Section>
  );
}

export function AccountPage() {
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <WhoAmI />
      <Devices />
      <ChangePassword />
      <Spend />
      <p className="text-center text-sm">
        <a href={START_GUIDE_URL} className="text-accent underline">Как начать</a>
      </p>
    </div>
  );
}
