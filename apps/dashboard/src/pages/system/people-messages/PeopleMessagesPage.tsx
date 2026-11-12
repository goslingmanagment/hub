import { useState } from "react";
import type { PeopleMessageKindView, PeopleMessageRow, PeopleMessagesResponse, PeopleMessageSwitchResponse } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { usePeopleMessages, usePeopleMessageSwitch } from "@/api/peopleMessages";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTimeMsk } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { freshOf } from "../shared.js";

/**
 * Система → «Сообщения людям» (package S): the server's own sender of messages
 * to people in Telegram, kind by kind. Each kind: to whom and when, the exact
 * template, an example from the newest real object, on or off with the last
 * switch, and what was held in 7 days word for word. Turning a kind on is the
 * owner's press here, one kind at a time, after the sentence of what starts.
 */

const moscow = (at: string) => formatDateTimeMsk(at);

function Text({ children, label }: { children: string; label: string }) {
  return (
    <pre aria-label={label} className="min-w-0 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-hover-alt px-3 py-2 font-mono text-xs leading-5 text-text-primary">
      {children}
    </pre>
  );
}

function HeldList({ rows }: { rows: readonly PeopleMessageRow[] }) {
  return (
    <ol className="space-y-3">
      {rows.map((row) => (
        <li key={row.id} className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="font-medium text-text-primary">{row.to}</span>
            <span className="text-text-secondary">{row.about}</span>
            <span className="text-text-secondary">{moscow(row.at)}</span>
            <StatusBadge tone="off" bare>{row.words}</StatusBadge>
          </div>
          <Text label={`Задержанное сообщение: ${row.to}`}>{row.text}</Text>
        </li>
      ))}
    </ol>
  );
}

function switchLine(kind: PeopleMessageKindView): string {
  if (kind.lastSwitch === null) return "Ни разу не включался";
  return `${kind.lastSwitch.on ? "Включил" : "Выключил"}: ${kind.lastSwitch.by}, ${moscow(kind.lastSwitch.at)}`;
}

function KindCard({ kind, tokenSet, onTurn, done }: {
  kind: PeopleMessageKindView;
  tokenSet: boolean;
  onTurn: (kind: PeopleMessageKindView, on: boolean) => void;
  done: PeopleMessageSwitchResponse | undefined;
}) {
  const titleId = `people-message-${kind.kind.replace(/\./gu, "-")}`;
  const status = kind.on
    ? { word: tokenSet ? `Включено с ${moscow(kind.onSince!)}` : "Включено, но нет токена", tone: tokenSet ? "good" as const : "attention" as const }
    : { word: "Выключено", tone: "off" as const };
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-header flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="card-title">{kind.title}</h2>
          <span className="card-description">{kind.toWhom}{kind.audience === "press" ? ", по вашему нажатию" : ""}</span>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge tone={status.tone}>{status.word}</StatusBadge>
          {kind.on
            ? <button type="button" className="btn btn-sm" onClick={() => onTurn(kind, false)}>Выключить</button>
            : <button type="button" className="btn btn-sm" onClick={() => onTurn(kind, true)}>Включить</button>}
        </div>
      </div>
      <div className="space-y-4 px-6 pb-6">
        {kind.trigger === "not_connected" && kind.triggerNote && <Notice tone="info">{kind.triggerNote}</Notice>}
        {kind.blockedFor.map((line) => <Notice key={line} tone="warning">{line}. Для этой модели вид не сработает, пока чат не задан.</Notice>)}
        {done && (
          <Notice tone="success" role="status">
            {done.sentence} <span className="text-text-secondary">Записано: {done.audit.by}, {moscow(done.audit.at)}.</span>
          </Notice>
        )}
        <KeyValue rows={[
          { label: "Когда", value: kind.when },
          { label: "Предел", value: kind.capWords },
          { label: "Ночью", value: kind.quietWords },
          { label: "Переключения", value: switchLine(kind) },
          { label: "За 7 дней", value: countsLine(kind) },
        ]} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium text-text-secondary">Шаблон</h3>
            <Text label={`Шаблон: ${kind.title}`}>{kind.template}</Text>
          </div>
          <div className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium text-text-secondary">Пример{kind.example ? `: ${kind.example.about}` : ""}</h3>
            {kind.example ? <Text label={`Пример: ${kind.title}`}>{kind.example.text}</Text> : <p className="text-sm text-text-secondary">{kind.exampleMissing}</p>}
          </div>
        </div>
        {kind.held.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-text-secondary">Задержанные за 7 дней, новые сверху: дословно то, что ушло бы</h3>
            <HeldList rows={kind.held} />
          </div>
        )}
        <Disclosure label="Чтобы включить, нужно">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {kind.needs.map((need) => <li key={need}>{need}</li>)}
          </ul>
        </Disclosure>
      </div>
    </section>
  );
}

function countsLine(kind: PeopleMessageKindView): string {
  const parts = [`задержано ${kind.counts.held}`];
  if (kind.counts.sent > 0) parts.push(`отправлено ${kind.counts.sent}`);
  if (kind.counts.failed > 0) parts.push(`не ушло ${kind.counts.failed}`);
  if (kind.counts.unknown > 0) parts.push(`неизвестно ${kind.counts.unknown}`);
  return parts.join(", ");
}

