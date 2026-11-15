import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ErrorState, Skeleton } from "@agency_hub_core/ui";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import { PasswordWayIn } from "@/shared/PasswordWayIn";
import { useMe } from "@/shared/useMe";

/**
 * The lead's notes on a shift (products package T, `review_notes`): the chatter of the shift, the lead of its team and
 * the owner read them, the rest of the team does not (Hub decides). The lead and the owner leave one here.
 */
export function ReviewNotes({ userId, at }: { userId: number; at: string }) {
  const { narrow, accountRole } = useMe();
  const queryClient = useQueryClient();
  const key = ["team", "review-notes", userId, at] as const;
  const read = useQuery({ queryKey: key, queryFn: () => kernel.reviewNotes({ query: { userId, at } }) });
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => kernel.reviewNoteAdd({ body: { userId, at, text: text.trim() } }),
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  if (read.isPending) return <section className="review-notes-box" aria-label="Заметки"><Skeleton width="40%" /></section>;
  if (read.isError) return <ErrorState compact onRetry={() => void read.refetch()} retrying={read.isFetching}>Заметки не пришли.</ErrorState>;
  const { notes, canWrite } = read.data;
  // A lead's own login opened from the extension: the note waits for the password.
  const wayIn = narrow && accountRole !== "chatter";
  if (notes.length === 0 && !canWrite && !wayIn) return null;
  return (
    <section className="review-notes-box" aria-label="Заметки">
      <h3 className="review-notes-box__title">Заметки к смене</h3>
      {notes.length === 0
        ? <p className="review-notes-box__empty">Заметок пока нет. Их видят чаттер, тимлид и владелец.</p>
        : (
          <ul className="review-notes-box__list">
            {notes.map((note) => (
              <li key={note.id}>
                <span className="review-notes-box__who">{note.authorName}, {formatDateTime(note.createdAt)}</span>
                <span className="review-notes-box__text">{note.text}</span>
              </li>
            ))}
          </ul>
        )}
      {canWrite && (
        <form
          className="review-notes-box__form"
          onSubmit={(event) => { event.preventDefault(); if (text.trim() !== "") add.mutate(); }}
        >
          <textarea
            className="ui-input review-notes-box__input"
            value={text}
            maxLength={2000}
            rows={2}
            placeholder="Заметка для чаттера: что хорошо, что поправить"
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={text.trim() === "" || add.isPending}>Оставить заметку</Button>
        </form>
      )}
      {wayIn && !canWrite && <PasswordWayIn text="Чтобы оставить заметку, войдите на сайте с паролем." />}
    </section>
  );
}
