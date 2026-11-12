import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { Badge, Button, Card, Disclosure, ErrorState, Field, Skeleton, SkeletonText, Table, TextInput, type Column } from "@agency_hub_core/ui";
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
} from "@agency_hub_core/ui/account";
import { formatAiUsd, formatCount, formatDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { kernel } from "@/shared/hub";
import { PasswordWayIn } from "@/shared/PasswordWayIn";
import { PayoutDetails } from "@/shared/PayoutDetails";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useAccountStart } from "@/shared/start";
import { useMe } from "@/shared/useMe";
import "./account.css";

/**
 * «Аккаунт и устройства» (the console's `/account` until 12.11, now a screen of
 * Workboard in the name menu): one person, their own account — who they are,
 * where they are signed in, their password, what their AI work cost. Every
 * read and change is the session's own (any live session; Hub scopes it to the
 * person): nothing here an owner could not also open about themselves. A
 * narrow session (from the extension, no password) reads none of it: one panel
 * with the way to the password instead (NARROW_WEB_SESSION_PASSWORD_ONLY).
 * Where payouts go is everyone's here, as on a newcomer's «Начало» (the same
 * card; a narrow session sees only whether it is written, with the way to the
 * password).
 */
export function AccountScreen() {
  const { narrow } = useMe();
  if (narrow) {
    return (
      <>
        <ScreenHeader title="Аккаунт и устройства" />
        <div className="wb-content account-grid">
          <Card title="Вы вошли из расширения">
            <PasswordWayIn text="Устройства, пароль и расходы ИИ открываются после входа на сайте с паролем." />
          </Card>
          <Payout />
        </div>
      </>
    );
  }
  return (
    <>
      <ScreenHeader title="Аккаунт и устройства" />
      <div className="wb-content account-grid">
        <WhoAmI />
        <Payout />
        <Devices />
        <ChangePassword />
        <Spend />
        <p className="account-guide"><a href={START_GUIDE_URL} className="ui-link">Как начать</a></p>
      </div>
    </>
  );
}

const DEVICES_KEY = ["account", "devices"] as const;

/** «Куда переводить выплаты»: a person's own (`accountStart`); a login no person holds has none, so no card. */
function Payout() {
  const start = useAccountStart(true);
  if (start.isPending) return <Card title="Куда переводить выплаты"><SkeletonText lines={2} /></Card>;
  if (!start.data || start.data.person === null) return null;
  return (
    <Card title="Куда переводить выплаты" description="Как вы получаете деньги: например, UID в Bybit или адрес кошелька USDT и сеть.">
      <PayoutDetails data={start.data} />
    </Card>
  );
}

function WhoAmI() {
  const { user } = useMe();
  if (!user) return null;
  const groups = groupPagesByPlatform(user.assignedPages);
  return (
    <Card title="Кто я">
      <p className="account-login">{user.username}</p>
      <p className="account-muted">{roleLabel(user.role)}</p>
      {groups.length === 0
        ? <p className="account-muted account-gap">Страницы пока не назначены: попросите владельца.</p>
        : (
          <dl className="account-pages">
            {groups.map((group) => (
              <div key={group.platform} className="account-pages__row">
                <dt>{group.label}</dt>
                <dd>{group.pages.map((page) => <Badge key={page.id}>{page.label}</Badge>)}</dd>
              </div>
            ))}
          </dl>
        )}
    </Card>
  );
}

