import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ExternalLink } from "lucide-react";
import type { PageBrowserLoginResponse } from "@agency_hub_core/contracts";

import {
  pageBrowserScreenshotUrl,
  useFinishPageBrowserLogin,
  usePageBrowserLogin,
  usePageBrowserLoginStep,
  useStartPageBrowserLogin,
} from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, Spinner } from "@/components/ui/Skeleton";
import { buildPageCollectionRoute, decodeRouteSegment } from "@/lib/navigation";
import { Card, Chip, LiveScreenshot, LoginForm, OpenLoginDialog } from "./loginParts.js";
import { browserProblemDetail, loginViewOf, stepProblemText, type LoginView } from "./pageBrowserLoginView.js";
import { pageBrowserErrorView, type PageBrowserErrorView } from "./pageBrowserErrors.js";

// The owner logs a page's server browser in (Project Browser plan §4.8,
// PR 15): the browser's live screenshot, the fields Fansly asks for now, the
// site's error, and the browser's own screen for what the form does not
// know. What is typed goes to the page's browser through Hub and is kept
// nowhere; the fields are cleared once a step was sent. Only the look and
// one question before «Начать вход» are new (design/screens/fans-page.md §10).

export function LoginProblem({ problem }: { problem: PageBrowserErrorView | string | null }) {
  if (problem === null) return null;
  const view = typeof problem === "string" ? { text: problem, detail: null } : problem;
  return (
    <div className="login-problem" role="alert">
      <p>{view.text}</p>
      {view.detail && <Disclosure label="Подробнее"><p>{view.detail}</p></Disclosure>}
    </div>
  );
}

