import { AppError } from "./errors.ts";

/** A request that would make a page read, asked while the Fansly Sync Engine
 *  takes it over or gives it back (`handover`): neither engine reads it until
 *  the switch (or rollback) completes. */
export class FanslyPageSwitchingError extends AppError {
  constructor(label: string) {
    super(
      `${label} is being switched to the Fansly Sync Engine (handover): neither engine reads it until the switch completes`,
      409,
      "fansly_page_switching",
    );
    this.name = "FanslyPageSwitchingError";
  }
}
