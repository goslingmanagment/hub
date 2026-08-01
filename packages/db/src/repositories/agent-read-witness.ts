/**
 * The branded proof that a repository actually read a capture plane.
 *
 * WHY A BRAND: `capture.planes[].state = "read"` is a claim about what this
 * response is built on, and an agent reasons about the difference between "we
 * looked and found nothing" and "we never looked". If a handler could assemble
 * that record itself, the difference would rest on handler discipline — and the
 * first review round found four places where it already did not: #3 minted
 * witnesses for the money and CRM stores even when it never queried them, #4
 * minted for lanes it was not asked for, #5 minted the three message stores while
 * its SQL touched only the thread table, #10 minted `page_fans` for every dataset.
 *
 * So the constructor is module-private, is NOT re-exported by the package barrel
 * (a pin test asserts that), and every repository read RETURNS the witnesses for
 * the statements it actually executed. A handler can only pass them along.
 */

declare const planeReadWitnessBrand: unique symbol;

export interface PlaneReadWitness {
  readonly [planeReadWitnessBrand]: true;
  /** A plane name from the contracts registry. */
  readonly plane: string;
  /**
   * When this store's record of the scope begins, when the read could establish
   * it honestly. `oldest_stored_row` is a LOWER BOUND on what we hold; it never
   * asserts that nothing existed earlier.
   */
  readonly captureFloor: {
    readonly at: string | null;
    readonly kind: "oldest_stored_row" | "unknown";
  };
}

/**
 * Mints a witness for a statement that has ALREADY run. Internal to
 * `packages/db`; the barrel exports the type only.
 */
function mintPlaneReadWitness(plane: string, floorAt?: Date | string | null): PlaneReadWitness {
  const at = floorAt == null
    ? null
    : typeof floorAt === "string" ? floorAt : floorAt.toISOString();
  return {
    plane,
    captureFloor: at === null
      ? { at: null, kind: "unknown" }
      : { at, kind: "oldest_stored_row" },
  } as unknown as PlaneReadWitness;
}

/**
 * Witnesses for the planes one statement touched.
 *
 * Most reads establish no floor — an inventory table has no "history begins here"
 * to report — and those honestly report `unknown` rather than inventing one from
 * whichever row happened to come back first.
 */
export function witnessesFor(
  planes: readonly string[],
  floorAt?: Date | string | null,
): PlaneReadWitness[] {
  return planes.map((plane) => mintPlaneReadWitness(plane, floorAt));
}

export function witnessFor(plane: string, floorAt?: Date | string | null): PlaneReadWitness {
  return mintPlaneReadWitness(plane, floorAt);
}