function Devices() {
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: () => kernel.authListDevices() });
  const settled = () => queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
  const revokeOne = useMutation({ mutationFn: (deviceId: number) => kernel.authRevokeDevice({ params: { deviceId } }), onSuccess: settled });
  const revokeAll = useMutation({ mutationFn: () => kernel.authRevokeAllDevices(), onSuccess: settled });
  const [confirming, setConfirming] = useState(false);

  return (
    <Card title="Устройства">
      {devices.isPending && <SkeletonText lines={3} />}
      {devices.isError && <ErrorState onRetry={() => void devices.refetch()} retrying={devices.isFetching}>Не удалось загрузить список.</ErrorState>}
      {devices.data?.length === 0 && <p className="account-muted">Пока ни одного устройства. Войдите в расширении, и оно появится здесь.</p>}
      {devices.data && devices.data.length > 0 && (
        <ul className="account-rows">
          {devices.data.map((device) => (
            <li key={device.id} className="account-row">
              <div className="min-w-0">
                <p className="account-row__title">{device.label}</p>
                <p className="account-muted">
                  {device.lastClientVersion ? `версия ${device.lastClientVersion} · ` : ""}
                  {lastSeenLabel(device.lastUsedAt)}
                </p>
              </div>
              <Button size="sm" disabled={revokeOne.isPending} onClick={() => revokeOne.mutate(device.id)}>Завершить этот вход</Button>
            </li>
          ))}
        </ul>
      )}
      {revokeOne.isError && <p role="alert" className="account-error">Не получилось выйти. Попробуйте ещё раз.</p>}
      <div className="account-foot">
        {confirming ? (
          <div className="account-confirm">
            <p>Выйти на всех устройствах? Придётся войти заново на каждом.</p>
            <div className="account-confirm__actions">
              <Button size="sm" onClick={() => setConfirming(false)}>Отмена</Button>
              <Button size="sm" variant="danger" loading={revokeAll.isPending} onClick={() => revokeAll.mutate(undefined, { onSuccess: () => setConfirming(false) })}>
                {revokeAll.isPending ? "Выходим…" : "Выйти на всех устройствах"}
              </Button>
            </div>
          </div>
        ) : <Button size="sm" onClick={() => setConfirming(true)}>Выйти на всех устройствах</Button>}
        {revokeAll.isError && <p role="alert" className="account-error">Не получилось. Попробуйте ещё раз.</p>}
      </div>
    </Card>
  );
}

