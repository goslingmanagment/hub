export function QueryNotice({ error, stale, retry }: {
  error: boolean;
  stale: boolean;
  retry: () => unknown;
}) {
  if (!error) return null;
  return (
    <p className="mb-3 rounded-lg border border-warning bg-hover-alt px-3 py-2 text-xs text-text-secondary" role="alert">
      {stale
        ? "Обновление не удалось. Показаны ранее полученные данные."
        : "Данные не удалось загрузить."}{" "}
      <button
        type="button"
        className="font-semibold text-accent underline underline-offset-2 focus-visible:outline-2"
        onClick={() => void retry()}
      >
        Повторить
      </button>
    </p>
  );
}
