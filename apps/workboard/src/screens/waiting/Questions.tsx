import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TEAM_QUESTION_KINDS, TEAM_QUESTION_KIND_WORDS, type TeamQuestion, type TeamQuestionKind } from "@agency_hub_core/contracts";
import { Button, ErrorState, Field, Modal, PageLabel, Select, Skeleton, TextInput, toast } from "@agency_hub_core/ui";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import { PasswordWayIn } from "@/shared/PasswordWayIn";
import { useMe } from "@/shared/useMe";
import { usePages } from "@/shared/usePages";

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

/** «Спросить»: a page, what about, the fan when there is one, one line. */
export function AskModal({ onClose }: { onClose: () => void }) {
  const pages = usePages();
  const refresh = useRefresh();
  const [pageLabel, setPageLabel] = useState("");
  const [kind, setKind] = useState<TeamQuestionKind>("discount_over_50");
  const [fanName, setFanName] = useState("");
  const [text, setText] = useState("");
  const list = (pages.data ?? []).filter((page) => page.platform !== "telegram");
  const page = pageLabel || list[0]?.label || "";
  const ask = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.teamQuestionAsk({
      body: { pageLabel: page, kind, text: text.trim(), ...(fanName.trim() ? { fanName: fanName.trim() } : {}), door: "workboard" },
    }),
    onSuccess: (answer) => {
      toast.success(answer.question.decider.kind === "owner" ? "Вопрос ушёл владельцу" : `Вопрос ушёл: ${answer.question.decider.name}`);
      refresh();
      onClose();
    },
    onError: () => toast.error("Вопрос не ушёл. Попробуйте ещё раз"),
  });
  const ready = page !== "" && text.trim() !== "" && !ask.isPending;
  return (
    <Modal
      title="Спросить"
      onClose={onClose}
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={!ready} loading={ask.isPending} onClick={() => ask.mutate()}>Спросить</Button>
        </>
      )}
    >
      <div className="wt-ask">
        <p className="wt-ask__lead">Ответит тот, кто решает по этой модели: тимлид команды, а если его нет, владелец.</p>
        <Field label="Страница">
          {(control) => (
            <Select {...control} value={page} onChange={(event) => setPageLabel(event.target.value)}>
              {list.map((one) => <option key={one.label} value={one.label}>{one.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="О чём">
          {(control) => (
            <Select {...control} value={kind} onChange={(event) => setKind(event.target.value as TeamQuestionKind)}>
              {TEAM_QUESTION_KINDS.map((one) => <option key={one} value={one}>{kindWord(one)}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Фан" hint="Если вопрос про фана">
          {(control) => <TextInput {...control} value={fanName} onChange={(event) => setFanName(event.target.value)} maxLength={200} placeholder="Имя фана" />}
        </Field>
        <Field label="Вопрос">
          {(control) => <TextInput {...control} data-autofocus value={text} onChange={(event) => setText(event.target.value)} maxLength={500} placeholder="Одной строкой: что хотите сделать" />}
        </Field>
      </div>
    </Modal>
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
    onError: () => toast.error("Ответ не записан: вопрос могли уже закрыть"),
  });
  const close = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (how: "withdraw" | "seen") => kernel.teamQuestionClose({ params: { id }, body: { how } }),
    onSuccess: (_data, how) => done(how === "withdraw" ? "Вопрос отозван" : "Готово"),
    onError: () => toast.error("Не получилось. Попробуйте ещё раз"),
  });

  let actions = <Button variant="ghost" onClick={onClose}>Закрыть</Button>;
  if (question?.canAnswer && !narrow) {
    actions = (
      <>
        <Button variant="secondary" loading={answer.isPending && answer.variables === "no"} disabled={answer.isPending} onClick={() => answer.mutate("no")}>Нельзя</Button>
        <Button variant="primary" loading={answer.isPending && answer.variables === "yes"} disabled={answer.isPending} onClick={() => answer.mutate("yes")}>Можно</Button>
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