function Body({ data, view, pageLabel }: { data: PageBrowserLoginResponse; view: LoginView; pageLabel: string }) {
  const start = useStartPageBrowserLogin(pageLabel);
  const finish = useFinishPageBrowserLogin(pageLabel);
  const step = usePageBrowserLoginStep(pageLabel);
  const [problem, setProblem] = useState<PageBrowserErrorView | string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const failure = (error: unknown) => setProblem(pageBrowserErrorView(error));
  const screenLink = (
    <a href={data.screenUrl} target="_blank" rel="noreferrer" className="btn">
      <ExternalLink size={16} aria-hidden /> Открыть экран браузера
    </a>
  );
  const finishButton = (label: string, primary = false) => (
    <button type="button" className={primary ? "btn btn-primary login-wide" : "btn"} disabled={finish.isPending}
      onClick={() => finish.mutate(undefined, { onError: failure })}>
      {finish.isPending ? <><Spinner /> Завершаем…</> : label}
    </button>
  );
  const notReady = view.kind === "closed" && view.problem !== null;
  let main: ReactNode;
  switch (view.kind) {
    case "closed":
      main = (
        <div className="login-form">
          <p className="login-text">
            Браузер страницы работает сам. Начните вход, если Fansly вышел из аккаунта или страницу подключают заново. На время входа страница встанет на паузу.
          </p>
          {notReady && (
            <LoginProblem problem={{
              text: view.problem ? `Браузер страницы не готов: ${view.problem}.` : "Браузер страницы не готов.",
              detail: browserProblemDetail(data.browser.problem),
            }} />
          )}
          <button type="button" className="btn btn-primary login-wide" disabled={view.problem !== null || start.isPending}
            onClick={() => { setAskError(null); setAsking(true); }}>
            {start.isPending ? <><Spinner /> Открываем…</> : "Начать вход"}
          </button>
        </div>
      );
      break;
    case "preparing":
      main = <p role="status" className="login-status"><Spinner /> Страница на паузе. Браузер открывает экран входа Fansly…</p>;
      break;
    case "unreachable":
      main = <LoginProblem problem="Hub не достучался до браузера страницы. Подождите несколько секунд или завершите вход." />;
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
          <p className="login-text">
            Fansly принял вход. Завершите его: Hub проверит аккаунт, сессию и выходной IP и только потом вернёт странице работу.
          </p>
          {finishButton("Завершить вход", true)}
        </div>
      );
      break;
    case "unknown":
      main = (
        <div className="login-form">
          <p className="login-text">
            Браузер показывает экран, которого форма не знает: капча, проверка Fansly, новое соглашение или изменённая форма. Ничего не нажато.
          </p>
          <p className="login-text">Откройте экран браузера и пройдите его сами: пароль экрана Hub подставит сам. Потом вернитесь сюда.</p>
          {screenLink}
        </div>
      );
      break;
    case "closing":
      main = <p role="status" className="login-status"><Spinner /> Браузер выходит из режима входа, Hub снимает паузу.</p>;
      break;
  }
  const open = view.kind !== "closed" && view.kind !== "closing";
  return (
    <div className="login-side">
      <Card title="Вход в Fansly" aside={<Chip view={view} />}>
        {main}
        <LoginProblem problem={problem} />
      </Card>
      {open && (
        <Card title="Если что-то пошло не так">
          <div className="login-actions">
            {view.kind !== "unknown" && screenLink}
            {view.kind !== "success" && finishButton("Завершить вход без входа")}
            <p className="field-hint">Пока вход открыт, страница стоит на паузе.</p>
          </div>
        </Card>
      )}
      {asking && (
        <ConfirmModal
          title={`Начать вход на ${pageLabel}?`}
          message="Страница встанет на паузу: сбор данных остановится, пока вход открыт."
          facts={[
            { label: "Куда", value: `${pageLabel}, Fansly` },
            { label: "Отменить", value: "Можно: «Завершить вход без входа» снимет паузу" },
          ]}
          confirmLabel="Начать вход"
          pendingLabel="Открываем…"
          tone="primary"
          error={askError}
          isPending={start.isPending}
          // The request as before: the page from the path, one attempt.
          onConfirm={() => start.mutate(undefined, {
            onSuccess: () => setAsking(false),
            onError: (error) => setAskError(pageBrowserErrorView(error).text),
          })}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}

export function PageBrowserLoginPage() {
  const { pageLabel: raw = "" } = useParams<{ pageLabel: string }>();
  const pageLabel = decodeRouteSegment(raw);
  const login = usePageBrowserLogin(pageLabel);
  const header = (
    <PageHeader
      title="Вход в Fansly"
      description="Браузер страницы входит в Fansly со своего устройства и IP. Пароль и код нигде не сохраняются."
      actions={<Link to={buildPageCollectionRoute(pageLabel)} className="btn">Сбор данных страницы</Link>}
    />
  );
  if (login.isPending) {
    return (
      <div className="login-page">
        {header}
        <div className="login-grid">
          <Card title="Экран браузера"><div className="login-screen"><Skeleton width="100%" className="!h-full" /></div></Card>
          <Card title="Вход в Fansly"><Skeleton width="80%" /></Card>
        </div>
      </div>
    );
  }
  if (login.isError || login.data === undefined) {
    const notFound = login.error instanceof KernelApiError && login.error.status === 404;
    return (
      <div className="login-page">
        {header}
        {notFound
          ? <StatusPanel title="Такой страницы нет" description="Её нет среди доступных вам." action={<Link to="/" className="btn btn-sm">На главную</Link>} />
          : <NoAnswerPanel retry={login.refetch} />}
      </div>
    );
  }
  const data = login.data;
  const view = loginViewOf(data);
  const live = data.login.state === "wanted" && view.kind !== "unreachable";
  return (
    <div className="login-page">
      {header}
      <div className="login-grid">
        <Card title="Экран браузера" aside={<span className="login-card-note">{live ? "обновляется раз в секунду" : "не показывается, пока вход закрыт"}</span>}>
          <LiveScreenshot urlFor={(tick) => pageBrowserScreenshotUrl(pageLabel, tick)} live={live} />
        </Card>
        <Body data={data} view={view} pageLabel={pageLabel} />
      </div>
    </div>
  );
}
