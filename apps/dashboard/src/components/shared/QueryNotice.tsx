export function QueryNotice({ error, stale, retry }: {
  error: boolean;
  stale: boolean;
  retry: () => unknown;
}) {
  if (!error) return null;
  return (
    <p className="notice notice-warning mb-3" role="alert">
      <span className="min-w-0 flex-1">
        {stale
          ? "Обновление не удалось. Показаны ранее полученные данные."
          : "Данные не удалось загрузить."}
      </span>
      <button
        type="button"
        className="shrink-0 font-semibold underline underline-offset-2"
        onClick={() => void retry()}
      >
        Повторить
      </button>
    </p>
  );
}
