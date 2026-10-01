export const ALLOW_MISSING_TEST_PREREQUISITES_ENV = "ALLOW_MISSING_TEST_PREREQUISITES";

/** Never in CI: there the switch would turn every DB test into a skip and
 * the run would still pass. */
function refusedInCi(env: NodeJS.ProcessEnv) {
  return env[ALLOW_MISSING_TEST_PREREQUISITES_ENV] === "1" && env.CI === "true"
    ? `${ALLOW_MISSING_TEST_PREREQUISITES_ENV}=1 is refused with CI=true: CI never skips a test for a missing prerequisite.`
    : null;
}

/** Whether a missing prerequisite skips its tests; asking for it with CI=true throws. */
export function allowMissingTestPrerequisites(env: NodeJS.ProcessEnv = process.env) {
  const refusal = refusedInCi(env);
  if (refusal) throw new Error(refusal);
  return env[ALLOW_MISSING_TEST_PREREQUISITES_ENV] === "1";
}

function formatOriginalError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildMissingPrerequisiteMessage(input: {
  prerequisite: string;
  reason: string;
}, error: unknown) {
  return [
    `Missing test prerequisite: ${input.prerequisite}.`,
    input.reason,
    ...(process.env.CI === "true" ? [] : [`Set ${ALLOW_MISSING_TEST_PREREQUISITES_ENV}=1 to skip these tests instead.`]),
    `Original error: ${formatOriginalError(error)}`,
  ].join(" ");
}

export function handleMissingTestPrerequisite<T>(
  error: unknown,
  input: {
    prerequisite: string;
    reason: string;
  },
): T | null {
  const message = buildMissingPrerequisiteMessage(input, error);
  const refusal = refusedInCi(process.env);
  if (refusal) {
    throw new Error(`${refusal} ${message}`, { cause: error });
  }
  if (allowMissingTestPrerequisites()) {
    console.warn(`Skipping tests: ${message}`);
    return null;
  }

  if (error instanceof Error) {
    throw new Error(message, { cause: error });
  }

  throw new Error(message);
}

export async function acquireTestPrerequisite<T>(
  load: () => Promise<T>,
  input: {
    prerequisite: string;
    reason: string;
  },
): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    return handleMissingTestPrerequisite<T>(error, input);
  }
}
