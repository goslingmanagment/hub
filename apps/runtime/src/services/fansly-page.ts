import { BadRequestError } from "./errors.ts";

/** Shared provider guard for authenticated routes and trusted operator tools. */
export function assertFanslyPage(page: { platform: string }, message: string) {
  if (page.platform !== "fansly") throw new BadRequestError(message);
}
