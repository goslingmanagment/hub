import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MonitorSmartphone } from "lucide-react";
import type { PageBrowserLoginStepResponse } from "@agency_hub_core/contracts";

import type { PageBrowserLoginStep } from "@/api/queries";
import { loginChipOf, wantsCode, wantsEmailCode, type LoginView, type Tone } from "./pageBrowserLoginView.js";

// The parts of the login form of a server browser (Project Browser PR 15),
// shared by a page's login and a new page's onboarding (PR 16): the chip of
// the moment, a card, the live screenshot, the site's error, the form of the
// fields Fansly asks for. What is typed goes through `send` only and is
// cleared at once.

/** A tone as a status badge (a chip in a card's header or a list row). */
export const TONE_BADGE: Record<Tone, string> = {
  neutral: "badge badge-off",
  progress: "badge badge-info",
  good: "badge badge-success",
  warning: "badge badge-warning",
  danger: "badge badge-danger",
  waiting: "badge badge-accent",
  off: "badge badge-off",
};

/** A tone as a notice (an answer under a button). */
export const TONE_NOTICE: Record<Tone, string> = {
  neutral: "notice",
  progress: "notice",
  good: "notice notice-success",
  warning: "notice notice-warning",
  danger: "notice notice-danger",
  waiting: "notice",
  off: "notice notice-off",
};

export function ToneChip({ label, tone, data }: { label: string; tone: Tone; data?: Record<string, string> | undefined }) {
  return (
    <span className={TONE_BADGE[tone]} {...data}>
      {label}
    </span>
  );
}

export function Chip({ view }: { view: LoginView }) {
  const chip = loginChipOf(view);
  return <ToneChip label={chip.label} tone={chip.tone} data={{ "data-login-view": view.kind }} />;
}

export function Card({ title, children, aside, muted = false }: { title: ReactNode; children: ReactNode; aside?: ReactNode; muted?: boolean | undefined }) {
  return (
    <section className={`card login-card ${muted ? "login-card-locked" : ""}`}>
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
        {aside && <div className="login-card-aside">{aside}</div>}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** The browser as it shows now: a new screenshot each second while `live`
 *  and the page is visible, the last one kept on screen meanwhile. */
export function LiveScreenshot({ urlFor, live }: { urlFor: (tick: number) => string; live: boolean }) {
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
  const url = urlFor(tick);
  return (
    <div className="login-screen">
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
        <div className="login-screen-empty">
          <MonitorSmartphone size={28} aria-hidden />
          {live ? (failed ? "Снимка пока нет: браузер ещё не открыл экран входа." : "Загружаем снимок…") : "Снимок появится, когда вход открыт."}
        </div>
      )}
    </div>
  );
}

export function SiteError({ text }: { text: string }) {
  return (
    <div role="alert" className="notice notice-danger">
      <div className="notice-body">Fansly: {text}</div>
    </div>
  );
}

/** The fields Fansly asks for now: login and password, or the code — the
 *  2FA code, or the one Fansly e-mailed for a login from a new device. Each
 *  step goes through `send` (straight to the API, never a query cache); the
 *  password and the code leave the form at once. */
export function LoginForm({
  view,
  step,
  onAnswer,
}: {
  view: Extract<LoginView, { kind: "form" }>;
  step: { pending: boolean; send: (step: PageBrowserLoginStep) => Promise<PageBrowserLoginStepResponse> };
  onAnswer: (answer: PageBrowserLoginStepResponse) => void;
}) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const { pending, send } = step;
  const codeStep = wantsCode(view);
  const emailCode = wantsEmailCode(view);
  const handle = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const next: PageBrowserLoginStep = codeStep ? { kind: "code", code: code.trim() } : { kind: "submit", login: login.trim(), password };
    // The password and the code leave the form at once: the step carries
    // them to the API, and nothing keeps them after it (no query cache).
    setPassword("");
    setCode("");
    send(next).then(onAnswer, () => onAnswer({ screen: null, refused: null, unreachable: true }));
  };
  return (
    <form onSubmit={handle} className="login-form" aria-busy={pending} autoComplete="off">
      {view.siteError !== null && <SiteError text={view.siteError} />}
      {emailCode && (
        // A login from a new device (owner decision 2026-10-15): Fansly sent
        // a code to the account's e-mail; the browser types it in as a 2FA code.
        <p className="login-text" data-email-code>
          Fansly видит вход с нового устройства и отправил код на почту аккаунта. Найдите письмо от Fansly (проверьте и «Спам») и введите код сюда.
        </p>
      )}
      {codeStep ? (
        <div>
          <label htmlFor="pb-code" className="field-label">{emailCode ? "Код из письма" : "Код из приложения (2FA)"}</label>
          <input id="pb-code" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={code} disabled={pending}
            onChange={(event) => setCode(event.target.value)} placeholder={emailCode ? "Код из письма Fansly" : "Код из приложения"} className="input tracking-widest" required maxLength={32} />
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="pb-login" className="field-label">Логин или e-mail Fansly</label>
            <input id="pb-login" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={login} disabled={pending}
              onChange={(event) => setLogin(event.target.value)} placeholder="имя пользователя или почта" className="input" required maxLength={320} />
          </div>
          <div>
            <label htmlFor="pb-password" className="field-label">Пароль</label>
            <input id="pb-password" type="password" autoComplete="new-password" value={password} disabled={pending}
              onChange={(event) => setPassword(event.target.value)} placeholder="Можно вставить из менеджера паролей" className="input" required maxLength={1024} />
          </div>
        </>
      )}
      <button type="submit" className="btn btn-primary login-wide" disabled={pending || (codeStep ? code.trim() === "" : login.trim() === "" || password === "")}>
        {pending ? "Передаём в браузер…" : codeStep ? "Подтвердить код" : "Войти"}
      </button>
      <p className="field-hint">
        Браузер сам вставит {codeStep ? "код" : "логин и пароль"} в форму Fansly и нажмёт кнопку. Hub {codeStep ? "его" : "их"} не сохраняет.
      </p>
    </form>
  );
}

/** The site is on its landing page: opening the modal is its own step. */
export function OpenLoginDialog({ step, onAnswer }: {
  step: { pending: boolean; send: (step: PageBrowserLoginStep) => Promise<PageBrowserLoginStepResponse> };
  onAnswer: (answer: PageBrowserLoginStepResponse) => void;
}) {
  return <div className="login-form">
    <p className="login-text">Fansly открыт, окно входа ещё закрыто. Сначала откройте его, затем появятся поля логина и пароля.</p>
    <button type="button" className="btn btn-primary login-wide" disabled={step.pending} onClick={() => {
      if (step.pending) return;
      void step.send({ kind: "open" }).then(onAnswer, () => onAnswer({ screen: null, refused: null, unreachable: true }));
    }}>{step.pending ? "Открываем…" : "Открыть окно входа"}</button>
  </div>;
}