function ChatsBlock({ chats }: { chats: PeopleMessagesResponse["chats"] }) {
  const set = (on: boolean) => (on ? "задан" : "не задан");
  return (
    <section className="card" aria-labelledby="people-messages-chats">
      <div className="card-header">
        <h2 id="people-messages-chats" className="card-title">Рабочие чаты</h2>
        <span className="card-description">Куда идут виды для групп: настройка peopleMessageChats в «Для разработчика», «Все параметры»</span>
      </div>
      <div className="px-6 pb-6">
        {chats.length === 0 ? <p className="text-sm text-text-secondary">Моделей нет.</p> : (
          <table className="data-table">
            <thead><tr><th>Модель</th><th>«Отчётность»</th><th>Кастомы</th></tr></thead>
            <tbody>
              {chats.map((chat) => (
                <tr key={chat.modelSlug}><td>{chat.modelName}</td><td>{set(chat.reports)}</td><td>{set(chat.customs)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** Система → «Сообщения людям». */
export function PeopleMessagesPage() {
  const query = usePeopleMessages();
  const turn = usePeopleMessageSwitch();
  const [asking, setAsking] = useState<{ kind: PeopleMessageKindView; on: boolean } | null>(null);
  const [done, setDone] = useState<Partial<Record<PeopleMessageKindView["kind"], PeopleMessageSwitchResponse>>>({});
  const data = query.data;
  const stale = query.isError && data !== undefined;
  const on = data?.kinds.filter((kind) => kind.on).length ?? 0;
  const held = data?.kinds.reduce((sum, kind) => sum + kind.counts.held, 0) ?? 0;

  const confirm = () => {
    if (asking === null || data === undefined) return;
    turn.mutate({ kind: asking.kind.kind, body: { on: asking.on, expectedVersion: data.kindsVersion ?? 0 } }, {
      onSuccess: (answer) => {
        setDone((current) => ({ ...current, [answer.kind]: answer }));
        toast.success(answer.on ? `Включено: ${asking.kind.title}` : `Выключено: ${asking.kind.title}`);
        setAsking(null);
      },
    });
  };

  return (
    <div className="space-y-6 sys-screen people-messages-screen">
      <PageHeader fresh={freshOf(query)} />
      {stale && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
          {staleDataText(query.dataUpdatedAt)}
        </Notice>
      )}

      {query.isLoading && !data ? (
        <div className="card"><TableSkeleton rows={6} columns={3} /></div>
      ) : !data ? (
        <div className="card"><NoAnswerPanel retry={query.refetch} /></div>
      ) : (
        <>
          <Notice tone={data.tokenSet ? "info" : "warning"} role="status">
            {data.sentence} Включено видов: {on} из {data.kinds.length}. За 7 дней задержано {held} {ruPlural(held, "сообщение", "сообщения", "сообщений")}.
          </Notice>
          {data.kinds.map((kind) => (
            <KindCard key={kind.kind} kind={kind} tokenSet={data.tokenSet} onTurn={(one, next) => { turn.reset(); setAsking({ kind: one, on: next }); }} done={done[kind.kind]} />
          ))}
          <ChatsBlock chats={data.chats} />
        </>
      )}

      <Disclosure label="Как это устроено">
        <p>
          Сервер сам пишет людям только то, что знает сам: сданный отчёт, карточку заказа, открытое дело. Каждое сообщение
          сначала записывается здесь. Уходит оно, только если есть токен бота и вид включён, и только для событий после
          включения: задержанное раньше не уйдёт никогда. Одно событие даёт одно сообщение, и попытка отправки одна: если
          Telegram не ответил, сообщение остаётся «неизвестно» и само не повторяется. Генгар здесь ни при чём: он пишет
          в чатах, как раньше.
        </p>
      </Disclosure>

      {asking !== null && data !== undefined && (
        <ConfirmModal
          title={asking.on ? `Включить: ${asking.kind.title}` : `Выключить: ${asking.kind.title}`}
          message={asking.on
            ? `${asking.kind.onSentence}${data.tokenSet ? "" : " Пока нет токена бота: сообщения будут задерживаться и не уйдут."}`
            : "Новые сообщения этого вида будут задерживаться и не уйдут. Задержанные не уйдут и после повторного включения."}
          facts={asking.on ? [
            { label: "Кому", value: asking.kind.toWhom },
            { label: "Когда", value: asking.kind.when },
            { label: "Предел", value: asking.kind.capWords },
            { label: "Ночью", value: asking.kind.quietWords },
            { label: "Отменить", value: "Кнопка «Выключить» здесь же; ушедшее в Telegram не отзывается" },
          ] : []}
          confirmLabel={asking.on ? "Включить" : "Выключить"}
          pendingLabel={asking.on ? "Включаем…" : "Выключаем…"}
          tone={asking.on ? "danger" : "primary"}
          initialFocus="cancel"
          error={turn.isError ? (turn.error as { status?: number } | null)?.status === 409
            ? "Пока вы смотрели, виды изменились. Закройте окно: экран обновится, нажмите ещё раз."
            : "Hub не ответил: неизвестно, сохранилось ли. Закройте окно и посмотрите на экран."
            : undefined}
          isPending={turn.isPending}
          onConfirm={confirm}
          onClose={() => { setAsking(null); void query.refetch(); }}
        />
      )}
    </div>
  );
}
