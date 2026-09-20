/**
 * relations.ts — what KIND of relationship a connection in a data model is,
 * and how each kind dresses its line.
 *
 * Every schema source has the same handful of relationship kinds under its
 * own names: a CRM's master-detail and lookup, SQL's cascading and plain
 * foreign keys, UML's composition and association. The vocabulary
 * here is the neutral one the editor draws with, the legend explains, and a
 * dialect maps its own terms onto — so the eye learns one set of lines, and
 * a diagram from any source can still say "this child belongs to that
 * parent". A host adds or relabels kinds through the registry, exactly
 * as it does node kinds.
 *
 * A kind DRESSES a line — style, colour, end glyphs, cardinality — rather
 * than being read at draw time: the importer or the inspector writes those
 * fields onto the edge alongside `relation`, so a document stays
 * self-contained, a hand-edited line keeps its edit, and every renderer
 * draws exactly what is stored. The kind itself is what the legend counts.
 */
import type { DiagramEdge, EdgeColor, EdgeHead, EdgeStyle } from "./schema";

export interface RelationKindDef {
  /** The legend row and the inspector option. */
  label: string;
  /** One line on what the kind means, for a tooltip. */
  description: string;
  style: EdgeStyle;
  color: EdgeColor;
  /** End glyphs — a composition's diamond at the owned end. */
  startHead?: EdgeHead;
  endHead?: EdgeHead;
  /** Default cardinality at each end, in the crow's-foot text the canvas parses. */
  startLabel?: string;
  endLabel?: string;
}

/**
 * The built-in kinds. Crow's-foot ER draws an identifying relationship
 * solid and a non-identifying one dashed; the line styles follow that, and
 * the colours keep the kinds apart at a glance — the owning kind loudest,
 * the ordinary reference in the neutral edge colour.
 *
 * The end glyphs are UML's: a filled diamond at the part for composition, a
 * hollow one for aggregation, a hollow triangle at the parent for
 * generalization. Under crow's-foot notation an end that states a
 * cardinality draws its symbol instead of the glyph, so the diamonds show
 * in the legend and under UML notation; the triangle, whose ends carry no
 * cardinality, shows everywhere.
 */
export const RELATION_KINDS: Record<string, RelationKindDef> = {
  composition: {
    label: "Composition",
    description: "Owned: the child can't exist without its parent, and goes with it",
    style: "solid",
    color: "rose",
    startHead: "diamond-filled",
    startLabel: "*",
    endLabel: "1",
  },
  aggregation: {
    label: "Aggregation",
    description: "Shared: the part belongs to a whole for now, but outlives it",
    style: "solid",
    color: "sky",
    startHead: "diamond",
    startLabel: "*",
    endLabel: "0..1",
  },
  reference: {
    label: "Reference",
    description: "Points at another table; either side can exist alone",
    style: "dashed",
    color: "slate",
    startLabel: "*",
    endLabel: "0..1",
  },
  hierarchy: {
    label: "Hierarchy",
    description: "Points at a row of its own table — a parent of the same kind",
    style: "dashed",
    color: "violet",
    startLabel: "*",
    endLabel: "0..1",
  },
  polymorphic: {
    label: "Polymorphic",
    description: "Points at one of several tables, decided per row",
    style: "dotted",
    color: "amber",
    startLabel: "*",
    endLabel: "0..1",
  },
  generalization: {
    label: "Generalization",
    description: "Is a kind of: a subtype or record type that extends the table it points at",
    style: "solid",
    color: "emerald",
    endHead: "triangle",
  },
};

/** The order a legend and a picker list the built-ins in. */
export const RELATION_KIND_ORDER: readonly string[] = [
  "composition",
  "aggregation",
  "reference",
  "hierarchy",
  "polymorphic",
  "generalization",
];

/** What an unregistered kind draws as: the plain reference line, named after its id. */
export const FALLBACK_RELATION: RelationKindDef = {
  label: "Relationship",
  description: "",
  style: "dashed",
  color: "slate",
};

/** The edge fields a kind dresses a line with, ready to spread onto the edge. */
export function relationDressing(
  def: RelationKindDef,
): Pick<DiagramEdge, "style" | "color" | "startHead" | "endHead" | "startLabel" | "endLabel"> {
  return {
    style: def.style,
    color: def.color,
    ...(def.startHead ? { startHead: def.startHead } : {}),
    ...(def.endHead ? { endHead: def.endHead } : {}),
    ...(def.startLabel ? { startLabel: def.startLabel } : {}),
    ...(def.endLabel ? { endLabel: def.endLabel } : {}),
  };
}

/**
 * Resolve a registry's relation kinds over the built-ins: a partial value
 * merges over the built-in of the same key, an unknown key becomes a new
 * kind over the fallback, `null` removes one. The react registry and a
 * dialect's registry both go through this, so a host and a dialect relabel
 * the same way.
 */
export function resolveRelationKinds(
  extensions: Record<string, (Partial<RelationKindDef> & { label?: string }) | null> | undefined,
): { kinds: Record<string, RelationKindDef>; order: string[] } {
  const kinds: Record<string, RelationKindDef> = { ...RELATION_KINDS };
  for (const [key, value] of Object.entries(extensions ?? {})) {
    if (value === null) {
      delete kinds[key];
      continue;
    }
    const base = kinds[key];
    kinds[key] = base
      ? { ...base, ...value }
      : { ...FALLBACK_RELATION, label: value.label ?? titleCase(key), ...value };
  }
  const order = [
    ...RELATION_KIND_ORDER.filter((k) => k in kinds),
    ...Object.keys(kinds).filter((k) => !RELATION_KIND_ORDER.includes(k)),
  ];
  return { kinds, order };
}

/** "master-detail" → "Master Detail". Ids are slugs; names are not. */
function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
