import { useEffect, useReducer } from "react";
import { toast } from "sonner";
import type { PageFanDetailResponse } from "@agency_hub_core/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCreateFanNote } from "@/api/queries";
import { kernel } from "@/api/sdk";
import { Spinner } from "@/components/ui/Skeleton";
import { formatDateTime } from "@/lib/format";
import { isUnknownOutcome, UNKNOWN_OUTCOME } from "@/pages/settings/settingsFeedback";
import { fanNoteDraftsReducer } from "./fanNoteDrafts.js";

type Note = PageFanDetailResponse["page"]["notes"][number];

/** Who wrote a note: the owner sees the staff list; a team lead and an unknown number see no name. */
export function useStaffList(owner: boolean) {
  // The same key as `useAdminUsers`: one read for the whole console, and none for a team lead.
  return useQuery({ queryKey: ["admin", "users"], queryFn: () => kernel.adminListUsers(), enabled: owner, meta: { suppressGlobalError: true } });
}

function useAuthors(owner: boolean) {
  const users = useStaffList(owner);
  if (!owner) return new Map<number, string>();
  return new Map((users.data ?? []).map((user) => [user.id, user.username]));
}

/**
 * «Заметка для страницы mia-1». The page and the fan come from the path, never
 * from the filter; one press, one request, the draft stays until it succeeds (§8.4).
 */
export function FanNotes({ pageLabel, platformUserId, routeKey, principalId, notes, owner }: {
  pageLabel: string;
  platformUserId: string;
  routeKey: string;
  principalId: number | null;
  notes: readonly Note[];
  owner: boolean;
}) {
  const [noteDrafts, dispatchNoteDraft] = useReducer(fanNoteDraftsReducer, { principalId, drafts: {} });
  const noteBody = noteDrafts.principalId === principalId ? noteDrafts.drafts[routeKey] ?? "" : "";
  const setNoteBody = (text: string) => dispatchNoteDraft({ type: "edit", principalId, routeKey, text });
  useEffect(() => { dispatchNoteDraft({ type: "principal", principalId }); }, [principalId]);
  const createNote = useCreateFanNote();
  const authors = useAuthors(owner);

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
