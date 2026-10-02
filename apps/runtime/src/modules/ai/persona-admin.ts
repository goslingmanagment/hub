import {
  AiPersonaVersionConflictError,
  archiveAiPersona,
  findAiPersonaByKey,
  upsertAiPersona,
} from "@agency_hub_core/db";

import { auditCtx } from "../../api/request-auth.ts";
import type { AppContext } from "../../bootstrap.ts";
import {
  recordAudit,
  withAuditTransaction,
  type HumanAuthPrincipal,
} from "../../services/auth.ts";
import { ConflictError, NotFoundError } from "../../services/errors.ts";
import { aiPersonaDefinitionId } from "./persona-definition.ts";

// The one write lane for AI personas: owner cookie session, optimistic
// concurrency on every mutation, and an audit row committed in the SAME
// transaction as the change. A version conflict rolls back before any audit is
// written, so the trail holds only changes that happened.
//
// The audit metadata never carries prompt text. audit_events is dual-written to
// the observation journal, and prompts are owner content; the definition id is
// enough to tell whether the prompt changed between two versions.

type PersonaRow = Awaited<ReturnType<typeof upsertAiPersona>>;

function definitionOf(persona: PersonaRow | undefined | null) {
  return persona ? aiPersonaDefinitionId(persona) : null;
}

function personaAuditMetadata(
  persona: PersonaRow,
  previous: { version: number | null; definitionId: string | null },
) {
  return {
    personaKey: persona.key,
    displayName: persona.displayName,
    version: persona.revision,
    previousVersion: previous.version,
    definitionId: aiPersonaDefinitionId(persona),
    previousDefinitionId: previous.definitionId,
    systemBlockChars: persona.systemBlock.length,
  };
}

function rethrowVersionConflict(error: unknown): never {
  if (error instanceof AiPersonaVersionConflictError) {
    throw new ConflictError(error.message);
  }
  throw error;
}

export async function createAiPersonaAsOwner(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { key: string; displayName: string; systemBlock: string },
): Promise<PersonaRow> {
  try {
    return await withAuditTransaction(app, async (db) => {
      const persona = await upsertAiPersona(db, { ...input, expectedVersion: null });
      await recordAudit({ db }, {
        ...auditCtx(principal),
        eventType: "ai_persona.created",
        metadata: personaAuditMetadata(persona, { version: null, definitionId: null }),
      });
      return persona;
    });
  } catch (error) {
    rethrowVersionConflict(error);
  }
}

export async function updateAiPersonaAsOwner(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { key: string; displayName: string; systemBlock: string; expectedVersion: number },
): Promise<PersonaRow> {
  try {
    return await withAuditTransaction(app, async (db) => {
      // Read inside the transaction: if this row is not the expected revision,
      // the compare-and-set below fails and nothing is recorded.
      const before = await findAiPersonaByKey(db, input.key);
      const persona = await upsertAiPersona(db, input);
      await recordAudit({ db }, {
        ...auditCtx(principal),
        eventType: "ai_persona.updated",
        metadata: personaAuditMetadata(persona, {
          version: input.expectedVersion,
          definitionId: definitionOf(before),
        }),
      });
      return persona;
    });
  } catch (error) {
    rethrowVersionConflict(error);
  }
}

export async function archiveAiPersonaAsOwner(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { key: string; expectedVersion: number },
): Promise<PersonaRow> {
  let archived: PersonaRow | null;
  try {
    archived = await withAuditTransaction(app, async (db) => {
      const persona = await archiveAiPersona(db, input.key, input.expectedVersion);
      if (persona === null) {
        return null;
      }
      await recordAudit({ db }, {
        ...auditCtx(principal),
        eventType: "ai_persona.archived",
        metadata: personaAuditMetadata(persona, {
          version: input.expectedVersion,
          // Archiving changes the lifecycle, not the definition bytes.
          definitionId: aiPersonaDefinitionId(persona),
        }),
      });
      return persona;
    });
  } catch (error) {
    rethrowVersionConflict(error);
  }
  if (archived === null) {
    throw new NotFoundError("Persona not found");
  }
  return archived;
}
