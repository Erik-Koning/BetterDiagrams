/**
 * junctions.ts — many-to-many, as a data model spells it and as UML draws it.
 *
 * A database has no many-to-many line: it has a JUNCTION TABLE whose primary
 * key is two foreign keys, one to each side (`order_items` between orders
 * and products). UML draws the same fact as one association with `*` at
 * both ends, and the junction's own name on the line. Both are true; the
 * junction reads better when the reader wants the storage and the single
 * line when they want the meaning. This module finds the one and makes the
 * other.
 *
 * What counts as a junction, strictly — a false positive would fold a real
 * table away:
 *   - a node with rows, exactly two of which are `pfk` (part of the key AND
 *     a reference), and no other key-role row;
 *   - each `pfk` row anchors an outgoing line (`startField` names the row,
 *     or, when neither line names a row, the node's two outgoing lines are
 *     taken in row order);
 *   - nothing points AT the junction, and it contains nothing: a table other
 *     rows reference is a table in its own right.
 * Extra non-key rows (a quantity, a role) do not disqualify it — UML calls
 * that an association class, and the rows travel on the collapsed line.
 */
import type { DiagramEdge, DiagramTemplate, NodeField } from "./schema";
import { RELATION_KINDS, relationDressing } from "./relations";

export interface JunctionTable {
  /** The junction node. */
  id: string;
  label: string;
  /** The two lines it carries, in row order — each leaves the junction for one side. */
  edges: [DiagramEdge, DiagramEdge];
  /** The rows that are not part of the key — what an association class would carry. */
  attributes: NodeField[];
}

/** Every junction table in the document, in node order. */
export function junctionTables(template: DiagramTemplate): JunctionTable[] {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, DiagramEdge[]>();
  for (const e of template.edges) {
    if (e.source === e.target) continue;
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e);
  }
  const parents = new Set(template.nodes.map((n) => n.parentId).filter(Boolean));

  const out: JunctionTable[] = [];
  for (const node of template.nodes) {
    const rows = node.fields ?? [];
    if (!rows.length || parents.has(node.id) || (incoming.get(node.id) ?? 0) > 0) continue;
    const keyRows = rows.filter((f) => f.key);
    const joins = keyRows.filter((f) => f.key === "pfk");
    if (joins.length !== 2 || keyRows.length !== 2) continue;

    const lines = outgoing.get(node.id) ?? [];
    const claimed = new Set<string>();
    const lineFor = (row: NodeField): DiagramEdge | undefined => {
      const named = lines.find((e) => e.startField === row.id && !claimed.has(e.id));
      if (named) return named;
      // Neither line names a row: two lines, two rows, in order.
      if (lines.every((e) => !e.startField) && lines.length === 2) {
        return lines.find((e) => !claimed.has(e.id));
      }
      return undefined;
    };
    const a = lineFor(joins[0]!);
    if (a) claimed.add(a.id);
    const b = lineFor(joins[1]!);
    if (!a || !b || a.id === b.id) continue;

    out.push({
      id: node.id,
      label: node.label,
      edges: [a, b],
      attributes: rows.filter((f) => !f.key),
    });
  }
  return out;
}

/**
 * Replace each junction with the one line it stands for: `*` to `*` between
 * the two sides, named after the junction, landing on the same rows the two
 * foreign keys landed on. The junction node and both its lines go; nothing
 * else in the document moves. Given `ids`, only those junctions collapse.
 *
 * The line is a plain reference — dashed, in the neutral colour — with the
 * cardinality overridden to many on both ends, and it remembers the table it
 * replaced in `data.junction` so a host can tell it from a hand-drawn one.
 */
export function collapseJunctions(
  template: DiagramTemplate,
  ids?: readonly string[],
): DiagramTemplate {
  const wanted = ids ? new Set(ids) : null;
  const junctions = junctionTables(template).filter((j) => !wanted || wanted.has(j.id));
  if (!junctions.length) return template;

  const dropNodes = new Set(junctions.map((j) => j.id));
  const dropEdges = new Set(junctions.flatMap((j) => j.edges.map((e) => e.id)));
  const reference = relationDressing(RELATION_KINDS.reference!);

  const added: DiagramEdge[] = junctions.map((j) => {
    const [a, b] = j.edges;
    return {
      id: `${j.id}::junction`,
      source: a.target,
      target: b.target,
      label: j.label,
      relation: "reference",
      ...reference,
      direction: "none",
      startLabel: "*",
      endLabel: "*",
      ...(a.endField ? { startField: a.endField } : {}),
      ...(b.endField ? { endField: b.endField } : {}),
      data: {
        junction: {
          id: j.id,
          ...(j.attributes.length ? { attributes: j.attributes.map((f) => f.name) } : {}),
        },
      },
    };
  });

  return {
    ...template,
    nodes: template.nodes.filter((n) => !dropNodes.has(n.id)),
    edges: [...template.edges.filter((e) => !dropEdges.has(e.id)), ...added],
    // A path that walked through a junction now has a hole in it; drop the
    // step rather than leave a dangling id for validation to strip.
    ...(template.paths
      ? {
          paths: template.paths.map((p) => ({
            ...p,
            steps: p.steps.filter((s) => !dropNodes.has(s) && !dropEdges.has(s)),
          })),
        }
      : {}),
  };
}
