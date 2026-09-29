/** Returns the endpoint's JSON, or a promise of it. */
export type ProofApi = (endpoint: string) => unknown;
export function assertPublishableTitle(title: string): void;
export function findProof(options: { repo: string; repoId: string; name: string; api: ProofApi }): Promise<string>;
export function lookupProofs(env: Readonly<Record<string, string | undefined>>, api: ProofApi): Promise<{
  proven_by: string;
  integration_proven_by: string;
}>;
