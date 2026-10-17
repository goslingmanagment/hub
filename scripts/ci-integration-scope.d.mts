export type ScopeRule = { test: (file: string) => boolean; reason: string };
export type Scope = { needed: boolean; reasons: string[]; files: number };
export type Verdict = { needed: boolean; summary: string };
export const INTEGRATION_PATHS: readonly ScopeRule[];
export function importsDatabase(source: string): boolean;
export function integrationScope(files: readonly string[], readSource: (file: string) => string | null): Scope;
export function changedFiles(base?: string, head?: string): string[];
export function readChangedSource(file: string, base?: string, head?: string): string | null;
export function decide(env: Readonly<Record<string, string | undefined>>, readChanges: () => Scope): Verdict;
