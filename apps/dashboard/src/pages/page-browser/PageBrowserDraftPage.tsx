import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { PageBrowserDraftView, PageBrowserEnvBody, PageBrowserProxyCheckBody } from "@agency_hub_core/contracts";
import type { PastedProxyOrder } from "@agency_hub_core/shared";

import { savePageBrowserDraft, usePageBrowserDrafts } from "@/api/queries";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Skeleton";
import { buildSettingsRoute } from "@/lib/navigation";
import { ServerAdminCommand } from "@/components/shared/ServerAdminCommand";
import { ConnectSteps } from "./ConnectSteps.js";
import { Card } from "./loginParts.js";
import { pageBrowserErrorText } from "./pageBrowserErrors.js";
import { EnvForm, ProxyCheckPanel, ProxyPasteField, useProxyCheck } from "./proxyEntryParts.js";
import {
  asSocks5Text,
  EMPTY_ENV_FIELDS,
  envFieldsOf,
  envLine,
  envOfFields,
  maskedLine,
  proxyPreviewOf,
  type EnvFields,
} from "./proxyEntryView.js";

// A page's server browser started in the dashboard (Project Browser, owner
// decision 2026-10-15): whose browser it is (a new page's, by its label, or
// an existing page that moves to its browser), the proxy pasted in one field
// and checked as antidetect browsers do, the environment proposed from the
// proxy's exit and confirmed — a draft. `scripts/deploy-page-browser.sh
// add-profile` then makes the browser from it with nothing typed on the
// server. The pasted proxy lives in this page's state until it is saved,
// then the field is emptied; Hub keeps it sealed and never sends it back.

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const errorText = (error: unknown) => pageBrowserErrorText(error);

function sameEnv(fields: EnvFields, env: PageBrowserEnvBody | null): boolean {
  if (env === null) return false;
  const other = envFieldsOf(env);
  return (Object.keys(other) as Array<keyof EnvFields>).every((key) => other[key] === fields[key]);
}

