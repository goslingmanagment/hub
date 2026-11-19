/** The prototype's own 16-unit icons (columns.html `I`), drawn the same way: 1.6 stroke, round caps. */
const PATHS = {
  report: <><path d="M4 2.4h5.4l2.8 2.8v8.4H4z" /><path d="M9.2 2.6v2.8H12" /><path d="M6 9.7l1.4 1.4 2.6-2.9" /></>,
  check: <path d="M3.2 8.4l3 2.9L12.8 4.8" />,
  tick: <path d="M3.6 8.3l2.7 2.6 6-6.2" />,
  dash: <path d="M4.5 8h7" />,
  chev: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  note: <path d="M2.8 4.2a1.6 1.6 0 0 1 1.6-1.6h7.2a1.6 1.6 0 0 1 1.6 1.6v4.6a1.6 1.6 0 0 1-1.6 1.6H8l-3 2.6v-2.6h-.6a1.6 1.6 0 0 1-1.6-1.6z" />,
  clock: <><circle cx="8" cy="8" r="5.6" /><path d="M8 5v3.2l2.1 1.3" /></>,
  people: <><circle cx="5.8" cy="6" r="2.2" /><path d="M2 13c.4-2 1.8-3.2 3.8-3.2S9.2 11 9.6 13" /><circle cx="11" cy="5.4" r="1.8" /><path d="M10.4 9.3c1.9-.2 3.3.9 3.7 3.1" /></>,
  copy: <><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.6" /><path d="M10.5 5.5V4.2A1.2 1.2 0 0 0 9.3 3H4.2A1.2 1.2 0 0 0 3 4.2v5.1a1.2 1.2 0 0 0 1.2 1.2h1.3" /></>,
  pen: <><path d="M10.6 2.9l2.5 2.5-7.6 7.6-3.1.6.6-3.1z" /><path d="M9.2 4.3l2.5 2.5" /></>,
  min: <path d="M3.5 12h9" />,
  back: <path d="M9.8 3.6L5.4 8l4.4 4.4" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Ico({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className ? `ico ${className}` : "ico"} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
