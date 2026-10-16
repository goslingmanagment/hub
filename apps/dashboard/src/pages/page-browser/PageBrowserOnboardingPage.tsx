import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, ExternalLink, Lock, RefreshCw } from "lucide-react";
import type { PageBrowserProfileResponse } from "@agency_hub_core/contracts";
import type { PastedProxyOrder } from "@agency_hub_core/shared";

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
import { PageHeader } from "@/components/ui/PageHeader";
import { buildPageRoute, buildSettingsRoute } from "@/lib/navigation";
import { Card, Chip, LiveScreenshot, LoginForm, OpenLoginDialog, ServerAdminCommand, ToneChip } from "./loginParts.js";
import { browserHalted, browserStatusOf, onboardingStepsOf, profileLoginViewOf, type StepState } from "./pageBrowserOnboardingView.js";
import { ProxyCheckPanel, ProxyPasteField, useProxyCheck } from "./proxyEntryParts.js";
import { asSocks5Text, envLine, maskedLine, proxyPreviewOf } from "./proxyEntryView.js";
import { stepProblemText, type LoginView } from "./pageBrowserLoginView.js";

// A new page connected through its own server browser (Project Browser plan
// §3.2 «Подключение новой страницы через браузер»; PR 16): the profile that
// `deploy-page-browser.sh add-profile` made from the owner's draft, its
// proxy (given in the draft; checked again or replaced here in one pasted
// field — owner decision 2026-10-15), the exit IP its browser checks itself, the owner's login through PR 15's form, the account
// read through the browser, the page created and bound. What is typed — the
// proxy's password, the login, the password, the code — goes straight to
// the API and is kept nowhere here.

const errorText = (error: unknown) => (error instanceof KernelApiError ? error.message : "Не удалось. Повторите попытку.");

function StepTitle({ n, title, state }: { n: number; title: string; state: StepState }) {
  const icon = state === "done"
    ? <CheckCircle2 size={16} className="text-green" aria-hidden />
    : state === "locked" ? <Lock size={14} className="text-text-secondary" aria-hidden /> : <Circle size={16} className="text-accent" aria-hidden />;
  return (
    <span className="inline-flex items-center gap-2" data-step-state={state}>
      {icon}
      <span>{n}. {title}</span>
    </span>
  );
}

