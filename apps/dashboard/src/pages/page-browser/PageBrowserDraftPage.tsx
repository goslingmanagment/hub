import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import type { PageBrowserDraftView, PageBrowserEnvBody, PageBrowserProxyCheckBody } from "@agency_hub_core/contracts";
import type { PastedProxyOrder } from "@agency_hub_core/shared";

import { savePageBrowserDraft, usePageBrowserDrafts } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { buildSettingsRoute } from "@/lib/navigation";
import { Card, INPUT, PLAIN, PRIMARY, SCREEN } from "./loginParts.js";
import { EnvForm, ProxyCheckPanel, ProxyPasteField, useProxyCheck } from "./proxyEntryParts.js";
import {
  asSocks5Text,
  EMPTY_ENV_FIELDS,
  envFieldsOf,
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
const errorText = (error: unknown) => (error instanceof KernelApiError ? error.message : "Не удалось. Повторите попытку.");

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
  const [kind, setKind] = useState<"new" | "existing">(params.get("page") !== null ? "existing" : "new");
  const [name, setName] = useState(editing ?? "");
  const [pageLabel, setPageLabel] = useState(params.get("page") ?? "");
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

  const back = <Link to={buildSettingsRoute("pages")} className="text-xs font-medium text-accent hover:underline">&larr; Страницы</Link>;
  if (saved !== null) {
    return (
      <div className={SCREEN}>
        <div className="mb-5">{back}<h1 className="mt-1 text-xl font-extrabold text-text-primary">Браузер {saved.name}: черновик сохранён</h1></div>
        <div className="flex max-w-3xl flex-col gap-4">
          <Card title={<span className="inline-flex items-center gap-2"><CheckCircle2 size={16} className="text-green" aria-hidden /> Что дальше</span>}>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-text-secondary">
              <li>
                На рабочей машине создать браузер — прокси и окружение он возьмёт из этого черновика:
                <pre className="mt-1 overflow-x-auto rounded-lg bg-hover-alt px-3 py-2 font-mono text-xs text-text-primary" data-draft-command>{saved.command}</pre>
              </li>
              {saved.page === null
                ? <li>Браузер появится в «Настройки → Страницы»: там выходной IP, вход в Fansly, проверка аккаунта и создание страницы.</li>
                : <li>Браузер сразу привяжется к странице {saved.page.label}; дальше — её выходной IP и переход на браузер.</li>}
            </ol>
            {saved.proxy !== null && <p className="mt-3 text-xs text-text-muted">Прокси: <span className="font-mono">{maskedLine(saved.proxy)}</span>. Пароль хранится зашифрованным и сюда не возвращается.</p>}
          </Card>
          <div className="flex flex-wrap gap-2">
            <Link to={buildSettingsRoute("pages")} className={PLAIN}>К страницам</Link>
            <button type="button" className={PLAIN} onClick={() => setSaved(null)}>Изменить черновик</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={SCREEN}>
      <div className="mb-5">
        {back}
        <h1 className="mt-1 text-xl font-extrabold text-text-primary">{editing === null ? "Новый браузер страницы" : `Браузер ${editing}`}</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Вставьте прокси, проверьте её и подтвердите окружение браузера — как в антидетект-браузерах. Сервер потом создаст браузер по этому черновику: на сервере ничего вводить не нужно.
        </p>
      </div>
      <form onSubmit={submit} autoComplete="off" className="flex max-w-3xl flex-col gap-4">
        <Card title="1. Чей браузер">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-text-secondary" role="radiogroup">
              <label className="flex items-center gap-2"><input type="radio" checked={kind === "new"} onChange={() => { setKind("new"); check.reset(); }} disabled={editing !== null} /> Новая страница</label>
              <label className="flex items-center gap-2"><input type="radio" checked={kind === "existing"} onChange={() => { setKind("existing"); check.reset(); }} disabled={editing !== null} /> Существующая страница переходит на браузер</label>
            </div>
            {kind === "new" ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="pb-draft-name" className="text-sm text-text-secondary">Название страницы — оно же имя браузера на сервере</label>
                <input id="pb-draft-name" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder="ari-2" className={`${INPUT} font-mono`} disabled={editing !== null} spellCheck={false} />
                {nameProblem !== null && <p className="text-xs text-danger">{nameProblem}</p>}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="pb-draft-page" className="text-sm text-text-secondary">Страница</label>
                <select id="pb-draft-page" value={pageLabel} onChange={(event) => { setPageLabel(event.target.value); check.reset(); }} className={INPUT} disabled={editing !== null}>
                  <option value="">— выберите —</option>
                  {pages.map((page) => <option key={page.pageId} value={page.label}>{page.label}</option>)}
                </select>
              </div>
            )}
          </div>
        </Card>

        <Card title="2. Прокси">
          <div className="flex flex-col gap-3">
            {kind === "existing" ? (
              chosenPage === null ? (
                <p className="text-sm text-text-muted">Выберите страницу: браузер выйдет через её собственную прокси.</p>
              ) : chosenPage.proxy == null ? (
                <p role="alert" className="text-sm text-danger">У страницы {chosenPage.label} нет прокси: сначала задайте её в настройках страницы.</p>
              ) : (
                <p className="text-sm text-text-secondary">
                  Прокси страницы: <span className="font-mono text-text-primary">{maskedLine(chosenPage.proxy)}</span>. Браузер выйдет через неё; сменить её можно в настройках страницы.
                </p>
              )
            ) : (
              <>
                {storedProxy !== null && (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                    <span>Сохранена: <span className="font-mono text-text-primary">{maskedLine(storedProxy)}</span></span>
                    <button type="button" className={PLAIN} onClick={() => { setReplacing(!replacing); setText(""); check.reset(); }}>{replacing ? "Оставить сохранённую" : "Заменить"}</button>
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

        <Card title="3. Окружение браузера">
          <EnvForm
            fields={fields}
            onFields={setFields}
            proposal={proposal}
            onTake={proposal !== null && !sameEnv(fields, proposal) ? () => setFields(envFieldsOf(proposal)) : undefined}
            problem={Object.values(fields).every((value) => value.trim() === "") ? null : env.problem}
          />
        </Card>

        <div className="flex flex-col gap-2">
          <button type="submit" className={PRIMARY} disabled={!canSave} data-draft-save>
            {pending ? "Сохраняем…" : "Сохранить черновик"}
          </button>
          {checkId === null && <p className="text-xs text-text-secondary" data-draft-needs-check>Сохранить можно после успешной проверки прокси: сохраняется адрес, к которому подключилась проверка.</p>}
          <p className="text-xs text-text-muted">Пароль прокси уйдёт в Hub один раз и будет храниться зашифрованным; на эту страницу он не возвращается.</p>
          {problem !== null && <p role="alert" className="text-sm text-danger">{problem}</p>}
        </div>
      </form>
    </div>
  );
}
