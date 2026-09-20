/**
 * kinds.ts — the node kinds a data model draws with.
 *
 * A named preset the host hands to the editor's `registry` prop — never
 * folded into the core `NODE_KINDS`, so the library stays domain-agnostic.
 * Three entity kinds rather than one coloured by tag: the eye reads kind,
 * and the inspector dropdown stays meaningful.
 */
import type { DialectRegistry } from "../../types";

export const DATAMODEL_KINDS = {
  entity: {
    label: "Entity",
    fill: "#1a2233",
    accent: "#38bdf8",
    text: "#e2e8f0",
    icon: "database",
    record: true,
  },
  "entity-standard": {
    label: "Standard entity",
    fill: "#1e2a1e",
    accent: "#4ade80",
    text: "#e2e8f0",
    icon: "database",
    record: true,
  },
  "entity-package": {
    label: "Package entity",
    fill: "#2a1e33",
    accent: "#c084fc",
    text: "#e2e8f0",
    icon: "layers",
    record: true,
  },
  "entity-external": {
    label: "External entity",
    fill: "#2a2a2a",
    accent: "#94a3b8",
    text: "#e2e8f0",
    icon: "link",
  },
  view: {
    label: "View",
    fill: "#1e2a33",
    accent: "#22d3ee",
    text: "#e2e8f0",
    icon: "filter",
  },
  "record-type": {
    label: "Record type",
    fill: "#332a1e",
    accent: "#fbbf24",
    text: "#e2e8f0",
    icon: "pin",
  },
} as const satisfies NonNullable<DialectRegistry["nodeKinds"]>;

export type DataModelKind = keyof typeof DATAMODEL_KINDS;

/** Hand this to `ArchitectureStudio`'s `registry` prop. */
export const dataModelRegistry: DialectRegistry = { nodeKinds: DATAMODEL_KINDS };

/**
 * `curated.diagramType` / `entity.kind` → node kind. The hints are the
 * words a system uses for where an entity came from: `custom` (yours),
 * `standard` (the platform's own), `package` (an installed extension's),
 * `external` (a table that lives somewhere else).
 */
export function entityKind(diagramType: string | undefined, kind: string | undefined): DataModelKind {
  const hint = (diagramType ?? kind ?? "custom").toLowerCase();
  if (hint === "external") return "entity-external";
  if (hint === "standard") return "entity-standard";
  if (hint === "package") return "entity-package";
  return "entity";
}

/** The inverse, for writing `diagramType` back to an `entity.yaml`. */
export function diagramTypeOf(kind: string): string | undefined {
  switch (kind) {
    case "entity":
      return "custom";
    case "entity-standard":
      return "standard";
    case "entity-package":
      return "package";
    case "entity-external":
      return "external";
    case "record-type":
      return "record-type";
    default:
      return undefined;
  }
}
