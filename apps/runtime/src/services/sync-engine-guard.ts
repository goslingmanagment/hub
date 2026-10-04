import { AppError } from "./errors.ts";

/** A request that would make a page read, asked of a page in `handover`:
 *  neither engine reads it. Nothing puts a page there since step 4 (S4-21:
 *  the step-3 switch and its rollback are gone); a row that says so is still
 *  refused. */
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
