/** A sentence that may end on an abbreviation («…1 нояб.»): one full stop, never two. */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}
