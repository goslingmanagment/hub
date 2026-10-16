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

/** The page's own gutter on a phone (the layout gives none below md), as
 *  the settings screen has it. */
export const SCREEN = "min-w-0 p-4 md:p-0";

export const TONES: Record<Tone, string> = {
  neutral: "border-border bg-hover-alt text-text-secondary",
  progress: "border-accent/30 bg-accent/10 text-accent",
  good: "border-green/30 bg-green/10 text-green",
  warning: "border-warning/30 bg-warning/10 text-warning-dark",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

export const INPUT = "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60";
export const PRIMARY = "w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50";
export const PLAIN = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-hover disabled:opacity-50";

export function ToneChip({ label, tone, data }: { label: string; tone: Tone; data?: Record<string, string> }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`} {...data}>
      {label}
    </span>
  );
}

export function Chip({ view }: { view: LoginView }) {
  const chip = loginChipOf(view);
  return <ToneChip label={chip.label} tone={chip.tone} data={{ "data-login-view": view.kind }} />;
}

export function Card({ title, children, aside, muted = false }: { title: ReactNode; children: ReactNode; aside?: ReactNode; muted?: boolean }) {
  return (
    <section className={`rounded-xl border border-border bg-card p-4 sm:p-5 ${muted ? "opacity-70" : ""}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {aside}
      </div>
      {children}
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

export function SiteError({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
      <span className="font-semibold">Fansly:</span> {text}
    </p>
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
    <form onSubmit={handle} className="flex flex-col gap-3" aria-busy={pending} autoComplete="off">
      {view.siteError !== null && <SiteError text={view.siteError} />}
      {emailCode && (
        // A login from a new device (owner decision 2026-10-15): Fansly sent
        // a code to the account's e-mail; the browser types it in as a 2FA code.
        <p className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-sm text-text-secondary" data-email-code>
          Fansly видит вход с нового устройства и отправил код на почту аккаунта. Найдите письмо от Fansly (проверьте и «Спам») и введите код сюда.
        </p>
      )}
      {codeStep ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pb-code" className="text-sm text-text-secondary">{emailCode ? "Код из письма" : "Код 2FA"}</label>
          <input id="pb-code" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={code} disabled={pending}
            onChange={(event) => setCode(event.target.value)} placeholder={emailCode ? "Код из письма Fansly" : "Код из приложения"} className={`${INPUT} tracking-widest`} required maxLength={32} />
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
  return <div className="flex flex-col gap-3">
    <p className="text-sm text-text-secondary">Fansly открыт, окно входа ещё закрыто. Сначала откройте его, затем появятся поля логина и пароля.</p>
    <button type="button" className={PRIMARY} disabled={step.pending} onClick={() => {
      if (step.pending) return;
      void step.send({ kind: "open" }).then(onAnswer, () => onAnswer({ screen: null, refused: null, unreachable: true }));
    }}>{step.pending ? "Открываем…" : "Открыть окно входа"}</button>
  </div>;
}
