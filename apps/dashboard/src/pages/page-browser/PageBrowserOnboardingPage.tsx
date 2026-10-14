import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, ExternalLink, Lock, RefreshCw } from "lucide-react";
import type { PageBrowserProfileResponse } from "@agency_hub_core/contracts";
import { buildProxyConfig, formatProxyPreview, getProxyStringError } from "@agency_hub_core/shared";

import {
  pageBrowserProfileScreenshotUrl,
  sendPageBrowserProfileProxy,
  useAdminModels,
  useClosePageBrowserProfile,
  useCreatePageThroughBrowser,
  useFinishPageBrowserProfileLogin,
  usePageBrowserProfile,
  usePageBrowserProfileLoginStep,
  usePinPageBrowserProfile,
  useStartPageBrowserProfileLogin,
  useVerifyPageBrowserProfile,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { buildPageRoute, buildSettingsRoute } from "@/lib/navigation";
import { Card, Chip, INPUT, LiveScreenshot, LoginForm, PLAIN, PRIMARY, ToneChip } from "./loginParts.js";
import { browserHalted, browserStatusOf, onboardingStepsOf, profileLoginViewOf, type StepState } from "./pageBrowserOnboardingView.js";
import { stepProblemText, type LoginView } from "./pageBrowserLoginView.js";

// A new page connected through its own server browser (Project Browser plan
// §3.2 «Подключение новой страницы через браузер»; PR 16): the profile that
// `deploy-page-browser.sh add-profile` made, its proxy, the exit IP its
// browser checks itself, the owner's login through PR 15's form, the account
// read through the browser, the page created and bound. What is typed — the
// proxy's password, the login, the password, the code — goes straight to
// the API and is kept nowhere here.

const errorText = (error: unknown) => (error instanceof KernelApiError ? error.message : "Не удалось. Повторите попытку.");

function StepTitle({ n, title, state }: { n: number; title: string; state: StepState }) {
  const icon = state === "done"
    ? <CheckCircle2 size={16} className="text-green" aria-hidden />
    : state === "locked" ? <Lock size={14} className="text-text-muted" aria-hidden /> : <Circle size={16} className="text-accent" aria-hidden />;
  return (
    <span className="inline-flex items-center gap-2" data-step-state={state}>
      {icon}
      <span>{n}. {title}</span>
    </span>
  );
}

function ProxyStep({ data, state, exitIp, onExitIp }: { data: PageBrowserProfileResponse; state: StepState; exitIp: string | null; onExitIp: (ip: string) => void }) {
  const qc = useQueryClient();
  const [raw, setRaw] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const editable = data.login.state !== "login" && data.login.state !== "closing";
  const proxyError = raw.trim() === "" ? null : getProxyStringError(raw);
  const config = buildProxyConfig(raw);
  const preview = formatProxyPreview(raw);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (config === undefined || pending) return;
    setPending(true);
    setProblem(null);
    // The proxy's password leaves the field at once: it goes to the API, and
    // nothing keeps it after (no query cache).
    setRaw("");
    sendPageBrowserProfileProxy(qc, data.profile.profileId, { url: config.url, username: config.username ?? null, password: config.password ?? null })
      .then((answer) => onExitIp(answer.exitIp), (error: unknown) => setProblem(errorText(error)))
      .finally(() => setPending(false));
  };
  return (
    <Card title={<StepTitle n={1} title="Прокси страницы" state={state} />}>
      {data.proxy !== null && (
        <p className="mb-3 text-sm text-text-secondary">
          Задан: <span className="font-mono text-text-primary">{data.proxy.url}</span>
          {data.proxy.username !== null && <> · логин <span className="font-mono">{data.proxy.username}</span></>}
          {exitIp !== null && <> · через него Hub видит IP <span className="font-mono text-text-primary">{exitIp}</span></>}
        </p>
      )}
      {editable && (
        <form onSubmit={submit} className="flex flex-col gap-2" autoComplete="off">
          <label htmlFor="pb-proxy" className="text-sm text-text-secondary">
            {data.proxy === null ? "SOCKS5 этой страницы" : "Заменить прокси"} — тот, с которым создан браузер{data.socksEndpoint !== null && <> (<span className="font-mono">{data.socksEndpoint}</span>)</>}
          </label>
          <div className="flex gap-2">
            <input id="pb-proxy" value={raw} onChange={(event) => setRaw(event.target.value)} placeholder="user:pass@host:port" className={`${INPUT} flex-1 font-mono`} spellCheck={false} disabled={pending} />
            <button type="submit" className={PLAIN} disabled={config === undefined || proxyError !== null || pending}>
              {pending ? "Проверяем…" : "Сохранить"}
            </button>
          </div>
          {preview !== null && <p className="text-xs text-text-tertiary">{preview}</p>}
          {proxyError !== null && <p className="text-xs text-danger">{proxyError}</p>}
          <p className="text-xs text-text-muted">Hub сохранит прокси зашифрованным и покажет выходной IP через него. Пароль прокси нигде не показывается.</p>
        </form>
      )}
      {problem !== null && <p role="alert" className="mt-2 text-sm text-danger">{problem}</p>}
    </Card>
  );
}