export function PageBrowserDraftPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const drafts = usePageBrowserDrafts();
  const editing = params.get("name");
  const [kind, setKind] = useState<"new" | "existing">(params.get("forPage") !== null ? "existing" : "new");
  const [name, setName] = useState(editing ?? "");
  const [pageLabel, setPageLabel] = useState(params.get("forPage") ?? "");
  const [text, setText] = useState("");
  const [order, setOrder] = useState<PastedProxyOrder | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [fields, setFields] = useState<EnvFields>(EMPTY_ENV_FIELDS);
  const [proposal, setProposal] = useState<PageBrowserEnvBody | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<PageBrowserDraftView | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The draft's revision this page edits (null: a new draft): a save over
  // another one is refused (Astra's review of PR #627, round 2).
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const check = useProxyCheck();
  const [envOpen, setEnvOpen] = useState(false);

  // An edit: the draft as saved (its proxy stays sealed in Hub).
  const draft = editing === null ? null : drafts.data?.drafts.find((item) => item.name === editing) ?? null;
  useEffect(() => {
    if (loaded || draft === null) return;
    setLoaded(true);
    setExpectedRevision(draft.revision);
    setKind(draft.page === null ? "new" : "existing");
    setName(draft.name);
    if (draft.page !== null) setPageLabel(draft.page.label);
    if (draft.env !== null) setFields(envFieldsOf(draft.env));
  }, [draft, loaded]);

  const pages = drafts.data?.pages ?? [];
  // An existing page that moves to its browser has none yet: it is listed
  // until add-profile binds one to it.
  const chosenPage = kind === "existing" ? pages.find((page) => page.label === pageLabel) ?? null : null;
  const storedProxy = kind === "new" && draft !== null && draft.page === null ? draft.proxy : null;
  const pasting = kind === "new" && (storedProxy === null || replacing);
  const preview = proxyPreviewOf(text, order);
  const browserName = kind === "new" ? name.trim() : pageLabel;
  const nameProblem = kind === "new" && browserName !== "" && !NAME.test(browserName)
    ? "Название — строчные латинские буквы, цифры и дефис (как у страниц: ari-2)"
    : null;
  const env = envOfFields(fields);
  const proxyReady = kind === "existing" ? chosenPage?.proxy != null : pasting ? preview.kind === "parsed" && preview.problem === null : storedProxy !== null;
  // Saved only after a check of the proxy as it stands that logged in
  // through it: the address it connected to is the one stored.
  const checkId = check.result?.checkId ?? null;
  const canSave = !pending && env.env !== null && browserName !== "" && nameProblem === null && proxyReady && checkId !== null;

  const source = (): PageBrowserProxyCheckBody["source"] | null => {
    if (kind === "existing") return pageLabel === "" ? null : { kind: "page", pageLabel };
    if (pasting) return preview.kind === "parsed" ? { kind: "text", proxy: { text, ...(order === null ? {} : { order }) } } : null;
    return editing === null ? null : { kind: "draft", name: editing };
  };
  const runCheck = () => {
    const what = source();
    if (what === null) return;
    void check.run(what).then((answer) => {
      if (answer?.env == null) return;
      // The proposal fills the fields the owner has not typed himself.
      if (sameEnv(fields, proposal) || Object.values(fields).every((value) => value.trim() === "")) setFields(envFieldsOf(answer.env));
      setProposal(answer.env);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || env.env === null || checkId === null) return;
    setPending(true);
    setProblem(null);
    const proxy = pasting ? { text, ...(order === null ? {} : { order }) } : undefined;
    savePageBrowserDraft(qc, browserName, { existingPage: kind === "existing", ...(proxy === undefined ? {} : { proxy }), env: env.env, checkId, expectedRevision })
      .then((answer) => {
        // The proxy's password leaves this page: Hub keeps it sealed.
        setText("");
        setOrder(null);
        setReplacing(false);
        check.reset();
        setExpectedRevision(answer.revision);
        setSaved(answer);
      }, (error: unknown) => setProblem(errorText(error)))
      .finally(() => setPending(false));
  };

  if (saved !== null) {
    return (
      <div className="connect-page">
        <PageHeader title={`Браузер ${saved.name}: черновик сохранён`} />
        <ConnectSteps states={["done", "current", "locked", "locked", "locked"]} />
        <div className="connect-column">
          <Card title="Что дальше">
            <ol className="connect-next">
              <li>
                <p>Администратор сервера создаёт браузер по этому черновику: прокси и окружение он возьмёт отсюда.</p>
                <ServerAdminCommand text="Команда на рабочей машине, прокси и окружение вводить не нужно:" command={saved.command} />
              </li>
              {saved.page === null
                ? <li><p>Браузер появится в «Настройки → Модели и страницы» в блоке «Незавершённые подключения»: там выходной IP, вход в Fansly, проверка аккаунта и создание страницы.</p></li>
                : <li><p>Браузер сразу привяжется к странице {saved.page.label}. Дальше её выходной IP и переход на браузер.</p></li>}
            </ol>
            {saved.proxy !== null && <p className="field-hint">Прокси: <span className="font-mono">{maskedLine(saved.proxy)}</span>. Пароль хранится зашифрованным и сюда не возвращается.</p>}
          </Card>
          <div className="connect-actions">
            <Link to={buildSettingsRoute("pages")} className="btn btn-primary">К моделям и страницам</Link>
            <button type="button" className="btn" onClick={() => setSaved(null)}>Изменить черновик</button>
          </div>
        </div>
      </div>
    );
  }

  const envReady = env.env !== null;
  const showEnvForm = envOpen || (env.problem !== null && Object.values(fields).some((value) => value.trim() !== ""));
  return (
    <div className="connect-page">
      <PageHeader
        title={editing === null ? "Подключить страницу Fansly" : `Браузер ${editing}`}
        description="Вставьте и проверьте прокси, подтвердите окружение: по этому черновику сервер создаст браузер."
      />
      <ConnectSteps states={["current", "locked", "locked", "locked", "locked"]} />
      {editing !== null && drafts.isError && !drafts.data && (
        <Notice tone="warning" action={<button type="button" className="btn btn-sm" onClick={() => void drafts.refetch()}>Повторить</button>}>
          Не удалось загрузить черновик. Показана пустая форма.
        </Notice>
      )}
      <form onSubmit={submit} autoComplete="off" className="connect-column">
        <Card title="Чей браузер">
          <div className="connect-fields">
            <div className="connect-radios" role="radiogroup" aria-label="Чей браузер">
              <label><input type="radio" checked={kind === "new"} onChange={() => { setKind("new"); check.reset(); }} disabled={editing !== null} /> Новая страница</label>
              <label><input type="radio" checked={kind === "existing"} onChange={() => { setKind("existing"); check.reset(); }} disabled={editing !== null} /> Существующая страница переходит на браузер</label>
            </div>
            {kind === "new" ? (
              <div>
                <label htmlFor="pb-draft-name" className="field-label">Название страницы</label>
                <input id="pb-draft-name" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder="ari-2" className="input connect-input" disabled={editing !== null} spellCheck={false} />
                {nameProblem !== null
                  ? <p className="field-error">{nameProblem}</p>
                  : <p className="field-hint">Так же будет называться браузер на сервере.</p>}
              </div>
            ) : (
              <div>
                <label htmlFor="pb-draft-page" className="field-label">Страница</label>
                <select id="pb-draft-page" value={pageLabel} onChange={(event) => { setPageLabel(event.target.value); check.reset(); }} className="select connect-input" disabled={editing !== null}>
                  <option value="">Выберите страницу</option>
                  {pages.map((page) => <option key={page.pageId} value={page.label}>{page.label}</option>)}
                </select>
              </div>
            )}
          </div>
        </Card>

        <Card title="Прокси">
          <div className="connect-fields">
            {kind === "existing" ? (
              chosenPage === null ? (
                <p className="login-text">Выберите страницу: браузер выйдет через её собственную прокси.</p>
              ) : chosenPage.proxy == null ? (
                <p role="alert" className="field-error">У страницы {chosenPage.label} нет прокси, а задать его из консоли сейчас нельзя. Это делает администратор сервера.</p>
              ) : (
                <p className="login-text">
                  Прокси страницы: <span className="font-mono text-text-primary">{maskedLine(chosenPage.proxy)}</span>. Браузер выйдет через неё.
                </p>
              )
            ) : (
              <>
                {storedProxy !== null && (
                  <div className="connect-saved">
                    <span>Сохранена: <span className="font-mono text-text-primary">{maskedLine(storedProxy)}</span></span>
                    <button type="button" className="btn btn-sm" onClick={() => { setReplacing(!replacing); setText(""); check.reset(); }}>{replacing ? "Оставить сохранённую" : "Заменить"}</button>
                  </div>
                )}
                {pasting && (
                  <ProxyPasteField id="pb-draft-proxy" label="Прокси новой страницы" text={text} onText={(value) => { setText(value); check.reset(); setProposal(null); }} order={order} onOrder={setOrder} disabled={pending} />
                )}
              </>
            )}
            <ProxyCheckPanel
              check={check}
              onCheck={runCheck}
              disabled={source() === null}
              onUseAsSocks5={pasting ? () => {
                const socks = asSocks5Text(text, order);
                if (socks !== null) {
                  setText(socks);
                  check.reset();
                }
              } : undefined}
            />
          </div>
        </Card>

        <Card
          title="Окружение браузера"
          aside={!showEnvForm && envReady ? <button type="button" className="btn btn-sm" onClick={() => setEnvOpen(true)}>Изменить</button> : undefined}
        >
          {showEnvForm ? (
            <EnvForm
              fields={fields}
              onFields={setFields}
              proposal={proposal}
              onTake={proposal !== null && !sameEnv(fields, proposal) ? () => setFields(envFieldsOf(proposal)) : undefined}
              problem={Object.values(fields).every((value) => value.trim() === "") ? null : env.problem}
            />
          ) : envReady && env.env !== null ? (
            <div>
              <p className="connect-env">{envLine(env.env)}</p>
              <p className="field-hint">{proposal !== null && sameEnv(fields, proposal) ? "Подставлено по выходу прокси." : "Заполнено вручную."}</p>
            </div>
          ) : (
            <div className="connect-saved">
              <span className="login-text">Hub предложит значения после проверки прокси.</span>
              <button type="button" className="btn btn-sm" onClick={() => setEnvOpen(true)}>Заполнить вручную</button>
            </div>
          )}
        </Card>

        <div className="connect-save">
          <button type="submit" className="btn btn-primary" disabled={!canSave} data-draft-save>
            {pending ? <><Spinner /> Сохраняем…</> : "Сохранить черновик"}
          </button>
          {checkId === null && <p className="field-hint" data-draft-needs-check>Сохранить можно после успешной проверки прокси: сохраняется адрес, к которому подключилась проверка.</p>}
          <p className="field-hint">Пароль прокси уйдёт в Hub один раз и будет храниться зашифрованным. На этот экран он не возвращается.</p>
          {problem !== null && <p role="alert" className="field-error">{problem}</p>}
        </div>
      </form>
    </div>
  );
}
