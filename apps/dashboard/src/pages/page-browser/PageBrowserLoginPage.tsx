import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ExternalLink, MonitorSmartphone, RefreshCw } from "lucide-react";
import type { PageBrowserLoginResponse, PageBrowserLoginStepResponse } from "@agency_hub_core/contracts";

import {
  pageBrowserScreenshotUrl,
  useFinishPageBrowserLogin,
  usePageBrowserLogin,
  usePageBrowserLoginStep,
  useStartPageBrowserLogin,
  type PageBrowserLoginStep,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { buildSettingsRoute, decodeRouteSegment } from "@/lib/navigation";
import { loginChipOf, loginViewOf, stepProblemText, wantsCode, type LoginView, type Tone } from "./pageBrowserLoginView.js";

// The owner logs a page's server browser in (Project Browser plan §4.8,
// PR 15): the browser's live screenshot, the fields Fansly asks for now, the
// site's error, and the browser's own screen for what the form does not
// know. What is typed goes to the page's browser through Hub and is kept
// nowhere; the fields are cleared once a step was sent.

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-hover-alt text-text-secondary",
  progress: "border-accent/30 bg-accent/10 text-accent",
  good: "border-green/30 bg-green/10 text-green",
  warning: "border-warning/30 bg-warning/10 text-warning-dark",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

const INPUT = "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const PRIMARY = "w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50";
const PLAIN = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-hover disabled:opacity-50";

function Chip({ view }: { view: LoginView }) {
  const chip = loginChipOf(view);
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONES[chip.tone]}`} data-login-view={view.kind}>
      {chip.label}
    </span>
  );
}

function Card({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The browser as it shows now: a new screenshot each second while this
 *  page is open and visible, the last one kept on screen meanwhile. */
function LiveScreenshot({ pageLabel, live }: { pageLabel: string; live: boolean }) {
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const next = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (document.visibilityState === "visible") setTick((value) => value + 1);
      else next();
    }, 1_000);
  };
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (!live) {
      setShown(null);
      setFailed(false);
    }
  }, [live]);
  const url = pageBrowserScreenshotUrl(pageLabel, tick);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-hover-alt">
      {shown !== null && <img src={shown} alt="Экран серверного браузера" className="absolute inset-0 h-full w-full object-contain" />}
      {live && (
        // The next screenshot loads unseen and replaces the shown one.
        <img
          key={url}
          src={url}
          alt=""
          aria-hidden
          className="hidden"
          onLoad={() => {
            setShown(url);
            setFailed(false);
            next();
          }}
          onError={() => {
            setFailed(true);
            next();
          }}
        />
      )}
      {shown === null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-text-muted">
          <MonitorSmartphone size={28} className="text-text-muted" aria-hidden />
          {live ? (failed ? "Снимка пока нет: браузер ещё не открыл экран входа." : "Загружаем снимок…") : "Снимок появится, когда вход открыт."}
        </div>
      )}
    </div>
  );
}

function SiteError({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
      <span className="font-semibold">Fansly:</span> {text}
    </p>
  );
}

function LoginForm({ pageLabel, view, onAnswer }: { pageLabel: string; view: Extract<LoginView, { kind: "form" }>; onAnswer: (answer: PageBrowserLoginStepResponse) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const { pending, send } = usePageBrowserLoginStep(pageLabel);
  const codeStep = wantsCode(view);
  const handle = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const step: PageBrowserLoginStep = codeStep ? { kind: "code", code: code.trim() } : { kind: "submit", login: login.trim(), password };
    // The password and the code leave the form at once: the step carries
    // them to the API, and nothing keeps them after it (no query cache).
    setPassword("");
    setCode("");
    send(step).then(onAnswer, () => onAnswer({ screen: null, refused: null, unreachable: true }));
  };
  return (
    <form onSubmit={handle} className="flex flex-col gap-3" aria-busy={pending} autoComplete="off">
      {view.siteError !== null && <SiteError text={view.siteError} />}
      {codeStep ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pb-code" className="text-sm text-text-secondary">Код 2FA</label>
          <input id="pb-code" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={code} disabled={pending}
            onChange={(event) => setCode(event.target.value)} placeholder="Код из приложения" className={`${INPUT} tracking-widest`} required maxLength={32} />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pb-login" className="text-sm text-text-secondary">Логин или e-mail Fansly</label>
            <input id="pb-login" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={login} disabled={pending}
              onChange={(event) => setLogin(event.target.value)} placeholder="username или почта" className={INPUT} required maxLength={320} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pb-password" className="text-sm text-text-secondary">Пароль</label>
            <input id="pb-password" type="password" autoComplete="new-password" value={password} disabled={pending}
              onChange={(event) => setPassword(event.target.value)} placeholder="Можно вставить из 1Password" className={INPUT} required maxLength={1024} />
          </div>
        </>
      )}
      <button type="submit" className={PRIMARY} disabled={pending || (codeStep ? code.trim() === "" : login.trim() === "" || password === "")}>
        {pending ? "Передаём в браузер…" : codeStep ? "Подтвердить код" : "Войти"}
      </button>
      <p className="text-xs text-text-muted">
        Браузер страницы сам вставит {codeStep ? "код" : "логин и пароль"} в форму Fansly и нажмёт кнопку. Hub их не сохраняет.
      </p>
    </form>
  );
}

function Body({ data, view, pageLabel }: { data: PageBrowserLoginResponse; view: LoginView; pageLabel: string }) {
  const start = useStartPageBrowserLogin(pageLabel);
  const finish = useFinishPageBrowserLogin(pageLabel);
  const [problem, setProblem] = useState<string | null>(null);
  const failure = (error: unknown) => setProblem(error instanceof KernelApiError ? error.message : "Не удалось. Повторите попытку.");
  const screenLink = (
    <a href={data.screenUrl} target="_blank" rel="noreferrer" className={PLAIN}>
      <ExternalLink size={14} aria-hidden /> Открыть экран браузера
    </a>
  );
  const finishButton = (label: string, primary = false) => (
    <button type="button" className={primary ? PRIMARY : PLAIN} disabled={finish.isPending}
      onClick={() => finish.mutate(undefined, { onError: failure })}>
      {finish.isPending ? "Завершаем…" : label}
    </button>
  );
  let main: ReactNode;
  switch (view.kind) {
    case "closed":
      main = (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            Браузер страницы работает сам. Откройте вход, если Fansly разлогинил браузер или страницу подключают заново: на время входа страница встанет на паузу.
          </p>
          {view.problem !== null && <p role="alert" className="text-sm text-danger">Браузер страницы не готов: {view.problem}.</p>}
          <button type="button" className={PRIMARY} disabled={view.problem !== null || start.isPending}
            onClick={() => start.mutate(undefined, { onError: failure })}>
            {start.isPending ? "Открываем…" : "Начать вход"}
          </button>
        </div>
      );
      break;
    case "preparing":
      main = (
        <p role="status" className="flex items-start gap-2 text-sm text-text-secondary">
          <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
          Страница на паузе. Браузер переходит в режим ручного входа и открывает экран входа Fansly…
        </p>
      );
      break;
    case "unreachable":
      main = <p role="alert" className="text-sm text-danger">Hub не достучался до браузера страницы. Подождите несколько секунд или завершите вход.</p>;
      break;
    case "form":
      main = <LoginForm pageLabel={pageLabel} view={view} onAnswer={(answer) => setProblem(stepProblemText(answer))} />;
      break;
    case "success":
      main = (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            Fansly принял вход. Завершите его: Hub проверит аккаунт, сессию и выходной IP и только потом вернёт странице работу.
          </p>
          {finishButton("Завершить вход", true)}
        </div>
      );
      break;
    case "unknown":
      main = (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            Браузер показывает экран, которого форма не знает: капча, проверка Fansly, новое соглашение или изменённая форма. Ничего не нажато.
          </p>
          <p className="text-sm text-text-secondary">Откройте экран браузера и пройдите его сами — пароль экрана Hub подставит сам. Потом вернитесь сюда.</p>
          {screenLink}
        </div>
      );
      break;
    case "closing":
      main = (
        <p role="status" className="flex items-start gap-2 text-sm text-text-secondary">
          <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
          Возвращаем автоматику: браузер выходит из режима входа, Hub снимает паузу.
        </p>
      );
      break;
  }
  const open = view.kind !== "closed" && view.kind !== "closing";
  return (
    <div className="flex flex-col gap-3">
      <Card title="Вход в Fansly" aside={<Chip view={view} />}>
        {main}
        {problem !== null && <p role="alert" className="mt-3 text-sm text-danger">{problem}</p>}
      </Card>
      {open && (
        <Card title="Если что-то пошло не так">
          <div className="flex flex-col gap-2">
            {view.kind !== "unknown" && screenLink}
            {view.kind !== "success" && finishButton("Завершить вход без входа")}
            <p className="text-xs text-text-muted">Пока вход открыт, страница стоит на паузе.</p>
          </div>
        </Card>
      )}
    </div>
  );
}

export function PageBrowserLoginPage() {
  const { pageLabel: raw = "" } = useParams<{ pageLabel: string }>();
  const pageLabel = decodeRouteSegment(raw);
  const login = usePageBrowserLogin(pageLabel);
  const header = (
    <div className="mb-5">
      <Link to={buildSettingsRoute("engine", pageLabel)} className="text-xs font-medium text-accent hover:underline">&larr; Синк страницы</Link>
      <h1 className="mt-1 text-xl font-extrabold text-text-primary">Вход в браузер · {pageLabel}</h1>
      <p className="mt-1 text-sm text-text-muted">Серверный браузер страницы входит в Fansly со своего устройства и IP. Пароль и код проходят через Hub и нигде не сохраняются.</p>
    </div>
  );
  if (login.isPending) {
    return <div>{header}<p role="status" className="text-sm text-text-muted">Загружаем…</p></div>;
  }
  if (login.isError || login.data === undefined) {
    const notFound = login.error instanceof KernelApiError && login.error.status === 404;
    return (
      <div>
        {header}
        {notFound
          ? <StatusPanel tone="error" title="Такой страницы нет" />
          : <StatusPanel tone="error" title="Не удалось загрузить вход" description="Повторите попытку через несколько секунд."
              action={<button type="button" className={PLAIN} onClick={() => void login.refetch()}>Повторить</button>} />}
      </div>
    );
  }
  const data = login.data;
  const view = loginViewOf(data);
  const live = data.login.state === "wanted" && view.kind !== "unreachable";
  return (
    <div>
      {header}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Экран браузера" aside={<span className="text-xs text-text-muted">{live ? "обновляется раз в секунду" : "не показывается, пока вход закрыт"}</span>}>
          <LiveScreenshot pageLabel={pageLabel} live={live} />
        </Card>
        <Body data={data} view={view} pageLabel={pageLabel} />
      </div>
    </div>
  );
}
