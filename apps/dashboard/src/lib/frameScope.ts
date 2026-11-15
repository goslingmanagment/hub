/**
 * A content screen inside ContentOps (products plan §2.4, src/frame/) is about one model: ContentOps names it in the
 * first address (`?model=<Hub's slug>`). Read once when the page starts, so the screen's own changes of its address
 * never lose it; the console itself never sets it (null: every page the person reaches).
 */
let model: string | null = null;
let screen = false;

/** Called once by a content screen's start (src/frame/mount.tsx): the page is that screen, and this its model. */
export function setFrameModel(value: string | null): void {
  screen = true;
  model = value === null || value.trim() === "" ? null : value.trim().toLowerCase();
}

/** Whether this page is a content screen (no console around it: the console's own screens open beside it). */
export function isContentScreen(): boolean {
  return screen;
}

export function frameModel(): string | null {
  return model;
}
