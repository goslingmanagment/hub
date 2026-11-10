import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import {
  useAuthMe,
  useChangeMyPassword,
  useMyDevices,
  useMyUsage,
  useRevokeMyDevice,
  useRevokeMyDevices,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ChartTable } from "@/components/charts/ChartTable";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { Field } from "@/components/shared/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatAiUsd, formatCount, formatDay } from "@/lib/format";
import { CHATTER_SHIFTS, cabinetRedirect } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import { LeaveForWorkboard } from "@/routes/ToWorkboard";
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

// The account page. One person, their own account: who they are, the devices
// they are signed in on, their password and what their AI work cost. A
// chatter's shifts and reports are Workboard's «Мои смены» (owner, 2026-11-10);
// the cabinet's old tabs lead there. Every route it calls is any-session and
// self-scoped: there is nothing here an owner could not also open about themselves.

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <header className="card-header">
        <h2 className="card-title">{title}</h2>
        {aside}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

function Retry({ text, onRetry, busy }: { text: string; onRetry: () => void; busy: boolean }) {
  return (
    <div role="alert" className="ac-retry">
      <span>{text}</span>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={onRetry}>Повторить</button>
    </div>
  );
}

function Lines({ count = 3 }: { count?: number }) {
  return (
    <div className="ac-lines" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <Skeleton key={index} width={`${70 - index * 12}%`} />)}
    </div>
  );
}