function PinStep({ data, state, suggested }: { data: PageBrowserProfileResponse; state: StepState; suggested: string | null }) {
  const pin = usePinPageBrowserProfile(data.profile.profileId);
  const [ip, setIp] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const status = browserStatusOf(data.profile);
  const value = ip === "" ? (suggested ?? data.profile.pinnedExitIp ?? "") : ip;
  // Pinned again while the login is open too: a browser that stopped on
  // another exit IP starts again with the new pin and checks it itself.
  const editable = state !== "locked" && data.login.state !== "closing";
  const halted = data.profile.operator.stopReason === "exit_ip_changed";
  return (
    <Card title={<StepTitle n={2} title="Выходной IP" state={state} />} aside={<ToneChip label={status.label} tone={status.tone} />}>
      <p className="mb-3 text-sm text-text-secondary" data-browser-status>{status.detail}</p>
      {data.profile.pinnedExitIp !== null && (
        <p className="mb-3 text-sm text-text-secondary">Закреплён: <span className="font-mono text-text-primary">{data.profile.pinnedExitIp}</span></p>
      )}
      {editable && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setProblem(null);
            pin.mutate(value.trim(), { onError: (error) => setProblem(errorText(error)), onSuccess: () => setIp("") });
          }}
        >
          <input value={value} onChange={(event) => setIp(event.target.value)} placeholder="203.0.113.7" className={`${INPUT} flex-1 font-mono`} aria-label="Выходной IP" />
          <button type="submit" className={PLAIN} disabled={value.trim() === "" || pin.isPending}>
            {pin.isPending ? "Закрепляем…" : data.profile.pinnedExitIp === null ? "Закрепить" : halted ? "Закрепить и перезапустить" : "Закрепить другой"}
          </button>
        </form>
      )}
      <p className="mt-2 text-xs text-text-muted">
        Браузер откроет выход в сеть, только если сам увидит через прокси этот IP. Иначе он остановится и ничего не отправит в Fansly.
      </p>
      {problem !== null && <p role="alert" className="mt-2 text-sm text-danger">{problem}</p>}
    </Card>
  );
}

