import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useInspectAccountLink, useRedeemAccountLink } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import {
  LINK_UNUSABLE_MESSAGE,
  PASSWORD_HINT,
  START_GUIDE_URL,
  clientOffersForPlatforms,
  doneHeadline,
  joinHeadline,
  joinSubheadline,
  passwordProblem,
  readLinkToken,
  redeemFailureMessage,
} from "./accountView.js";

// Decision 349: the first screen a new chatter ever sees. It lives OUTSIDE
// ProtectedLayout — there is no session yet, and the whole point of the page is
// to create the credential that will make one.
//
// The invitation secret arrives in the URL fragment (§4.1 п.2): fragments are
// not sent to the server by the browser, do not reach Fastify's request log or
// nginx's access log, and are never written into a query string or a path here.
// It travels exactly twice, both times as a POST body field.

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-[420px] rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <h1 className="mb-6 text-center text-2xl font-bold">
          <span className="text-accent">Chat</span>
          <span>Goose</span>
        </h1>
        {children}
      </div>
    </div>
  );
}

function Unusable({ message }: { message: string }) {
  return (
    <Card>
      <p role="alert" className="text-center text-sm text-text-secondary">{message}</p>
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
        <p role="status" className="text-center text-sm text-text-muted">Проверяем ссылку…</p>
      </Card>
    );
  }
  if (link.state !== "active") return <Unusable message={LINK_UNUSABLE_MESSAGE} />;

  const username = redeem.data?.username ?? link.username;

  if (redeem.isSuccess) {
    const offers = clientOffersForPlatforms(link.platforms);
    return (
      <Card>
        <p className="text-center text-sm text-text-secondary">{doneHeadline(link.kind)}</p>
        <p className="mt-3 text-center text-xs uppercase tracking-wide text-text-muted">Логин</p>
        <p className="mt-1 break-all text-center text-3xl font-bold text-text-primary">{username}</p>
        <p className="mt-4 text-center text-sm text-text-secondary">
          Этим логином и паролем входи в:
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {offers.map((offer) => (
            <a
              key={offer.platform}
              href={offer.href}
              className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-center text-sm font-semibold text-white hover:opacity-90"
            >
              {offer.label}
            </a>
          ))}
        </div>
        <p className="mt-6 text-center text-sm">
          <a href={START_GUIDE_URL} className="text-accent underline">Как начать</a>
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
      redeem.error instanceof KernelApiError ? { status: redeem.error.status } : null,
    )
    : null;

  return (
    <Card>
      <h2 className="text-center text-lg font-semibold text-text-primary">
        {joinHeadline(link.kind, link.username)}
      </h2>
      <p className="mt-2 text-center text-sm text-text-secondary">{joinSubheadline(link.kind)}</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" aria-busy={redeem.isPending}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="join-password" className="text-sm text-text-secondary">Пароль</label>
          <input
            id="join-password"
            type="password"
            autoComplete="new-password"
            disabled={redeem.isPending}
            value={password}
            onChange={(event) => { setPassword(event.target.value); setLocalProblem(null); redeem.reset(); }}
            required
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <p className="text-xs text-text-muted">{PASSWORD_HINT}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="join-password-again" className="text-sm text-text-secondary">Повтори пароль</label>
          <input
            id="join-password-again"
            type="password"
            autoComplete="new-password"
            disabled={redeem.isPending}
            value={confirmation}
            onChange={(event) => { setConfirmation(event.target.value); setLocalProblem(null); redeem.reset(); }}
            required
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>

        {(localProblem ?? serverProblem) && (
          <p role="alert" className="text-sm text-danger">{localProblem ?? serverProblem}</p>
        )}

        <button
          type="submit"
          disabled={redeem.isPending || !password || !confirmation}
          className="min-h-11 w-full rounded-lg bg-accent py-2.5 font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {redeem.isPending ? "Сохраняем…" : "Сохранить пароль"}
        </button>
      </form>
    </Card>
  );
}