function WhoAmI() {
  const { data } = useAuthMe();
  if (!data) return null;
  const groups = groupPagesByPlatform(data.user.assignedPages);
  return (
    <Section title="Кто я">
      <p className="ac-login">{data.user.username}</p>
      <p className="ac-role">{roleLabel(data.user.role)}</p>
      {groups.length === 0
        ? <p className="ac-muted">Страницы пока не назначены — попроси владельца.</p>
        : (
          <dl className="kv ac-pages">
            {groups.map((group) => (
              <div key={group.platform} className="contents">
                <dt>{group.label}</dt>
                <dd className="ac-chips">
                  {group.pages.map((page) => <span key={page.id} className="badge">{page.label}</span>)}
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
      {devices.isLoading && <Lines />}
      {devices.isError && <Retry text="Не удалось загрузить список." busy={devices.isFetching} onRetry={() => void devices.refetch()} />}
      {devices.data?.length === 0 && (
        <p className="ac-muted">Пока ни одного устройства. Войди в расширении или в приложении — оно появится здесь.</p>
      )}
      {devices.data && devices.data.length > 0 && (
        <ul className="ac-rows">
          {devices.data.map((device) => (
            <li key={device.id} className="ac-row">
              <div className="min-w-0">
                <p className="ac-row-title">{device.label}</p>
                <p className="ac-row-meta">
                  {device.lastClientVersion ? `версия ${device.lastClientVersion} · ` : ""}
                  {lastSeenLabel(device.lastUsedAt)}
                </p>
              </div>
              <button type="button" disabled={revokeOne.isPending} onClick={() => revokeOne.mutate(device.id)} className="btn btn-sm">
                Завершить этот вход
              </button>
            </li>
          ))}
        </ul>
      )}

      {revokeOne.isError && <p role="alert" className="field-error">Не получилось выйти. Попробуй ещё раз.</p>}

      <div className="ac-foot">
        {confirming
          ? (
            <div className="ac-confirm">
              <p>Выйти на всех устройствах? Придётся войти заново на каждом.</p>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => setConfirming(false)} className="btn btn-sm">Отмена</button>
                <button
                  type="button"
                  disabled={revokeAll.isPending}
                  onClick={() => revokeAll.mutate(undefined, { onSuccess: () => setConfirming(false) })}
                  className="btn btn-sm btn-danger"
                >
                  {revokeAll.isPending ? "Выходим…" : "Выйти на всех устройствах"}
                </button>
              </div>
            </div>
          )
          : <button type="button" onClick={() => setConfirming(true)} className="btn btn-sm">Выйти на всех устройствах</button>}
        {revokeAll.isError && <p role="alert" className="field-error">Не получилось. Попробуй ещё раз.</p>}
      </div>
    </Section>
  );
}

function ChangePassword() {
  const change = useChangeMyPassword();
  const submitting = useRef(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  if (change.isSuccess) {
    return (
      <Section title="Сменить пароль">
        <p className="ac-text">Пароль изменён. Все прежние входы завершены — войди заново с новым паролем.</p>
        <button
          type="button"
          // A full page load, so nothing cached under the dead session survives.
          onClick={() => window.location.assign("/login")}
          className="btn btn-primary mt-4"
        >
          Войти заново
        </button>
      </Section>
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // `isPending` alone loses the race between two fast clicks — the same ref
    // guard the invitation form uses. Changing a password twice would revoke
    // the sessions twice and answer 401 the second time.
    if (submitting.current || change.isPending || !current) return;
    const found = changePasswordProblem(next, confirmation);
    setProblem(found);
    if (found) return;
    submitting.current = true;
    change.mutate(
      { currentPassword: current, newPassword: next },
      { onSettled: () => { submitting.current = false; } },
    );
  }

  const serverProblem = change.isError
    ? (change.error instanceof KernelApiError && change.error.status === 401
      ? "Текущий пароль не подошёл."
      : change.error instanceof KernelApiError && change.error.status === 400
        ? "Новый пароль не подходит. Придумай другой."
        : "Не получилось сменить пароль. Попробуй ещё раз.")
    : null;
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setProblem(null);
    change.reset();
  };

  return (
    <Section title="Сменить пароль">
      <form onSubmit={handleSubmit} className="ac-form" aria-busy={change.isPending}>
        <Field label="Текущий пароль">
          <input type="password" autoComplete="current-password" value={current} disabled={change.isPending} required
            onChange={(event) => edit(setCurrent)(event.target.value)} className="input" />
        </Field>
        <Field label="Новый пароль">
          <input type="password" autoComplete="new-password" value={next} disabled={change.isPending} required
            onChange={(event) => edit(setNext)(event.target.value)} className="input" />
        </Field>
        <Field label="Повтори новый пароль">
          <input type="password" autoComplete="new-password" value={confirmation} disabled={change.isPending} required
            onChange={(event) => edit(setConfirmation)(event.target.value)} className="input" />
        </Field>
        {(problem ?? serverProblem) && <p role="alert" className="field-error">{problem ?? serverProblem}</p>}
        <button type="submit" disabled={change.isPending || !current || !next || !confirmation} className="btn btn-primary sm:self-start">
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

  if (usage.isLoading) return <Section title="Мои траты на ИИ"><Lines count={4} /></Section>;
  if (usage.isError || !usage.data) {
    return (
      <Section title="Мои траты на ИИ">
        <Retry text="Не удалось посчитать траты." busy={usage.isFetching} onRetry={() => void usage.refetch()} />
      </Section>
    );
  }

  const { row, daily } = usage.data;
  const todayRow = dailyRowFor(daily, today);
  const features = [...row.featureBreakdown].sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  const calls = (value: number) => `${formatCount(value)} ${ruPlural(value, "вызов", "вызова", "вызовов")}`;
  const dollars = (value: number, approximate = false) => `${approximate ? "≈ " : ""}${formatAiUsd(value)}`;

  return (
    <Section title="Мои траты на ИИ">
      <StatGrid className="ac-stats">
        <Stat label="Сегодня" value={formatAiUsd(todayRow.costMicroUsd)} meta={calls(todayRow.requestCount)} />
        <Stat label={`${USAGE_WINDOW_DAYS} дней`} value={dollars(row.cost.microUsd, row.cost.approximate)} meta={calls(row.totalGenerations)} />
      </StatGrid>

      {daily.length > 0 && (
        <div className="ac-block">
          <h3 className="ac-subtitle">По дням</h3>
          <StackedBarChart
            title=""
            data={daily.map((entry) => ({ date: entry.date, cost: entry.costMicroUsd }))}
            xKey="date"
            series={[{ key: "cost", label: "Траты", color: "var(--color-chart-blue)" }]}
            xTickFormatter={formatDay}
            valueFormatter={formatAiUsd}
            axisFormatter={() => formatAiUsd}
            totalLabel={null}
            height={160}
          />
          <div className="mt-3">
            <ChartTable
              caption="Траты на ИИ по дням"
              rows={daily}
              rowKey={(entry) => entry.date}
              columns={[
                { key: "date", label: "День", value: (entry) => formatDay(entry.date) },
                { key: "calls", label: "Вызовов", num: true, value: (entry) => formatCount(entry.requestCount) },
                { key: "cost", label: "Траты", num: true, value: (entry) => formatAiUsd(entry.costMicroUsd) },
              ]}
            />
          </div>
        </div>
      )}

      <div className="ac-block">
        <h3 className="ac-subtitle">По функциям</h3>
        {features.length === 0
          ? <p className="ac-muted">За этот период трат не было.</p>
          : (
            <ul className="ac-features">
              {features.map((feature) => (
                <li key={feature.feature}>
                  <span className="min-w-0 truncate">{featureLabel(feature.feature)}</span>
                  <span className="ac-feature-calls">{calls(feature.requestCount)}</span>
                  <span className="ac-feature-cost">{dollars(feature.costMicroUsd, feature.costApproximate)}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Section>
  );
}

/** A chatter's way to their shifts, quiet, above the page: «Мои смены» is their home. */
function ToShifts() {
  return (
    <a href={CHATTER_SHIFTS} className="ac-back">
      <span aria-hidden="true">←</span> Мои смены
    </a>
  );
}

// The chatters' site serves only /account itself (agency-site deploy/server-nginx.sh):
// the old tabs were queries of it, and those of a chatter's shifts lead to Workboard.
export function AccountPage() {
  const [params] = useSearchParams();
  const { data } = useAuthMe();
  const chatter = data?.user.role === "chatter";
  const left = chatter ? cabinetRedirect(params) : null;
  if (left !== null) return <LeaveForWorkboard href={left} />;
  return (
    <div className="ac-page">
      <div className="ac-narrow">
        <header className="ac-head">
          {chatter && <ToShifts />}
          <h1 className="ac-title">Аккаунт и устройства</h1>
        </header>
        <WhoAmI />
        <Devices />
        <ChangePassword />
        <Spend />
        <p className="ac-guide"><a href={START_GUIDE_URL} className="link">Как начать</a></p>
      </div>
    </div>
  );
}
