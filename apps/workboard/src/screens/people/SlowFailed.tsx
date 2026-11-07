import { Button, Notice } from "@agency_hub_core/ui";

/** The slow numbers (reply, unanswered at the end, AI share) did not come: said once, with the one way to try again. */
export function SlowFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Notice tone="warning" role="alert" action={<Button size="sm" onClick={onRetry}>Повторить</Button>}>
      Ответ, «без ответа в конце» и доля ИИ не пришли. Это не ноль: Hub их не прислал.
    </Notice>
  );
}
