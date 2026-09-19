export type ProofApi = (endpoint: string) => unknown;
export function assertPublishableTitle(title: string): void;
export function findProof(options: { repo: string; repoId: string; name: string; api: ProofApi }): string;
export function lookupProofs(env: Readonly<Record<string, string | undefined>>, api: ProofApi): {
  proven_by: string;
  integration_proven_by: string;
};
