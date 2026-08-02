/**
 * create-registry.ts — the one place that knows both halves.
 *
 * `resolveRegistry` takes its exporter defaults as an argument so it never has
 * to import `exporters.ts`, which needs the registry's types. This module is
 * the join: it depends on both, and nothing depends on it except the component
 * and the public barrel. The result is a plain DAG —
 *
 *   create-registry → registry     → registry-types
 *                   → exporters    → registry-types
 *
 * — where before there was a `registry ↔ exporters` cycle held together only
 * by hoisting.
 */
import { resolveRegistry } from "./registry";
import { BUILTIN_EXPORTERS } from "./exporters";
import type { RegistryExtensions, ResolvedRegistry } from "./registry-types";

/** Resolve a registry with the built-in exporters included. */
export function createRegistry(extensions: RegistryExtensions = {}): ResolvedRegistry {
  return resolveRegistry(extensions, BUILTIN_EXPORTERS);
}