function ProxyStep({ data, state, onExitIp }: { data: PageBrowserProfileResponse; state: StepState; onExitIp: (ip: string | null) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [order, setOrder] = useState<PastedProxyOrder | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const check = useProxyCheck();
  const editable = data.login.state !== "login" && data.login.state !== "closing";
  const pasting = editable && (data.proxy === null || replacing);
  const preview = proxyPreviewOf(text, order);
  // Saved only after a check of this very text that logged in through it:
  // the address it connected to is the one kept.
  const checkId = pasting ? check.result?.checkId ?? null : null;
  const ready = preview.kind === "parsed" && preview.problem === null && checkId !== null;
  const runCheck = () => {
    const source = pasting
      ? (preview.kind === "parsed" ? { kind: "text" as const, proxy: { text, ...(order === null ? {} : { order }) } } : null)
      : { kind: "profile" as const, profileId: data.profile.profileId };
    if (source === null) return;
    void check.run(source).then((answer) => onExitIp(answer?.ok === true && answer.exit !== null ? answer.exit.ip : null));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || pending || checkId === null) return;
    setPending(true);
    setProblem(null);
    const proxy = { text, ...(order === null ? {} : { order }) };
    // The proxy's password leaves the field at once: it goes to the API, and
    // nothing keeps it after (no query cache).
    setText("");
    setOrder(null);
    sendPageBrowserProfileProxy(qc, data.profile.profileId, proxy, checkId)
      .then(() => { setReplacing(false); check.reset(); }, (error: unknown) => setProblem(errorText(error)))
      .finally(() => setPending(false));
  };
  // First the check, then the save: the address it connected to is the one kept.
  const checkPanel = (
    <ProxyCheckPanel
      check={check}
      onCheck={runCheck}
      disabled={pasting ? preview.kind !== "parsed" : data.proxy === null}
      onUseAsSocks5={pasting ? () => {
        const socks = asSocks5Text(text, order);
        if (socks !== null) {
          setText(socks);
          check.reset();
        }
      } : undefined}
    />
  );
  return (
    <Card title={<StepTitle n={1} title="Прокси страницы" state={state} />}>
      {data.proxy !== null && (
        <p className="mb-1 text-sm text-text-secondary" data-proxy-saved>
          {data.proxy.masked !== null ? <span className="font-mono text-text-primary">{maskedLine(data.proxy.masked)}</span> : <span className="font-mono text-text-primary">{data.proxy.url}</span>}
        </p>
      )}
      {data.socksEndpoint !== null && (
        <p className="mb-3 text-xs text-text-secondary">Браузер создан для SOCKS5 <span className="font-mono">{data.socksEndpoint}</span>: другую прокси он не пропустит.</p>
      )}
      {data.env !== null && (
        <p className="mb-3 text-xs text-text-secondary">Окружение браузера: <span className="text-text-primary">{envLine(data.env)}</span></p>
      )}
      {pasting && (
        <form onSubmit={submit} className="mb-3 flex flex-col gap-2" autoComplete="off">
          <ProxyPasteField id="pb-proxy" label={data.proxy === null ? "Прокси этой страницы" : "Новая прокси — тот же SOCKS5, другой логин или пароль"} text={text} onText={(value) => { setText(value); check.reset(); }} order={order} onOrder={setOrder} disabled={pending} />
          {checkPanel}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn btn-primary" disabled={!ready || pending}>{pending ? "Сохраняем…" : "Сохранить"}</button>
            {data.proxy !== null && <button type="button" className="btn" onClick={() => { setReplacing(false); setText(""); check.reset(); }}>Отмена</button>}
            {checkId === null && preview.kind === "parsed" && <span className="text-xs text-text-secondary">Сохранить — после успешной проверки этой прокси</span>}
          </div>
        </form>
      )}
      {!pasting && checkPanel}
      {editable && data.proxy !== null && !replacing && (
        <button type="button" className="btn btn-sm mt-3" onClick={() => { setReplacing(true); check.reset(); }}>Заменить прокси</button>
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
          <input value={value} onChange={(event) => setIp(event.target.value)} placeholder="203.0.113.7" className="input flex-1 font-mono" aria-label="Выходной IP" />
          <button type="submit" className="btn" disabled={value.trim() === "" || pin.isPending}>
            {pin.isPending ? "Закрепляем…" : data.profile.pinnedExitIp === null ? "Закрепить" : halted ? "Закрепить и перезапустить" : "Закрепить другой"}
          </button>
        </form>
      )}
      <p className="field-hint">
        Браузер выйдет в сеть, только если сам увидит через прокси этот IP; иначе он остановится и ничего не отправит в Fansly.
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
    <a href={data.screenUrl} target="_blank" rel="noreferrer" className="btn">
      <ExternalLink size={14} aria-hidden /> Открыть экран браузера
    </a>
  );
  let main: ReactNode;
  if (state === "locked") {
    main = <p className="text-sm text-text-secondary">Сначала прокси и выходной IP.</p>;
  } else if (state === "done") {
    main = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">Вход выполнен, браузер вернулся в автоматику. Если Fansly разлогинил браузер — откройте вход снова.</p>
        <button type="button" className="btn self-start" disabled={start.isPending} onClick={() => start.mutate(undefined, { onError: failure })}>
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
            <button type="button" className="btn btn-primary w-full" disabled={view.problem !== null || start.isPending} onClick={() => start.mutate(undefined, { onError: failure })}>
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
      case "landing":
        main = <OpenLoginDialog step={step} onAnswer={(answer) => setProblem(stepProblemText(answer))} />;
        break;
      case "form":
        main = <LoginForm view={view} step={step} onAnswer={(answer) => setProblem(stepProblemText(answer))} />;
        break;
      case "success":
        main = (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">Fansly принял вход. Завершите его: браузер вернётся в автоматику, и Hub проверит аккаунт через него.</p>
            <button type="button" className="btn btn-primary w-full" disabled={finish.isPending} onClick={() => finish.mutate(undefined, { onError: failure })}>
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
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border-light pt-4">
          {view.kind !== "unknown" && screenLink}
          {view.kind !== "success" && (
            <button type="button" className="btn" disabled={finish.isPending} onClick={() => finish.mutate(undefined, { onError: failure })}>
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
        <p className="text-sm text-text-secondary">После входа Hub прочитает аккаунт через браузер и создаст страницу.</p>
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
          <div className="notice notice-success block" data-identity="ok">
            Аккаунт: @{identity.username ?? "?"}{identity.displayName !== null && ` (${identity.displayName})`} · id <span className="font-mono">{identity.accountId}</span>
          </div>
        ) : identity.ok === false ? (
          <p role="alert" className="notice notice-danger">Проверка не прошла: {identity.error}</p>
        ) : (
          <p className="text-sm text-text-secondary">Hub отправит через браузер один запрос — какой это аккаунт — и запишет ответ.</p>
        )}
        <button type="button" className="btn self-start" disabled={verify.isPending || identity.pending}
          onClick={() => { setProblem(null); verify.mutate(undefined, { onError: (error) => setProblem(errorText(error)) }); }}>
          {verify.isPending ? "Проверяем…" : identity.ok === true ? "Проверить ещё раз" : "Проверить аккаунт"}
        </button>
        <form
          className="flex flex-col gap-3 border-t border-border-light pt-4"
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
            <div>
              <label htmlFor="pb-model" className="field-label">Модель</label>
              <select id="pb-model" value={chosen} onChange={(event) => setModelSlug(event.target.value)} className="select">
                {(models.data ?? []).map((model) => <option key={model.slug} value={model.slug}>{model.name}</option>)}
              </select>
            </div>
            <div>
              <span className="field-label">Название страницы</span>
              <span className="block rounded-lg border border-border bg-hover-alt px-3 py-2 font-mono text-sm text-text-primary">{label}</span>
            </div>
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={create.isPending || chosen === "" || identity.ok !== true}>
            {create.isPending ? "Создаём страницу…" : "Создать страницу"}
          </button>
          <p className="text-xs text-text-secondary">
            Hub ещё раз прочитает аккаунт через браузер, создаст страницу, привяжет к ней этот браузер и включит сбор данных через него — всё одним шагом. Сессия Fansly остаётся только в профиле браузера.
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
  // The exit IP the owner's check saw through the proxy: offered for the pin
  // (a preview — the browser checks its own before it opens its exit).
  const [exitIp, setExitIp] = useState<string | null>(null);
  if (onboarding.isPending) {
    return <div className="min-w-0"><PageHeader title="Подключение страницы" /><p role="status" className="text-sm text-text-secondary">Загружаем…</p></div>;
  }
  if (onboarding.isError || onboarding.data === undefined) {
    const status = onboarding.error instanceof KernelApiError ? onboarding.error.status : null;
    return (
      <div className="min-w-0">
        <PageHeader title="Подключение страницы" />
        {status === 404
          ? <StatusPanel tone="error" title="Такого браузера нет" description="Профиль удалён или не создавался." />
          : status === 409
            ? <StatusPanel title="Браузер уже привязан к странице" description="Вход в него теперь открывается со страницы: «Система → Сбор данных → Fansly» → страница → «Вход в браузер»."
                action={<Link to={buildSettingsRoute("engine")} className="btn btn-sm">Открыть сбор данных Fansly</Link>} />
            : <StatusPanel tone="error" title="Не удалось загрузить подключение" description="Повторите попытку через несколько секунд."
                action={<button type="button" className="btn btn-sm" onClick={() => void onboarding.refetch()}>Повторить</button>} />}
      </div>
    );
  }
  const data = onboarding.data;
  const steps = onboardingStepsOf(data);
  const view = profileLoginViewOf(data);
  const live = data.login.state === "login" && view.kind !== "unreachable";
  const givingUp = data.login.state === "closing";
  return (
    <div className="min-w-0">
      <PageHeader
        title={`Подключение страницы · ${data.profile.name}`}
        description="Страница входит в Fansly из своего серверного браузера; пароль и код проходят через Hub и нигде не сохраняются."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col gap-4">
          <Card title="Экран браузера" aside={<span className="text-xs text-text-secondary">{live ? "обновляется раз в секунду" : "показывается, пока открыт вход"}</span>}>
            <LiveScreenshot urlFor={(tick) => pageBrowserProfileScreenshotUrl(profileId, tick)} live={live} />
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <ProxyStep data={data} state={steps.proxy} onExitIp={setExitIp} />
          <PinStep data={data} state={steps.pin} suggested={exitIp} />
          <LoginStep data={data} state={steps.login} view={view} />
          <AccountStep data={data} state={steps.account} />
          <Card title="Если передумали">
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">
                Hub остановит браузер; профиль останется на сервере непривязанным.
              </p>
              <button type="button" className="btn self-start" disabled={givingUp || close.isPending || data.login.state === "off"} onClick={() => close.mutate(undefined)}>
                {givingUp ? "Останавливаем…" : "Отказаться от подключения"}
              </button>
              <ServerAdminCommand
                text="Чтобы удалить профиль с сервера, выполните на рабочей машине:"
                command={`scripts/deploy-page-browser.sh remove-profile <host> --page ${data.profile.name}`}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