function LoginStep({ data, state, view }: { data: PageBrowserProfileResponse; state: StepState; view: LoginView }) {
  const profileId = data.profile.profileId;
  const start = useStartPageBrowserProfileLogin(profileId);
  const finish = useFinishPageBrowserProfileLogin(profileId);
  const step = usePageBrowserProfileLoginStep(profileId);
  const [problem, setProblem] = useState<string | null>(null);
  const failure = (error: unknown) => setProblem(errorText(error));
  const halted = browserHalted(data.profile);
  const screenLink = (
    <a href={data.screenUrl} target="_blank" rel="noreferrer" className={PLAIN}>
      <ExternalLink size={14} aria-hidden /> Открыть экран браузера
    </a>
  );
  let main: ReactNode;
  if (state === "locked") {
    main = <p className="text-sm text-text-muted">Сначала прокси и выходной IP.</p>;
  } else if (state === "done") {
    main = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">Вход выполнен, браузер вернулся в автоматику. Если Fansly разлогинил браузер — откройте вход снова.</p>
        <button type="button" className={PLAIN} disabled={start.isPending} onClick={() => start.mutate(undefined, { onError: failure })}>
          Открыть вход снова
        </button>
      </div>
    );
  } else {
    switch (view.kind) {
      case "closed":
        main = (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">Браузер запустится, сам проверит выходной IP и откроет экран входа Fansly. Войдите в аккаунт новой страницы.</p>
            {view.problem !== null && <p role="alert" className="text-sm text-danger">Браузер не готов: {view.problem}.</p>}
            <button type="button" className={PRIMARY} disabled={view.problem !== null || start.isPending} onClick={() => start.mutate(undefined, { onError: failure })}>
              {start.isPending ? "Открываем…" : "Начать вход"}
            </button>
          </div>
        );
        break;
      case "preparing":
        main = (
          <p role="status" className="flex items-start gap-2 text-sm text-text-secondary">
            <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
            Браузер запускается: проверяет выходной IP и открывает экран входа Fansly…
          </p>
        );
        break;
      case "unreachable":
        main = halted
          ? <p role="alert" className="text-sm text-danger">Браузер стоит и экран входа не открыл: причина и что сделать — в шаге «Выходной IP».</p>
          : <p role="alert" className="text-sm text-danger">Hub не достучался до браузера. Подождите несколько секунд.</p>;
        break;
      case "form":
        main = <LoginForm view={view} step={step} onAnswer={(answer) => setProblem(stepProblemText(answer))} />;
        break;
      case "success":
        main = (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">Fansly принял вход. Завершите его: браузер вернётся в автоматику, и Hub проверит аккаунт через него.</p>
            <button type="button" className={PRIMARY} disabled={finish.isPending} onClick={() => finish.mutate(undefined, { onError: failure })}>
              {finish.isPending ? "Завершаем…" : "Завершить вход"}
            </button>
          </div>
        );
        break;
      case "unknown":
        main = (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">Браузер показывает экран, которого форма не знает: капча, проверка Fansly, новое соглашение. Ничего не нажато.</p>
            <p className="text-sm text-text-secondary">Откройте экран браузера и пройдите его сами — пароль экрана Hub подставит сам.</p>
            {screenLink}
          </div>
        );
        break;
      case "closing":
        main = (
          <p role="status" className="flex items-start gap-2 text-sm text-text-secondary">
            <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
            Останавливаем браузер: профиль остаётся, страница не создаётся.
          </p>
        );
        break;
    }
  }
  const open = data.login.state === "login";
  const chip = state !== "current" ? undefined : halted ? <ToneChip label="Браузер стоит" tone="danger" /> : <Chip view={view} />;
  return (
    <Card title={<StepTitle n={3} title="Вход в Fansly" state={state} />} aside={chip}>
      {main}
      {open && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {view.kind !== "unknown" && screenLink}
          {view.kind !== "success" && (
            <button type="button" className={PLAIN} disabled={finish.isPending} onClick={() => finish.mutate(undefined, { onError: failure })}>
              Закрыть вход
            </button>
          )}
        </div>
      )}
      {problem !== null && <p role="alert" className="mt-3 text-sm text-danger">{problem}</p>}
    </Card>
  );
}

