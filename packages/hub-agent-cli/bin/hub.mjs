#!/usr/bin/env node
// The `hub` entry point.
//
// This workspace has no build step for packages: everything runs from TypeScript
// source through tsx, and the CLI is no exception. So the bin is a four-line
// loader that registers the loader hooks and then imports the real entry, rather
// than a compiled artifact that would need its own build and its own drift gate.
//
// Equivalent without the bin (from a checkout): pnpm hub <command> ...
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