function ChangePassword() {
  const change = useMutation({ mutationFn: (body: { currentPassword: string; newPassword: string }) => kernel.authChangePassword({ body }) });
  const submitting = useRef(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  if (change.isSuccess) {
    return (
      <Card title="Сменить пароль">
        <p>Пароль изменён. Все прежние входы завершены: войдите заново с новым паролем.</p>
        {/* A full page load, so nothing cached under the dead session survives. */}
        <Button variant="primary" className="account-gap" onClick={() => window.location.assign("/login")}>Войти заново</Button>
      </Card>
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // `isPending` alone loses the race between two fast clicks: changing a password twice would revoke the sessions
    // twice and answer 401 the second time.
    if (submitting.current || change.isPending || !current) return;
    const found = changePasswordProblem(next, confirmation);
    setProblem(found);
    if (found) return;
    submitting.current = true;
    change.mutate({ currentPassword: current, newPassword: next }, { onSettled: () => { submitting.current = false; } });
  }

  const status = change.isError ? hubErrorStatus(change.error) : null;
  const serverProblem = change.isError
    ? status === 401 ? "Текущий пароль не подошёл." : status === 400 ? "Новый пароль не подходит. Придумайте другой." : "Не получилось сменить пароль. Попробуйте ещё раз."
    : null;
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setProblem(null);
    change.reset();
  };

  return (
    <Card title="Сменить пароль">
      <form onSubmit={handleSubmit} className="account-form" aria-busy={change.isPending}>
        <Field label="Текущий пароль">
          {(control) => <TextInput {...control} type="password" autoComplete="current-password" value={current} disabled={change.isPending} required onChange={(event) => edit(setCurrent)(event.target.value)} />}
        </Field>
        <Field label="Новый пароль">
          {(control) => <TextInput {...control} type="password" autoComplete="new-password" value={next} disabled={change.isPending} required onChange={(event) => edit(setNext)(event.target.value)} />}
        </Field>
        <Field label="Повторите новый пароль">
          {(control) => <TextInput {...control} type="password" autoComplete="new-password" value={confirmation} disabled={change.isPending} required onChange={(event) => edit(setConfirmation)(event.target.value)} />}
        </Field>
        {(problem ?? serverProblem) && <p role="alert" className="account-error">{problem ?? serverProblem}</p>}
        <Button type="submit" variant="primary" className="account-submit" disabled={!current || !next || !confirmation} loading={change.isPending}>
          {change.isPending ? "Меняем…" : "Сменить пароль"}
        </Button>
      </form>
    </Card>
  );
}

interface DayRow {
  date: string;
  requestCount: number;
  costMicroUsd: number;
}

function Spend() {
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const range = usageWindow(today);
  const usage = useQuery({ queryKey: ["account", "usage", range], queryFn: () => kernel.authMyUsage({ query: range }) });

  if (usage.isPending) return <Card title="Мои траты на ИИ"><SkeletonText lines={4} /></Card>;
  if (!usage.data) {
    return (
      <Card title="Мои траты на ИИ">
        <ErrorState onRetry={() => void usage.refetch()} retrying={usage.isFetching}>Не удалось посчитать траты.</ErrorState>
      </Card>
    );
  }

  const { row, daily } = usage.data;
  const todayRow = dailyRowFor(daily, today);
  const features = [...row.featureBreakdown].sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  const calls = (value: number) => `${formatCount(value)} ${ruPlural(value, "вызов", "вызова", "вызовов")}`;
  const dollars = (value: number, approximate = false) => `${approximate ? "≈ " : ""}${formatAiUsd(value)}`;
  const most = Math.max(0, ...daily.map((entry) => entry.costMicroUsd));
  const columns: Column<DayRow>[] = [
    { key: "date", header: "День", cell: (entry) => formatDay(entry.date) },
    { key: "calls", header: "Вызовов", numeric: true, cell: (entry) => formatCount(entry.requestCount) },
    { key: "cost", header: "Траты", numeric: true, cell: (entry) => formatAiUsd(entry.costMicroUsd) },
  ];

  return (
    <Card title="Мои траты на ИИ" padding="none">
      <div className="account-stats">
        <div><p className="account-muted">Сегодня</p><p className="account-stat">{formatAiUsd(todayRow.costMicroUsd)}</p><p className="account-muted">{calls(todayRow.requestCount)}</p></div>
        <div><p className="account-muted">{USAGE_WINDOW_DAYS} дней</p><p className="account-stat">{dollars(row.cost.microUsd, row.cost.approximate)}</p><p className="account-muted">{calls(row.totalGenerations)}</p></div>
      </div>
      {daily.length > 0 && (
        <div className="account-block">
          <h3 className="account-subtitle">По дням</h3>
          {/* The days as bars, oldest first; their numbers in a table under them. */}
          <div className="account-chart" role="img" aria-label={`Траты на ИИ по дням: ${daily.length} дней`}>
            {daily.map((entry) => (
              <span key={entry.date} className="account-chart__day" title={`${formatDay(entry.date)}: ${formatAiUsd(entry.costMicroUsd)}`}>
                <span className="account-chart__bar" style={{ height: `${most > 0 ? Math.max(entry.costMicroUsd > 0 ? 2 : 0, (entry.costMicroUsd / most) * 100) : 0}%` }} />
              </span>
            ))}
          </div>
          <div className="account-chart__axis"><span>{formatDay(daily[0]!.date)}</span><span>{formatDay(daily.at(-1)!.date)}</span></div>
          <Disclosure summary="Числа таблицей" className="account-table">
            <Table label="Траты на ИИ по дням" columns={columns} rows={[...daily].reverse()} rowKey={(entry) => entry.date} />
          </Disclosure>
        </div>
      )}
      <div className="account-block account-block--pad">
        <h3 className="account-subtitle">По функциям</h3>
        {features.length === 0
          ? <p className="account-muted">За этот период трат не было.</p>
          : (
            <ul className="account-features">
              {features.map((feature) => (
                <li key={feature.feature}>
                  <span className="account-features__name">{featureLabel(feature.feature)}</span>
                  <span className="account-muted">{calls(feature.requestCount)}</span>
                  <span className="account-features__cost">{dollars(feature.costMicroUsd, feature.costApproximate)}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Card>
  );
}

/** While `me` is read: the header and two sheets. */
export function AccountFallback() {
  return (
    <div className="wb-content account-grid">
      <Skeleton width={240} height={28} radius={6} />
      <Card><SkeletonText lines={3} /></Card>
    </div>
  );
}
