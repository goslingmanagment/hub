import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, ExternalLink, Lock } from "lucide-react";
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
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, Spinner } from "@/components/ui/Skeleton";
import { buildPageRoute, buildSettingsRoute } from "@/lib/navigation";
import { ServerAdminCommand } from "@/components/shared/ServerAdminCommand";
import { Card, Chip, LiveScreenshot, LoginForm, OpenLoginDialog, ToneChip } from "./loginParts.js";
import { browserHalted, browserStatusOf, onboardingStepsOf, profileLoginViewOf, stopReasonCode, type StepState } from "./pageBrowserOnboardingView.js";
import { ConnectSteps } from "./ConnectSteps.js";
import { pageBrowserErrorText } from "./pageBrowserErrors.js";
import { LoginProblem } from "./PageBrowserLoginPage.js";
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

const errorText = (error: unknown) => pageBrowserErrorText(error);

/** A step's card title: a check, a ring or a lock, then the words; the number is on the strip. */
function StepTitle({ title, state }: { n?: number; title: string; state: StepState }) {
  const icon = state === "done"
    ? <CheckCircle2 size={18} aria-hidden />
    : state === "locked" ? <Lock size={16} aria-hidden /> : <Circle size={18} aria-hidden />;
  return (
    <span className={`step-title step-title-${state}`} data-step-state={state}>
      {icon}
      <span>{title}</span>
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
    <Card title={<StepTitle n={1} title="Прокси" state={state} />} muted={state === "locked"}>
      {data.proxy !== null && (
        <p className="connect-env" data-proxy-saved>
          <span className="font-mono">{data.proxy.masked !== null ? maskedLine(data.proxy.masked) : data.proxy.url}</span>
        </p>
      )}
      {data.socksEndpoint !== null && (
        <p className="field-hint">Браузер создан для SOCKS5 <span className="font-mono">{data.socksEndpoint}</span>: другую прокси он не пропустит.</p>
      )}
      {data.env !== null && (
        <p className="field-hint">Окружение браузера: {envLine(data.env)}</p>
      )}
      {pasting && (
        <form onSubmit={submit} className="connect-fields connect-step-body" autoComplete="off">
          <ProxyPasteField id="pb-proxy" label={data.proxy === null ? "Прокси этой страницы" : "Новая прокси: тот же SOCKS5, другой логин или пароль"} text={text} onText={(value) => { setText(value); check.reset(); }} order={order} onOrder={setOrder} disabled={pending} />
          {checkPanel}
          <div className="connect-actions">
            <button type="submit" className="btn btn-primary" disabled={!ready || pending}>{pending ? <><Spinner /> Сохраняем…</> : "Сохранить"}</button>
            {data.proxy !== null && <button type="button" className="btn" onClick={() => { setReplacing(false); setText(""); check.reset(); }}>Отмена</button>}
            {checkId === null && preview.kind === "parsed" && <span className="field-hint">Сохранить можно после успешной проверки этой прокси</span>}
          </div>
        </form>
      )}
      {!pasting && <div className="connect-step-body">{checkPanel}</div>}
      {editable && data.proxy !== null && !replacing && (
        <div className="connect-step-body"><button type="button" className="btn btn-sm" onClick={() => { setReplacing(true); check.reset(); }}>Заменить прокси</button></div>
      )}
      {problem !== null && <p role="alert" className="field-error">{problem}</p>}
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
    <Card title={<StepTitle n={3} title="Выходной IP" state={state} />} aside={<ToneChip label={status.label} tone={status.tone} />} muted={state === "locked"}>
      <p className="login-text" data-browser-status>{status.detail}</p>
      {(stopReasonCode(data.profile) || (data.profile.operator.selfTest && !data.profile.operator.selfTest.ok)) && (
        <Disclosure label="Подробнее">
          {stopReasonCode(data.profile) && <p>Код остановки: <span className="font-mono">{stopReasonCode(data.profile)}</span></p>}
          {data.profile.operator.selfTest && !data.profile.operator.selfTest.ok && <p>Проверка при запуске: <span className="font-mono">{data.profile.operator.selfTest.failed ?? "без кода"}</span></p>}
        </Disclosure>
      )}
      {data.profile.pinnedExitIp !== null && (
        <p className="login-text">Закреплён: <span className="font-mono text-text-primary">{data.profile.pinnedExitIp}</span></p>
      )}
      {editable && (
        <form
          className="connect-pin"
          onSubmit={(event) => {
            event.preventDefault();
            setProblem(null);
            pin.mutate(value.trim(), { onError: (error) => setProblem(errorText(error)), onSuccess: () => setIp("") });
          }}
        >
          <input value={value} onChange={(event) => setIp(event.target.value)} placeholder="203.0.113.7" className="input font-mono" aria-label="Выходной IP" />
          <button type="submit" className="btn" disabled={value.trim() === "" || pin.isPending}>
            {pin.isPending ? <><Spinner /> Закрепляем…</> : data.profile.pinnedExitIp === null ? "Закрепить" : halted ? "Закрепить и перезапустить" : "Закрепить другой"}
          </button>
        </form>
      )}
      <p className="field-hint">
        Браузер выйдет в сеть, только если сам увидит через прокси этот IP. Иначе он остановится и ничего не отправит в Fansly.
      </p>
      {problem !== null && <p role="alert" className="field-error">{problem}</p>}
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
      <ExternalLink size={16} aria-hidden /> Открыть экран браузера
    </a>
  );
  let main: ReactNode;
  if (state === "locked") {
    main = <p className="login-text">Сначала прокси и выходной IP.</p>;
  } else if (state === "done") {
    main = (
      <div className="login-form">
        <p className="login-text">Вход выполнен, браузер вернулся к работе. Если Fansly вышел из аккаунта, откройте вход снова.</p>
        <button type="button" className="btn connect-self-start" disabled={start.isPending} onClick={() => start.mutate(undefined, { onError: failure })}>
          Открыть вход снова
        </button>
      </div>
    );
  } else {
    switch (view.kind) {
      case "closed":
        main = (
          <div className="login-form">
            <p className="login-text">Браузер запустится, сам проверит выходной IP и откроет экран входа Fansly. Войдите в аккаунт новой страницы.</p>
            {view.problem !== null && <LoginProblem problem={view.problem ? `Браузер не готов: ${view.problem}.` : "Браузер не готов."} />}
            <button type="button" className="btn btn-primary login-wide" disabled={view.problem !== null || start.isPending} onClick={() => start.mutate(undefined, { onError: failure })}>
              {start.isPending ? <><Spinner /> Открываем…</> : "Начать вход"}
            </button>
          </div>
        );
        break;
      case "preparing":
        main = (
          <p role="status" className="login-status"><Spinner /> Браузер запускается: проверяет выходной IP и открывает экран входа Fansly…</p>
        );
        break;
      case "unreachable":
        main = halted
          ? <LoginProblem problem="Браузер стоит и экран входа не открыл: причина и что сделать в шаге «Выходной IP»." />
          : <LoginProblem problem="Hub не достучался до браузера. Подождите несколько секунд." />;
        break;
      case "landing":
        main = <OpenLoginDialog step={step} onAnswer={(answer) => setProblem(stepProblemText(answer))} />;
        break;
      case "form":
        main = <LoginForm view={view} step={step} onAnswer={(answer) => setProblem(stepProblemText(answer))} />;
        break;
      case "success":
        main = (
          <div className="login-form">
            <p className="login-text">Fansly принял вход. Завершите его: браузер вернётся к работе, и Hub проверит аккаунт через него.</p>
            <button type="button" className="btn btn-primary login-wide" disabled={finish.isPending} onClick={() => finish.mutate(undefined, { onError: failure })}>
              {finish.isPending ? <><Spinner /> Завершаем…</> : "Завершить вход"}
            </button>
          </div>
        );
        break;
      case "unknown":
        main = (
          <div className="login-form">
            <p className="login-text">Браузер показывает экран, которого форма не знает: капча, проверка Fansly, новое соглашение или изменённая форма. Ничего не нажато.</p>
            <p className="login-text">Откройте экран браузера и пройдите его сами: пароль экрана Hub подставит сам. Потом вернитесь сюда.</p>
            {screenLink}
          </div>
        );
        break;
      case "closing":
        main = (
          <p role="status" className="login-status"><Spinner /> Останавливаем браузер: профиль остаётся, страница не создаётся.</p>
        );
        break;
    }
  }
  const open = data.login.state === "login";
  const chip = state !== "current" ? undefined : halted ? <ToneChip label="Браузер стоит" tone="danger" /> : <Chip view={view} />;
  return (
    <Card title={<StepTitle n={4} title="Вход в Fansly" state={state} />} aside={chip} muted={state === "locked"}>
      {main}
      {open && (
        <div className="login-actions connect-step-foot">
          {view.kind !== "unknown" && screenLink}
          {view.kind !== "success" && (
            <button type="button" className="btn" disabled={finish.isPending} onClick={() => finish.mutate(undefined, { onError: failure })}>
              Закрыть вход
            </button>
          )}
        </div>
      )}
      <LoginProblem problem={problem} />
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
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const identity = data.identity;
  const label = data.profile.name;
  const chosen = modelSlug || models.data?.[0]?.slug || "";
  const modelName = models.data?.find((model) => model.slug === chosen)?.name ?? chosen;
  if (state === "locked") {
    return (
      <Card title={<StepTitle n={5} title="Аккаунт и страница" state={state} />} muted>
        <p className="login-text">После входа Hub прочитает аккаунт через браузер и создаст страницу.</p>
      </Card>
    );
  }
  const account = identity.ok === true ? `@${identity.username ?? "?"}${identity.displayName !== null ? ` (${identity.displayName})` : ""}` : null;
  return (
    <Card title={<StepTitle n={5} title="Аккаунт и страница" state={state} />}>
      <div className="login-form">
        {identity.pending ? (
          <p role="status" className="login-status"><Spinner /> Hub читает аккаунт через браузер…</p>
        ) : identity.ok === true ? (
          <div className="notice notice-success" data-identity="ok">
            <CheckCircle2 size={18} aria-hidden />
            <div className="notice-body">
              Аккаунт: {account}
              <Disclosure label="Подробнее"><p>Номер аккаунта: <span className="font-mono">{identity.accountId}</span></p></Disclosure>
            </div>
          </div>
        ) : identity.ok === false ? (
          <LoginProblem problem={`Проверка не прошла: ${identity.error}`} />
        ) : (
          <p className="login-text">Hub отправит через браузер один запрос: какой это аккаунт, и запишет ответ.</p>
        )}
        <button type="button" className="btn connect-self-start" disabled={verify.isPending || identity.pending}
          onClick={() => { setProblem(null); verify.mutate(undefined, { onError: (error) => setProblem(errorText(error)) }); }}>
          {verify.isPending ? <><Spinner /> Проверяем…</> : identity.ok === true ? "Проверить ещё раз" : "Проверить аккаунт"}
        </button>
        <form
          className="login-form connect-step-foot"
          onSubmit={(event) => {
            event.preventDefault();
            setProblem(null);
            setAskError(null);
            setAsking(true);
          }}
        >
          <div className="connect-env-grid">
            <div>
              <label htmlFor="pb-model" className="field-label">Модель</label>
              <select id="pb-model" value={chosen} onChange={(event) => setModelSlug(event.target.value)} className="select">
                {(models.data ?? []).map((model) => <option key={model.slug} value={model.slug}>{model.name}</option>)}
              </select>
            </div>
            <div>
              <span className="field-label">Название страницы</span>
              <span className="connect-readonly">{label}</span>
            </div>
          </div>
          <button type="submit" className="btn btn-primary login-wide" disabled={create.isPending || chosen === "" || identity.ok !== true}>
            {create.isPending ? <><Spinner /> Создаём страницу…</> : "Создать страницу"}
          </button>
          <p className="field-hint">
            Hub ещё раз прочитает аккаунт через браузер, создаст страницу, привяжет к ней этот браузер и включит сбор данных: всё одним шагом. Сессия Fansly остаётся только в профиле браузера.
          </p>
        </form>
        {problem !== null && <LoginProblem problem={problem} />}
      </div>
      {asking && (
        <ConfirmModal
          title={`Создать страницу ${label}?`}
          message="Hub создаст страницу, привяжет к ней этот браузер и включит сбор данных."
          facts={[
            { label: "Куда", value: `модель ${modelName}, страница ${label}, Fansly` },
            { label: "Что именно", value: account ? `аккаунт ${account}` : "аккаунт этого браузера" },
            { label: "Отменить", value: "Отключить страницу можно в «Модели и страницы», вернуть её из консоли нельзя" },
          ]}
          confirmLabel={`Создать страницу ${label}`}
          pendingLabel="Создаём страницу…"
          tone="primary"
          error={askError}
          isPending={create.isPending}
          // The request as before: the profile from the path, the model from the field, one attempt.
          onConfirm={() => create.mutate({ modelSlug: chosen, label }, {
            onError: (error) => setAskError(errorText(error)),
            onSuccess: () => navigate(buildPageRoute(label)),
          })}
          onClose={() => setAsking(false)}
        />
      )}
    </Card>
  );
}

function GiveUp({ data, profileId }: { data: PageBrowserProfileResponse; profileId: string }) {
  const close = useClosePageBrowserProfile(profileId);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const givingUp = data.login.state === "closing";
  const name = data.profile.name;
  return (
    <Card title="Если передумали">
      <div className="login-form">
        <p className="login-text">Hub остановит браузер. Профиль останется на сервере непривязанным.</p>
        <button type="button" className="btn btn-danger-outline connect-self-start" disabled={givingUp || close.isPending || data.login.state === "off"} onClick={() => { setAskError(null); setAsking(true); }}>
          {givingUp || close.isPending ? <><Spinner /> Останавливаем…</> : "Отказаться от подключения"}
        </button>
        <ServerAdminCommand
          text="Чтобы удалить профиль с сервера, выполните на рабочей машине:"
          command={`scripts/deploy-page-browser.sh remove-profile <host> --page ${name}`}
        />
      </div>
      {asking && (
        <ConfirmModal
          title={`Отказаться от подключения ${name}?`}
          message="Hub остановит браузер. Страница не создаётся, профиль останется на сервере непривязанным."
          facts={[
            { label: "Куда", value: `браузер ${name}, Fansly` },
            { label: "Отменить", value: "Можно: вход можно начать снова" },
          ]}
          confirmLabel="Отказаться от подключения"
          pendingLabel="Останавливаем…"
          tone="primary"
          error={askError}
          isPending={close.isPending}
          // The request as before: the profile from the path, one attempt.
          onConfirm={() => close.mutate(undefined, {
            onSuccess: () => setAsking(false),
            onError: (error) => setAskError(errorText(error)),
          })}
          onClose={() => setAsking(false)}
        />
      )}
    </Card>
  );
}

export function PageBrowserOnboardingPage() {
  const { profileId = "" } = useParams<{ profileId: string }>();
  const onboarding = usePageBrowserProfile(profileId);
  // The exit IP the owner's check saw through the proxy: offered for the pin
  // (a preview — the browser checks its own before it opens its exit).
  const [exitIp, setExitIp] = useState<string | null>(null);
  if (onboarding.isPending) {
    return (
      <div className="connect-page">
        <PageHeader title="Подключить страницу Fansly" />
        <Skeleton width="60%" />
      </div>
    );
  }
  if (onboarding.isError || onboarding.data === undefined) {
    const status = onboarding.error instanceof KernelApiError ? onboarding.error.status : null;
    return (
      <div className="connect-page">
        <PageHeader title="Подключить страницу Fansly" />
        {status === 404
          ? <StatusPanel title="Такого браузера нет" description="Профиль удалён или не создавался." />
          : status === 409
            ? <StatusPanel title="Браузер уже привязан к странице" description="Вход в него открывается с карточки страницы."
                action={<Link to={buildSettingsRoute("pages")} className="btn btn-sm">К моделям и страницам</Link>} />
            : <NoAnswerPanel retry={onboarding.refetch} />}
      </div>
    );
  }
  const data = onboarding.data;
  const steps = onboardingStepsOf(data);
  const view = profileLoginViewOf(data);
  const live = data.login.state === "login" && view.kind !== "unreachable";
  return (
    <div className="connect-page">
      <PageHeader
        title={`Подключить страницу Fansly · ${data.profile.name}`}
        description="Страница входит в Fansly из своего серверного браузера. Пароль и код проходят через Hub и нигде не сохраняются."
      />
      <ConnectSteps states={[steps.proxy, "done", steps.pin, steps.login, steps.account]} />
      <div className="connect-grid">
        <div className="connect-screen">
          <Card title="Экран браузера" aside={<span className="login-card-note">{live ? "обновляется раз в секунду" : "показывается, пока открыт вход"}</span>}>
            <LiveScreenshot urlFor={(tick) => pageBrowserProfileScreenshotUrl(profileId, tick)} live={live} />
          </Card>
        </div>
        <div className="connect-steps-column">
          <ProxyStep data={data} state={steps.proxy} onExitIp={setExitIp} />
          <PinStep data={data} state={steps.pin} suggested={exitIp} />
          <LoginStep data={data} state={steps.login} view={view} />
          <AccountStep data={data} state={steps.account} />
          <GiveUp data={data} profileId={profileId} />
        </div>
      </div>
    </div>
  );
}
