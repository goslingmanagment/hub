import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TEAM_QUESTION_KINDS, TEAM_QUESTION_KIND_WORDS, isChatTeamRole, type TeamQuestion, type TeamQuestionKind, type TeamQuestionSwap } from "@agency_hub_core/contracts";
import { Button, ErrorState, Field, Modal, PageLabel, Select, Skeleton, TextInput, toast } from "@agency_hub_core/ui";
import { formatDateTime, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { addDays, moscowToday } from "@agency_hub_core/ui/moscow";
import { kernel } from "@/shared/hub";
import { PasswordWayIn } from "@/shared/PasswordWayIn";
import { useMe } from "@/shared/useMe";
import { usePages } from "@/shared/usePages";
import { useTeamPeople } from "../team/teamPeople";

/**
 * Вопросы тому, кто решает (products plan §4.6), Workboard's door: «Спросить» in «Ждут вас» asks the decider of the
 * page's model (Hub finds them: the team's lead, the owner when there is none); a question opens by the address
 * (`?question=<id>`, the link of both its matters) — the decider answers «Можно» or «Нельзя» with a line, the asker
 * reads the answer and marks it read, or withdraws a question still open. Answering is a decision: a session opened from
 * the extension shows the way to the password instead.
 */

const QUESTIONS_KEY = ["team-questions"] as const;

/** The asker's open questions, the newest first. */
export function useMyOpenQuestions() {
  const read = useQuery({
    queryKey: [...QUESTIONS_KEY, "list"],
    queryFn: () => kernel.teamQuestions({ query: {} }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    meta: { suppressGlobalError: true },
  });
  return (read.data?.questions ?? []).filter((question) => question.mine && question.state === "open");
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: QUESTIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["matters"] });
  };
}

const kindWord = (kind: TeamQuestionKind) => TEAM_QUESTION_KIND_WORDS[kind];

