import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { PageBrowserLoginResponse } from "@agency_hub_core/contracts";

import {
  pageBrowserScreenshotUrl,
  useFinishPageBrowserLogin,
  usePageBrowserLogin,
  usePageBrowserLoginStep,
  useStartPageBrowserLogin,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { buildSettingsRoute, decodeRouteSegment } from "@/lib/navigation";
import { Card, Chip, LiveScreenshot, LoginForm, PLAIN, PRIMARY, SCREEN } from "./loginParts.js";
import { loginViewOf, stepProblemText, type LoginView } from "./pageBrowserLoginView.js";

// The owner logs a page's server browser in (Project Browser plan §4.8,
// PR 15): the browser's live screenshot, the fields Fansly asks for now, the
// site's error, and the browser's own screen for what the form does not
// know. What is typed goes to the page's browser through Hub and is kept
// nowhere; the fields are cleared once a step was sent.

function Body({ data, view, pageLabel }: { data: PageBrowserLoginResponse; view: LoginView; pageLabel: string }) {
  const start = useStartPageBrowserLogin(pageLabel);
  const finish = useFinishPageBrowserLogin(pageLabel);
  const step = usePageBrowserLoginStep(pageLabel);
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
      main = <LoginForm view={view} step={step} onAnswer={(answer) => setProblem(stepProblemText(answer))} />;
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
    return <div className={SCREEN}>{header}<p role="status" className="text-sm text-text-muted">Загружаем…</p></div>;
  }
  if (login.isError || login.data === undefined) {
    const notFound = login.error instanceof KernelApiError && login.error.status === 404;
    return (
      <div className={SCREEN}>
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
    <div className={SCREEN}>
      {header}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Экран браузера" aside={<span className="text-xs text-text-muted">{live ? "обновляется раз в секунду" : "не показывается, пока вход закрыт"}</span>}>
          <LiveScreenshot urlFor={(tick) => pageBrowserScreenshotUrl(pageLabel, tick)} live={live} />
        </Card>
        <Body data={data} view={view} pageLabel={pageLabel} />
      </div>
    </div>
  );
}
