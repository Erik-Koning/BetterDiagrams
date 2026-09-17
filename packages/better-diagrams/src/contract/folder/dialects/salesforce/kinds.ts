/**
 * kinds.ts — the node kinds a Salesforce data model draws with.
 *
 * A named preset the host hands to the editor's `registry` prop — never
 * folded into the core `NODE_KINDS`, so the library stays domain-agnostic.
 * Four object kinds rather than one coloured by tag: the eye reads kind, and
 * the inspector dropdown stays meaningful.
 */
import type { DialectRegistry } from "../../types";

export const SALESFORCE_KINDS = {
  "sf-object": {
    label: "Custom object",
    fill: "#1a2233",
    accent: "#38bdf8",
    text: "#e2e8f0",
    icon: "database",
    record: true,
  },
  "sf-object-std": {
    label: "Standard object",
    fill: "#1e2a1e",
    accent: "#4ade80",
    text: "#e2e8f0",
    icon: "database",
    record: true,
  },
  "sf-object-fsc": {
    label: "FSC object",
    fill: "#2a1e33",
    accent: "#c084fc",
    text: "#e2e8f0",
    icon: "layers",
    record: true,
  },
  "sf-external": {
    label: "External object",
    fill: "#2a2a2a",
    accent: "#94a3b8",
    text: "#e2e8f0",
    icon: "link",
  },
  "sf-view": {
    label: "View",
    fill: "#1e2a33",
    accent: "#22d3ee",
    text: "#e2e8f0",
    icon: "filter",
  },
  "sf-record-type": {
    label: "Record type",
    fill: "#332a1e",
    accent: "#fbbf24",
    text: "#e2e8f0",
    icon: "pin",
  },
} as const satisfies NonNullable<DialectRegistry["nodeKinds"]>;

export type SalesforceKind = keyof typeof SALESFORCE_KINDS;

/** Hand this to `ArchitectureStudio`'s `registry` prop. */
export const salesforceRegistry: DialectRegistry = { nodeKinds: SALESFORCE_KINDS };

/** `curated.diagramType` / `object.kind` → node kind. */
export function objectKind(diagramType: string | undefined, objectKind: string | undefined, apiName: string): SalesforceKind {
  const hint = (diagramType ?? objectKind ?? "custom").toLowerCase();
  if (hint === "external" || apiName.endsWith("__x")) return "sf-external";
  if (hint === "standard") return "sf-object-std";
  if (hint === "fsc") return "sf-object-fsc";
  return "sf-object";
}

/** The inverse, for writing `diagramType` back to an `object.yaml`. */
export function diagramTypeOf(kind: string): string | undefined {
  switch (kind) {
    case "sf-object":
      return "custom";
    case "sf-object-std":
      return "standard";
    case "sf-object-fsc":
      return "fsc";
    case "sf-external":
      return "external";
    case "sf-record-type":
      return "record-type";
    default:
      return undefined;
  }
}