/** What «Спросить» opens with: from «График», a swap of a person's slot of a day, or «Предложить сетку». */
export interface AskStart {
  kind: TeamQuestionKind;
  pageLabel?: string;
  /**
   * The extension's fan panel (products package R5, the window in its frame): the fan asked about, the page fixed, the
   * kinds about a fan only, `door: "extension"`; nobody's team list is read.
   */
  fan?: { ref: string; name: string | null };
  /** «Подмена»: the slot's hours and pages; the absent person's code when a lead asks for them. */
  swap?: { pageLabels: string[]; start: string; end: string; absentPersonCode?: string; absentName?: string };
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** A day's words: «пт, 21 нояб.». */
const dayWords = (day: string) => formatWeekdayDay(`${day}T12:00:00+03:00`);

/** «Подмена пт, 21 нояб. 16:00–00:00, mia-1: выйдет Алекс». */
function swapLine(input: { date: string; start: string; end: string; pages: readonly string[]; cover: string; absent?: string | undefined }): string {
  return `Подмена ${dayWords(input.date)} ${input.start}–${input.end}, ${input.pages.join(", ")}: ${input.absent ? `не выйдет ${input.absent}, ` : ""}выйдет ${input.cover}`;
}

/**
 * «Спросить»: a page, what about, the fan when there is one, one line. «Подмена» asks the day, the hours and who covers
 * (a person of the same team); «График» (a lead's proposal of the standing schedule) goes to the owner.
 */
/** What one asks about a fan (the extension's fan panel): no swap, no schedule. */
const FAN_KINDS: readonly TeamQuestionKind[] = ["discount_over_50", "free_paid", "custom_price", "whale_terms"];

export function AskModal({ onClose, start, onAsked }: { onClose: () => void; start?: AskStart; onAsked?: () => void }) {
  const fanStart = start?.fan ?? null;
  const pages = usePages({ enabled: fanStart === null });
  const people = useTeamPeople({ enabled: fanStart === null });
  const { leadsTeam, isOwner, user } = useMe();
  const refresh = useRefresh();
  const [pageLabel, setPageLabel] = useState(start?.pageLabel ?? "");
  const [kind, setKind] = useState<TeamQuestionKind>(start?.kind ?? "discount_over_50");
  const [fanName, setFanName] = useState(fanStart?.name ?? "");
  const [text, setText] = useState("");
  const [date, setDate] = useState(addDays(moscowToday(), 1));
  const [from, setFrom] = useState(start?.swap?.start ?? "");
  const [to, setTo] = useState(start?.swap?.end ?? "");
  const [cover, setCover] = useState("");
  const list = (pages.data ?? []).filter((page) => page.platform !== "telegram");
  const page = fanStart !== null ? (start?.pageLabel ?? "") : pageLabel || list[0]?.label || "";
  const swapPages = start?.swap?.pageLabels ?? (page ? [page] : []);
  // Who may cover: a person of the same team (working a page of the same model), not the absent one.
  const modelOf = (label: string) => list.find((one) => one.label === label)?.modelSlug ?? null;
  const model = modelOf(swapPages[0] ?? page);
  const own = (people.data?.people ?? []).find((person) => person.logins.some((login) => login.userId === user?.id))?.code ?? null;
  const absentCode = start?.swap?.absentPersonCode ?? own;
  // The chat team of the model (contracts chat-team.ts), working already: a content manager is not offered, nor a
  // newcomer not working yet (invited or set up); Hub checks the same.
  const covers = useMemo(() => (people.data?.people ?? [])
    .filter((person) => person.kind === "human" && person.state === "working" && isChatTeamRole(person.role) && person.code !== absentCode
      && person.workingPages.some((one) => one.modelSlug === model))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ru")), [people.data, absentCode, model]);
  const coverName = covers.find((person) => person.code === cover)?.displayName ?? "";
  // «График» is a lead's word to the owner; the owner decides, he does not ask.
  const kinds = fanStart !== null ? FAN_KINDS : TEAM_QUESTION_KINDS.filter((one) => one !== "schedule" || (leadsTeam && !isOwner));
  const swap = kind === "swap";
  const swapReady = date > moscowToday() && TIME.test(from) && TIME.test(to) && cover !== "" && swapPages.length > 0;
  const words = text.trim() || (swap && swapReady ? swapLine({ date, start: from, end: to, pages: swapPages, cover: coverName, absent: start?.swap?.absentName }) : "");
  const ask = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.teamQuestionAsk({
      body: {
        pageLabel: swap ? swapPages[0]! : page, kind, text: words, ...(fanName.trim() && !swap ? { fanName: fanName.trim() } : {}),
        ...(fanStart !== null ? { fanRef: fanStart.ref, door: "extension" as const } : { door: "workboard" as const }),
        ...(swap ? { swap: { date, pageLabels: swapPages, start: from, end: to, coverPersonCode: cover, ...(start?.swap?.absentPersonCode ? { absentPersonCode: start.swap.absentPersonCode } : {}) } } : {}),
      },
    }),
    onSuccess: (answer) => {
      toast.success(answer.question.decider.kind === "owner" ? "Вопрос ушёл владельцу" : `Вопрос ушёл: ${answer.question.decider.name}`);
      refresh();
      if (onAsked !== undefined) onAsked();
      else onClose();
    },
    onError: () => toast.error(swap ? "Подмена не ушла: проверьте день, часы и кто выйдет" : "Вопрос не ушёл. Попробуйте ещё раз"),
  });
  const ready = page !== "" && words !== "" && (!swap || swapReady) && !ask.isPending;
  return (
    <Modal
      title={kind === "schedule" ? "Предложить сетку" : swap ? "Попросить подмену" : "Спросить"}
      onClose={onClose}
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={!ready} loading={ask.isPending} onClick={() => ask.mutate()}>{kind === "schedule" ? "Предложить" : "Спросить"}</Button>
        </>
      )}
    >
      <div className="wt-ask">
        <p className="wt-ask__lead">
          {kind === "schedule" ? "Предложение уйдёт владельцу. Он ответит и сам поменяет график в карточке человека."
            : swap ? "Ответит тимлид команды, а если его нет, владелец. «Можно» сразу ставит подмену в график на этот день."
              : "Ответит тот, кто решает по этой модели: тимлид команды, а если его нет, владелец."}
        </p>
        {fanStart !== null ? (
          <p className="wt-ask__lead">{start?.pageLabel}{fanStart.name ? `, фан ${fanStart.name}` : ""}</p>
        ) : start?.swap === undefined && (
          <Field label="Страница">
            {(control) => (
              <Select {...control} value={page} onChange={(event) => setPageLabel(event.target.value)}>
                {list.map((one) => <option key={one.label} value={one.label}>{one.label}</option>)}
              </Select>
            )}
          </Field>
        )}
        {(start === undefined || fanStart !== null) && (
          <Field label="О чём">
            {(control) => (
              <Select {...control} value={kind} onChange={(event) => setKind(event.target.value as TeamQuestionKind)}>
                {kinds.map((one) => <option key={one} value={one}>{kindWord(one)}</option>)}
              </Select>
            )}
          </Field>
        )}
        {swap && (
          <>
            {start?.swap && (
              <p className="wt-ask__lead">
                {start.swap.absentName ? `Не выйдет ${start.swap.absentName}. ` : ""}{start.swap.pageLabels.join(", ")}
              </p>
            )}
            <Field label="День" hint="Подмену просят заранее, на завтра или позже">
              {(control) => <TextInput {...control} type="date" value={date} min={addDays(moscowToday(), 1)} onChange={(event) => setDate(event.target.value)} />}
            </Field>
            <div className="wt-ask__row">
              <Field label="С">
                {(control) => <TextInput {...control} value={from} onChange={(event) => setFrom(event.target.value)} placeholder="18:00" maxLength={5} />}
              </Field>
              <Field label="До">
                {(control) => <TextInput {...control} value={to} onChange={(event) => setTo(event.target.value)} placeholder="02:00" maxLength={5} />}
              </Field>
            </div>
            <Field label="Кто выйдет" hint="Человек той же команды">
              {(control) => (
                <Select {...control} value={cover} onChange={(event) => setCover(event.target.value)}>
                  <option value="">Выберите</option>
                  {covers.map((person) => <option key={person.code} value={person.code}>{person.displayName}</option>)}
                </Select>
              )}
            </Field>
          </>
        )}
        {!swap && kind !== "schedule" && fanStart === null && (
          <Field label="Фан" hint="Если вопрос про фана">
            {(control) => <TextInput {...control} value={fanName} onChange={(event) => setFanName(event.target.value)} maxLength={200} placeholder="Имя фана" />}
          </Field>
        )}
        <Field label={kind === "schedule" ? "Предложение" : swap ? "Пояснение" : "Вопрос"} hint={swap ? "По желанию: без него уйдёт день, часы и кто выйдет" : undefined}>
          {(control) => (
            <TextInput
              {...control}
              data-autofocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={500}
              placeholder={kind === "schedule" ? "Кто, какие дни и часы, с какого дня" : swap ? "Почему не выйду" : "Одной строкой: что хотите сделать"}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/** A swap's facts in words. */
function SwapFacts({ swap }: { swap: TeamQuestionSwap }) {
  return (
    <>
      <dt>Подмена</dt>
      <dd>
        {dayWords(swap.date)}, {swap.start}–{swap.end}, {swap.pages.join(", ")}: не выйдет {swap.absent.name}, выйдет {swap.cover.name}
        {swap.approved && <span className="wt-question__yes"> · стоит в графике</span>}
        {swap.revoked && <span className="wt-question__no"> · отменена</span>}
      </dd>
    </>
  );
}

function QuestionFacts({ question }: { question: TeamQuestion }) {
  return (
    <dl className="wt-question">
      <dt>О чём</dt>
      <dd>{kindWord(question.kind)}</dd>
      <dt>Страница</dt>
      <dd><PageLabel label={question.pageLabel} /></dd>
      {question.fan?.name && (<><dt>Фан</dt><dd>{question.fan.name}</dd></>)}
      <dt>Спросил</dt>
      <dd>{question.asker.name}, {formatDateTime(question.askedAt)}{question.door === "extension" ? ", из расширения" : ""}</dd>
      {question.swap && <SwapFacts swap={question.swap} />}
      <dt>Вопрос</dt>
      <dd className="wt-question__text">{question.text}</dd>
      <dt>Решает</dt>
      <dd>{question.decider.kind === "owner" ? "владелец" : question.decider.name}</dd>
      {question.state === "answered" && (
        <>
          <dt>Ответ</dt>
          <dd className={question.answer === "yes" ? "wt-question__yes" : "wt-question__no"}>
            {question.answer === "yes" ? "Можно" : "Нельзя"}{question.answerText ? `. ${question.answerText}` : ""}
            <span className="wt-question__by"> {question.answeredBy}, {question.answeredAt ? formatDateTime(question.answeredAt) : ""}</span>
          </dd>
        </>
      )}
      {question.state === "withdrawn" && (<><dt>Ответ</dt><dd>вопрос отозван</dd></>)}
    </dl>
  );
}

/** A question by the address: the decider answers it, the asker reads the answer or withdraws it. */
export function QuestionModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { narrow } = useMe();
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  const [line, setLine] = useState("");
  const read = useQuery({
    queryKey: [...QUESTIONS_KEY, "one", id],
    queryFn: () => kernel.teamQuestions({ query: { id } }),
    meta: { suppressGlobalError: true },
    retry: false,
  });
  const question = read.data?.questions[0] ?? null;
  const done = (words: string) => {
    toast.success(words);
    refresh();
    onClose();
  };
  const answer = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (value: "yes" | "no") => kernel.teamQuestionAnswer({ params: { id }, body: { answer: value, ...(line.trim() ? { text: line.trim() } : {}) } }),
    onSuccess: (_data, value) => done(value === "yes" ? "Ответ «Можно» ушёл" : "Ответ «Нельзя» ушёл"),
    onError: (error) => {
      const reason = (error as { body?: { reason?: unknown } } | null)?.body?.reason;
      toast.error(reason === "swap_started" ? "Подмена уже началась: ответьте «Нельзя» или оставьте" : "Ответ не записан: вопрос могли уже закрыть");
    },
  });
  const revoke = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.teamSwapRevoke({ params: { id } }),
    onSuccess: () => {
      done("Подмена отменена: график этого дня как был");
      void queryClient.invalidateQueries({ queryKey: ["team-swaps"] });
    },
    onError: () => toast.error("Не отменилось: день мог уже наступить"),
  });
  const close = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (how: "withdraw" | "seen") => kernel.teamQuestionClose({ params: { id }, body: { how } }),
    onSuccess: (_data, how) => done(how === "withdraw" ? "Вопрос отозван" : "Готово"),
    onError: () => toast.error("Не получилось. Попробуйте ещё раз"),
  });

  let actions = <Button variant="ghost" onClick={onClose}>Закрыть</Button>;
  // A swap is decided before its hours (Hub refuses «Можно» once they began, Moscow time).
  const swapBegun = question?.swap ? Date.parse(`${question.swap.date}T${question.swap.start}:00+03:00`) <= Date.now() : false;
  if (question?.canAnswer && !narrow) {
    actions = (
      <>
        <Button variant="secondary" loading={answer.isPending && answer.variables === "no"} disabled={answer.isPending} onClick={() => answer.mutate("no")}>Нельзя</Button>
        <Button variant="primary" loading={answer.isPending && answer.variables === "yes"} disabled={answer.isPending || swapBegun} onClick={() => answer.mutate("yes")}>Можно</Button>
      </>
    );
  } else if (question?.swap?.canRevoke) {
    actions = (
      <>
        <Button variant="ghost" onClick={onClose}>Закрыть</Button>
        <Button variant="secondary" loading={revoke.isPending} onClick={() => revoke.mutate()}>Отменить подмену</Button>
      </>
    );
  } else if (question?.mine && question.state === "answered" && !question.seen) {
    actions = <Button variant="primary" loading={close.isPending} onClick={() => close.mutate("seen")}>Понятно</Button>;
  } else if (question?.mine && question.state === "open") {
    actions = (
      <>
        <Button variant="ghost" loading={close.isPending} onClick={() => close.mutate("withdraw")}>Отозвать</Button>
        <Button variant="secondary" onClick={onClose}>Закрыть</Button>
      </>
    );
  }

  return (
    <Modal title={question ? `Вопрос: ${kindWord(question.kind).toLowerCase()}` : "Вопрос"} onClose={onClose} actions={actions}>
      {read.isPending && <div className="wt-modal"><Skeleton width="70%" /><Skeleton width="90%" /></div>}
      {read.isError && <ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Вопрос не открылся: его нет или он не ваш.</ErrorState>}
      {question && (
        <div className="wt-ask">
          <QuestionFacts question={question} />
          {question.canAnswer && (narrow
            ? <PasswordWayIn text="Чтобы ответить, войдите на сайте с паролем." />
            : (
              <Field label="Пояснение" hint="Одной строкой, по желанию: его увидит тот, кто спросил">
                {(control) => <TextInput {...control} data-autofocus value={line} onChange={(event) => setLine(event.target.value)} maxLength={500} />}
              </Field>
            ))}
          {question.mine && question.state === "open" && <p className="wt-ask__lead">Ждёт ответа. Ответ придёт сюда, в «Ждут вас».</p>}
          {question.swap?.canRevoke && narrow && <PasswordWayIn text="Чтобы отменить подмену, войдите на сайте с паролем." />}
          {question.canAnswer && swapBegun && <p className="wt-ask__lead">Подмена уже началась: ответьте «Нельзя» или оставьте.</p>}
        </div>
      )}
    </Modal>
  );
}

/** The asker's questions still waiting for an answer: above the list, so the asker sees them asked. */
export function MyOpenQuestions({ questions, onOpen }: { questions: readonly TeamQuestion[]; onOpen: (id: number) => void }) {
  if (questions.length === 0) return null;
  return (
    <section className="wt-asked" aria-label="Вы спросили">
      <h2 className="wt-asked__title">Вы спросили, ждёт ответа</h2>
      <ul className="wt-asked__list">
        {questions.map((question) => (
          <li key={question.id}>
            <button type="button" className="wt-asked__line" onClick={() => onOpen(question.id)}>
              <span className="wt-asked__what">{kindWord(question.kind)}: {question.text}</span>
              <span className="wt-asked__who">{question.pageLabel} · решает {question.decider.kind === "owner" ? "владелец" : question.decider.name} · {formatDateTime(question.askedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