function AccountStep({ data, state }: { data: PageBrowserProfileResponse; state: StepState }) {
  const profileId = data.profile.profileId;
  const verify = useVerifyPageBrowserProfile(profileId);
  const create = useCreatePageThroughBrowser(profileId);
  const models = useAdminModels();
  const navigate = useNavigate();
  const [modelSlug, setModelSlug] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const identity = data.identity;
  const label = data.profile.name;
  const chosen = modelSlug || models.data?.[0]?.slug || "";
  if (state === "locked") {
    return (
      <Card title={<StepTitle n={4} title="Аккаунт и страница" state={state} />} muted>
        <p className="text-sm text-text-muted">После входа Hub прочитает аккаунт через браузер и создаст страницу.</p>
      </Card>
    );
  }
  return (
    <Card title={<StepTitle n={4} title="Аккаунт и страница" state={state} />}>
      <div className="flex flex-col gap-3">
        {identity.pending ? (
          <p role="status" className="flex items-start gap-2 text-sm text-text-secondary">
            <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
            Hub читает аккаунт через браузер…
          </p>
        ) : identity.ok === true ? (
          <div className="rounded-lg border border-green/30 bg-green/5 px-3 py-2 text-sm text-green" data-identity="ok">
            Аккаунт: @{identity.username ?? "?"}{identity.displayName !== null && ` (${identity.displayName})`} · id <span className="font-mono">{identity.accountId}</span>
          </div>
        ) : identity.ok === false ? (
          <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">Проверка не прошла: {identity.error}</p>
        ) : (
          <p className="text-sm text-text-secondary">Hub отправит через браузер один запрос — какой это аккаунт — и запишет ответ.</p>
        )}
        <button type="button" className={PLAIN} disabled={verify.isPending || identity.pending}
          onClick={() => { setProblem(null); verify.mutate(undefined, { onError: (error) => setProblem(errorText(error)) }); }}>
          {verify.isPending ? "Проверяем…" : identity.ok === true ? "Проверить ещё раз" : "Проверить аккаунт"}
        </button>
        <form
          className="flex flex-col gap-3 border-t border-border pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            setProblem(null);
            create.mutate({ modelSlug: chosen, label }, {
              onError: (error) => setProblem(errorText(error)),
              onSuccess: () => navigate(buildPageRoute(label)),
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pb-model" className="text-sm text-text-secondary">Модель</label>
              <select id="pb-model" value={chosen} onChange={(event) => setModelSlug(event.target.value)} className={INPUT}>
                {(models.data ?? []).map((model) => <option key={model.slug} value={model.slug}>{model.name} ({model.slug})</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-text-secondary">Название страницы</span>
              <span className="rounded-lg border border-border bg-hover-alt px-3 py-2 font-mono text-sm text-text-primary">{label}</span>
            </div>
          </div>
          <button type="submit" className={PRIMARY} disabled={create.isPending || chosen === "" || identity.ok !== true}>
            {create.isPending ? "Создаём страницу…" : "Создать страницу"}
          </button>
          <p className="text-xs text-text-muted">
            Hub ещё раз прочитает аккаунт через браузер и в одной транзакции создаст страницу, привяжет к ней этот браузер и включит её сбор через браузер. Сессия Fansly остаётся только в профиле браузера.
          </p>
        </form>
        {problem !== null && <p role="alert" className="text-sm text-danger">{problem}</p>}
      </div>
    </Card>
  );
}

export function PageBrowserOnboardingPage() {
  const { profileId = "" } = useParams<{ profileId: string }>();
  const onboarding = usePageBrowserProfile(profileId);
  const close = useClosePageBrowserProfile(profileId);
  // The exit IP Hub saw through the proxy just saved: offered for the pin.
  const [exitIp, setExitIp] = useState<string | null>(null);
  const back = (
    <Link to={buildSettingsRoute("pages")} className="text-xs font-medium text-accent hover:underline">&larr; Страницы</Link>
  );
  if (onboarding.isPending) {
    return <div className="mb-5">{back}<p role="status" className="mt-3 text-sm text-text-muted">Загружаем…</p></div>;
  }
  if (onboarding.isError || onboarding.data === undefined) {
    const status = onboarding.error instanceof KernelApiError ? onboarding.error.status : null;
    return (
      <div>
        <div className="mb-5">{back}</div>
        {status === 404
          ? <StatusPanel tone="error" title="Такого браузера нет" description="Профиль удалён или не создавался." />
          : status === 409
            ? <StatusPanel title="Браузер уже привязан к странице" description="Его вход теперь — вход страницы (Синк → страница → «Вход в браузер»)." />
            : <StatusPanel tone="error" title="Не удалось загрузить подключение" description="Повторите попытку через несколько секунд."
                action={<button type="button" className={PLAIN} onClick={() => void onboarding.refetch()}>Повторить</button>} />}
      </div>
    );
  }
  const data = onboarding.data;
  const steps = onboardingStepsOf(data);
  const view = profileLoginViewOf(data);
  const live = data.login.state === "login" && view.kind !== "unreachable";
  const givingUp = data.login.state === "closing";
  return (
    <div>
      <div className="mb-5">
        {back}
        <h1 className="mt-1 text-xl font-extrabold text-text-primary">Подключение страницы · {data.profile.name}</h1>
        <p className="mt-1 text-sm text-text-muted">
          Новая страница входит в Fansly из своего серверного браузера — с его устройства и через его прокси. Пароль и код проходят через Hub и нигде не сохраняются.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col gap-4">
          <Card title="Экран браузера" aside={<span className="text-xs text-text-muted">{live ? "обновляется раз в секунду" : "показывается, пока открыт вход"}</span>}>
            <LiveScreenshot urlFor={(tick) => pageBrowserProfileScreenshotUrl(profileId, tick)} live={live} />
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <ProxyStep data={data} state={steps.proxy} exitIp={exitIp} onExitIp={setExitIp} />
          <PinStep data={data} state={steps.pin} suggested={exitIp} />
          <LoginStep data={data} state={steps.login} view={view} />
          <AccountStep data={data} state={steps.account} />
          <Card title="Если передумали">
            <div className="flex flex-col gap-2">
              <p className="text-sm text-text-secondary">
                Hub остановит браузер; профиль останется непривязанным. Удалить его с сервера: <span className="font-mono text-xs">scripts/deploy-page-browser.sh remove-profile &lt;host&gt; --page {data.profile.name}</span>.
              </p>
              <button type="button" className={PLAIN} disabled={givingUp || close.isPending || data.login.state === "off"} onClick={() => close.mutate(undefined)}>
                {givingUp ? "Останавливаем…" : "Отказаться от подключения"}
              </button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
