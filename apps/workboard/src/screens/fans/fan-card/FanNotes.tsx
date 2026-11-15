import { useEffect, useReducer } from "react";
import { toast } from "sonner";
import type { PageFanDetailResponse } from "@agency_hub_core/contracts";
import { useCreateFanNote } from "@/screens/fans/data";
import { usePeopleIndex } from "@/shared/people";
import { PasswordWayIn } from "@/shared/PasswordWayIn";
import { useMe } from "@/shared/useMe";
import { Spinner } from "@agency_hub_core/ui/console/Skeleton";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { isUnknownOutcome, UNKNOWN_OUTCOME } from "@agency_hub_core/ui/console/settingsFeedback";
import { fanNoteDraftsReducer } from "./fanNoteDrafts.js";

type Note = PageFanDetailResponse["page"]["notes"][number];

/** Who wrote a note: the person of the login, by the registry the team reads (Workboard's one name of a person). */
function useAuthors() {
  const people = usePeopleIndex();
  return { get: (userId: number) => people.personOf(userId)?.displayName ?? null };
}

/**
 * «Заметка для страницы mia-1». The page and the fan come from the path, never
 * from the filter; one press, one request, the draft stays until it succeeds (§8.4).
 */
export function FanNotes({ pageLabel, platformUserId, routeKey, principalId, notes }: {
  pageLabel: string;
  platformUserId: string;
  routeKey: string;
  principalId: number | null;
  notes: readonly Note[];
}) {
  const [noteDrafts, dispatchNoteDraft] = useReducer(fanNoteDraftsReducer, { principalId, drafts: {} });
  const noteBody = noteDrafts.principalId === principalId ? noteDrafts.drafts[routeKey] ?? "" : "";
  const setNoteBody = (text: string) => dispatchNoteDraft({ type: "edit", principalId, routeKey, text });
  useEffect(() => { dispatchNoteDraft({ type: "principal", principalId }); }, [principalId]);
  const createNote = useCreateFanNote();
  const authors = useAuthors();
  // A narrow session (from the extension) reads the notes; writing one needs the password.
  const { narrow } = useMe();

  async function handleAddNote() {
    const body = noteBody.trim();
    if (!body || createNote.isPending) return;
    const submittedRoute = routeKey;
    const submittedText = noteBody;
    const submittedPrincipalId = principalId;
    try {
      await createNote.mutateAsync({ pageLabel, platformUserId, body });
      dispatchNoteDraft({ type: "saved", principalId: submittedPrincipalId, routeKey: submittedRoute, submittedText });
      toast.success(`Заметка добавлена на ${pageLabel}`);
    } catch (error) {
      toast.error(isUnknownOutcome(error)
        ? `${UNKNOWN_OUTCOME} Обновите экран и проверьте заметки. Текст остался в поле.`
        : "Не удалось добавить заметку: Hub отказал. Текст остался в поле.");
    }
  }

  return (
    <section className="card" aria-labelledby="fan-notes-title">
      <div className="card-header">
        <h2 id="fan-notes-title" className="card-title">Заметка для страницы {pageLabel}</h2>
      </div>
      <div className="card-body fan-notes">
        {narrow ? <PasswordWayIn text="Чтобы добавить заметку, войдите на сайте с паролем." /> : <>
        <textarea
          aria-label="Новая заметка о фане"
          value={noteBody}
          onChange={(event) => setNoteBody(event.target.value)}
          placeholder="Напишите заметку…"
          rows={3}
          className="textarea"
        />
        <div className="fan-notes-actions">
          <button type="button" onClick={() => void handleAddNote()} disabled={!noteBody.trim() || createNote.isPending} className="btn btn-primary btn-sm">
            {createNote.isPending ? <><Spinner /> Сохраняем…</> : "Добавить заметку"}
          </button>
        </div>
        </>}
        {notes.length === 0 ? (
          <p className="fan-muted-line">Заметок пока нет.</p>
        ) : (
          <ul className="fan-note-list">
            {[...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((note) => {
              const author = note.authorUserId === null ? null : authors.get(note.authorUserId) ?? null;
              return (
                <li key={note.id}>
                  <p className="fan-note-meta">{formatDateTime(note.createdAt, { yearUnlessCurrent: true })}{author && ` · ${author}`}</p>
                  <p className="fan-note-body">{note.body}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
