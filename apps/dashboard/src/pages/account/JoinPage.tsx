import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useInspectAccountLink, useRedeemAccountLink } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { CHATTER_SITE_ORIGIN } from "@/lib/sites";
import {
  LINK_UNUSABLE_MESSAGE,
  PASSWORD_HINT,
  START_GUIDE_URL,
  clientOffersForPlatforms,
  doneHeadline,
  joinHeadline,
  joinSubheadline,
  passwordProblem,
  readErrorReason,
  readLinkToken,
  redeemFailureMessage,
} from "./accountView.js";

// The first screen a new chatter ever sees. It lives OUTSIDE
// ProtectedLayout — there is no session yet, and the whole point of the page is
// to create the credential that will make one.
//
// The invitation secret arrives in the URL fragment (§4.1 п.2): fragments are
// not sent to the server by the browser, do not reach Fastify's request log or
// nginx's access log, and are never written into a query string or a path here.
// It travels exactly twice, both times as a POST body field.

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="entry-screen">
      <h1 className="entry-logo"><span>Chat</span>Goose</h1>
      <div className="entry-card entry-card-wide">{children}</div>
    </div>
  );
}

function Unusable({ message }: { message: string }) {
  return (
    <Card>
      <p role="alert" className="entry-text">{message}</p>
    </Card>
  );
}

export function JoinPage() {
  const location = useLocation();
  const token = readLinkToken(location.hash);
  const inspect = useInspectAccountLink();
  const redeem = useRedeemAccountLink();
  const requested = useRef(false);
  const submitting = useRef(false);

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [localProblem, setLocalProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!token || requested.current) return;
    requested.current = true;
    inspect.mutate({ token });
    // The secret is the only input; re-running on hook identity would replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) return <Unusable message={LINK_UNUSABLE_MESSAGE} />;

  if (inspect.isError) {
    const status = inspect.error instanceof KernelApiError ? inspect.error.status : null;
    if (status === 429) {
      return <Unusable message="Слишком много попыток. Подожди минуту и открой ссылку снова." />;
    }
    if (status === 404 || status === 409) return <Unusable message={LINK_UNUSABLE_MESSAGE} />;
    return <Unusable message="Не удалось проверить ссылку. Обнови страницу через минуту." />;
  }

  const link = inspect.data;
  if (!link) {
    return (
      <Card>
        <p role="status" className="entry-text">Проверяем ссылку…</p>
      </Card>
    );
  }
  if (link.state !== "active") return <Unusable message={LINK_UNUSABLE_MESSAGE} />;

  const username = redeem.data?.username ?? link.username;

  if (redeem.isSuccess) {
    const offers = clientOffersForPlatforms(link.platforms);
    return (
      <Card>
        <p className="entry-text">{doneHeadline(link.kind)}</p>
        <p className="entry-caption">Логин</p>
        <p className="entry-login">{username}</p>
        {offers.length > 0 && (
          <>
            <p className="entry-text mt-6">Этим логином и паролем входи в:</p>
            <div className="mt-3 flex flex-col gap-2">
              {offers.map((offer) => (
                <a key={offer.platform} href={offer.href} className="btn btn-primary entry-submit">
                  {offer.label}
                </a>
              ))}
            </div>
          </>
        )}
        <div className="entry-after">
          <a href={`${CHATTER_SITE_ORIGIN}/account`} className="btn entry-submit">Открыть кабинет</a>
          <p className="entry-hint">Здесь ты подтверждаешь отчёты смен.</p>
        </div>
        <p className="entry-text mt-6">
          <a href={START_GUIDE_URL} className="link">Как начать</a>
        </p>
      </Card>
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || redeem.isPending || !token) return;
    const problem = passwordProblem(password, confirmation);
    setLocalProblem(problem);
    if (problem) return;
    submitting.current = true;
    redeem.mutate(
      { token, password },
      {
        onSuccess: () => {
          setPassword("");
          setConfirmation("");
          // Drop the spent secret from the address bar and from anything that
          // reads the current URL after this point.
          if (typeof window !== "undefined") {
            window.history.replaceState(null, "", window.location.pathname);
          }
        },
        onSettled: () => { submitting.current = false; },
      },
    );
  }

  const serverProblem = redeem.isError
    ? redeemFailureMessage(
      redeem.error instanceof KernelApiError
        ? { status: redeem.error.status, reason: readErrorReason(redeem.error.body) }
        : null,
    )
    : null;

  return (
    <Card>
      <h2 className="dialog-title">{joinHeadline(link.kind, link.username)}</h2>
      <p className="entry-sub">{joinSubheadline(link.kind)}</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" aria-busy={redeem.isPending}>
        <div className="flex flex-col gap-2">
          <label htmlFor="join-password" className="field-label mb-0">Пароль</label>
          <input
            id="join-password"
            type="password"
            autoComplete="new-password"
            disabled={redeem.isPending}
            value={password}
            onChange={(event) => { setPassword(event.target.value); setLocalProblem(null); redeem.reset(); }}
            required
            className="input"
          />
          <p className="field-hint">{PASSWORD_HINT}</p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="join-password-again" className="field-label mb-0">Повтори пароль</label>
          <input
            id="join-password-again"
            type="password"
            autoComplete="new-password"
            disabled={redeem.isPending}
            value={confirmation}
            onChange={(event) => { setConfirmation(event.target.value); setLocalProblem(null); redeem.reset(); }}
            required
            className="input"
          />
        </div>

        {(localProblem ?? serverProblem) && (
          <p role="alert" className="field-error">{localProblem ?? serverProblem}</p>
        )}

        <button
          type="submit"
          disabled={redeem.isPending || !password || !confirmation}
          className="btn btn-primary entry-submit"
        >
          {redeem.isPending ? "Сохраняем…" : "Сохранить пароль"}
        </button>
      </form>
    </Card>
  );
}
