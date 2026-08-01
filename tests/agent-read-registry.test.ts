import { describe, expect, it } from "vitest";

import {
  AGENT_CLAIM_CLASS_NAMES,
  AGENT_CLAIM_FIELD_CLASS,
  AGENT_CLAIM_FIELDS,
  AGENT_PLANE_COUNT,
  AGENT_PLANE_NAMES,
  agentClassPlanes,
  agentPlaneRole,
  requiredPlanesForClaimFields,
} from "@agency_hub_core/contracts";

/**
 * These pins exist because three adversarial review rounds of the Agent Read
 * Plane design each found defects caused by the same vocabulary being restated
 * in several places and drifting. The registry is now derived from one literal;
 * these tests make a drift fail CI instead of shipping a lie in a response body.
 */
describe("agent read registry", () => {
  it("every claim field belongs to exactly one class", () => {
    const owners = new Map<string, string[]>();
    for (const className of AGENT_CLAIM_CLASS_NAMES) {
      for (const field of agentClassPlanes(className).fields) {
        owners.set(field, [...(owners.get(field) ?? []), className]);
      }
    }
    const duplicated = [...owners.entries()].filter(([, classes]) => classes.length > 1);
    expect(duplicated).toEqual([]);
    expect(AGENT_CLAIM_FIELD_CLASS.size).toBe(AGENT_CLAIM_FIELDS.length);
  });

  it("no class has an empty required-plane set", () => {
    // A class with no required plane could never block a negative conclusion,
    // which would let `absenceProvable` be true for facts nothing was read for.
    const empty = AGENT_CLAIM_CLASS_NAMES.filter(
      (name) => agentClassPlanes(name).required.length === 0,
    );
    expect(empty).toEqual([]);
  });

  it("required and evidentiary sets never overlap within a class", () => {
    for (const name of AGENT_CLAIM_CLASS_NAMES) {
      const { required, evidentiary } = agentClassPlanes(name);
      const overlap = required.filter((plane) => evidentiary.includes(plane));
      expect({ name, overlap }).toEqual({ name, overlap: [] });
    }
  });

  it("the derived plane list covers every plane named by any class, with no duplicates", () => {
    const declared = new Set<string>();
    for (const name of AGENT_CLAIM_CLASS_NAMES) {
      const { required, evidentiary } = agentClassPlanes(name);
      for (const plane of [...required, ...evidentiary]) {
        declared.add(plane);
      }
    }
    expect([...AGENT_PLANE_NAMES].sort()).toEqual([...declared].sort());
    expect(AGENT_PLANE_NAMES.length).toBe(new Set(AGENT_PLANE_NAMES).size);
    expect(AGENT_PLANE_COUNT).toBe(AGENT_PLANE_NAMES.length);
  });

  it("plane roles are exhaustive and mutually exclusive per class", () => {
    for (const name of AGENT_CLAIM_CLASS_NAMES) {
      for (const plane of AGENT_PLANE_NAMES) {
        const role = agentPlaneRole(name, plane);
        expect(["required", "evidentiary", "not_applicable"]).toContain(role);
      }
      for (const plane of agentClassPlanes(name).required) {
        expect(agentPlaneRole(name, plane)).toBe("required");
      }
      for (const plane of agentClassPlanes(name).evidentiary) {
        expect(agentPlaneRole(name, plane)).toBe("evidentiary");
      }
    }
  });

  it("an unknown claim field fails closed rather than resolving to an empty set", () => {
    // Fail-closed matters: an empty required set reads as "nothing had to be
    // read", which would permit a negative conclusion about an unobservable field.
    expect(requiredPlanesForClaimFields(["textPlain"])).toEqual(["message_archive", "dm_message_archive"]);
    expect(requiredPlanesForClaimFields(["textPlain", "definitelyNotAField"])).toBeNull();
    // An empty claim fails closed too — "all required planes read" is vacuously
    // true over an empty set, which would authorise a conclusion nothing was read for.
    expect(requiredPlanesForClaimFields([])).toBeNull();
  });

  it("each field requires ITS OWN authoritative store, not the class's", () => {
    // Codex review P1. With a class-level required set (`crm: ["fan_notes"]`),
    // a reader could satisfy the check by reading NOTES and then assert "this
    // fan has no profile body" without ever opening `fan_profiles`. Required
    // planes are therefore a property of the field.
    expect(requiredPlanesForClaimFields(["profileBody"])).toEqual(["fan_profiles"]);
    expect(requiredPlanesForClaimFields(["noteText"])).toEqual(["fan_notes"]);
    expect(requiredPlanesForClaimFields(["summaryText"])).toEqual(["fan_summaries"]);
    expect(requiredPlanesForClaimFields(["fanFlag"])).toEqual(["fan_flags"]);
    // A lifetime figure is not answered by a windowed transactions read.
    expect(requiredPlanesForClaimFields(["lifetimeSpendMills"])).toEqual(["fan_spend_lifetime"]);
    expect(requiredPlanesForClaimFields(["grossMills"])).toEqual(["transactions"]);
    expect(requiredPlanesForClaimFields(["postRef", "postText", "publishedAt"]))
      .toEqual(["creator_posts"]);
    // Union across fields of different classes.
    expect(requiredPlanesForClaimFields(["profileBody", "grossMills"]))
      .toEqual(["fan_profiles", "transactions"]);
  });

  it("the capture journal is never a required plane", () => {
    // Production fact (2026-07-31): observations begins 2026-07-05. Requiring it
    // made `absenceProvable` structurally false on every historical window —
    // the exact defect that motivated the required/evidentiary split.
    const journalPlanes = ["observations", "sync_raw_payloads"];
    for (const name of AGENT_CLAIM_CLASS_NAMES) {
      const { required } = agentClassPlanes(name);
      for (const journal of journalPlanes) {
        expect({ name, journal, required: required.includes(journal) })
          .toEqual({ name, journal, required: false });
      }
    }
  });
});
