/**
 * clipboard.ts — copy, paste, and duplicate over a selection.
 *
 * A cut-down template is what travels, not a bespoke format, so a copied
 * fragment pastes into another diagram, another tab, or a text editor — and
 * anything already able to read the schema can read a clipboard fragment too.
 */
import { validateTemplate, type DiagramTemplate, type ValidateOptions } from "./schema";

/** Marks a template as a clipboard fragment rather than a whole document. */
export const FRAGMENT_MARKER = "better-diagrams/fragment";

export interface Fragment extends DiagramTemplate {
  meta?: {
    [FRAGMENT_MARKER]?: true;
    /**
     * Zones copied as SUBJECTS (the zone itself was selected), as opposed to
     * riding along because a copied node references them. Paste always clones
     * a subject zone under a fresh id — duplicating a region must produce a
     * second region, never re-point at the original — while ride-along zones
     * keep the reuse-by-id behaviour.
     */
    zoneSubjects?: string[];
    [key: string]: unknown;
  };
}

/**
 * Extract the selected nodes, their descendants, and the edges wholly inside
 * that set.
 *
 * Descendants come along automatically: copying a group without its children
 * would paste an empty box, which is never what was meant. Edges with only one
 * end in the selection are dropped — the other end won't exist in the paste.
 *
 * `opts.zones` copies zones as SUBJECTS: the zone itself plus every node
 * whose `zoneId` is that zone (and their descendants and internal edges) —
 * "clone this whole region". Subject zones are recorded in the fragment's
 * meta so paste knows to clone them under fresh ids rather than reuse them.
 */
export function copyFragment(
  template: DiagramTemplate,
  selectedIds: readonly string[],
  opts: { zones?: readonly string[] } = {},
): Fragment {
  const zoneById = new Map((template.zones ?? []).map((z) => [z.id, z]));
  const subjects = (opts.zones ?? []).filter((id) => zoneById.has(id));
  const subjectSet = new Set(subjects);

  const selected = new Set(selectedIds);
  // A subject zone brings its members — before descendant growth, so a
  // member group's children come along too.
  for (const node of template.nodes) {
    if (node.zoneId && subjectSet.has(node.zoneId)) selected.add(node.id);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const node of template.nodes) {
      if (node.parentId && selected.has(node.parentId) && !selected.has(node.id)) {
        selected.add(node.id);
        grew = true;
      }
    }
  }

  const nodes = template.nodes.filter((n) => selected.has(n.id));
  const edges = template.edges.filter((e) => selected.has(e.source) && selected.has(e.target));

  // Carry the zones the fragment references, so pasting into an empty diagram
  // keeps the provider semantics rather than silently unzoning everything.
  const referenced = new Set(nodes.map((n) => n.zoneId).filter(Boolean) as string[]);
  for (const id of subjects) referenced.add(id);
  const zones = (template.zones ?? []).filter((z) => referenced.has(z.id));

  return {
    version: 1,
    meta: { [FRAGMENT_MARKER]: true, ...(subjects.length ? { zoneSubjects: subjects } : {}) },
    ...(zones.length ? { zones } : {}),
    nodes,
    edges,
  };
}

export interface PasteResult {
  template: DiagramTemplate;
  /** Ids of the pasted nodes, so the caller can select them. */
  newNodeIds: string[];
  /** Ids of zones the paste CREATED (subject clones and cross-diagram carries). */
  newZoneIds: string[];
  /** fragment id → pasted id, for every node, edge, and zone that came along. */
  idMap: Record<string, string>;
}

/**
 * Merge a fragment into a template under fresh ids.
 *
 * Every id is remapped — nodes, edges, zones — and the internal references
 * (`parentId`, `zoneId`, edge endpoints) are rewritten to match, so pasting
 * twice yields two independent copies rather than a second reference to the
 * first. A parent outside the fragment is dropped rather than dangling.
 */
export function pasteFragment(
  template: DiagramTemplate,
  fragment: DiagramTemplate,
  options: { offset?: number; makeId?: (prefix: string) => string } & ValidateOptions = {},
): PasteResult {
  const offset = options.offset ?? 28;
  let counter = 0;
  const makeId =
    options.makeId ?? ((prefix: string) => `${prefix}_copy${counter++ || ""}${Date.now().toString(36)}`);

  const existing = new Set([
    ...template.nodes.map((n) => n.id),
    ...template.edges.map((e) => e.id),
    ...(template.zones ?? []).map((z) => z.id),
  ]);

  const remap = new Map<string, string>();
  const fresh = (oldId: string, prefix: string) => {
    let id = makeId(prefix);
    while (existing.has(id)) id = makeId(prefix);
    existing.add(id);
    remap.set(oldId, id);
    return id;
  };

  // Reuse a zone that already exists by id — pasting into the same diagram
  // should land in the same zone, not clone it. SUBJECT zones are the
  // exception: the zone itself was what the user copied, so it always clones
  // under a fresh id (see copyFragment's `opts.zones`).
  const subjects = new Set((fragment as Fragment).meta?.zoneSubjects ?? []);
  const zoneIds = new Set((template.zones ?? []).map((z) => z.id));
  const newZones = (fragment.zones ?? []).filter((z) => subjects.has(z.id) || !zoneIds.has(z.id));
  for (const zone of fragment.zones ?? []) {
    if (!subjects.has(zone.id) && zoneIds.has(zone.id)) remap.set(zone.id, zone.id);
    else fresh(zone.id, zone.id);
  }

  for (const node of fragment.nodes) fresh(node.id, node.id);
  for (const edge of fragment.edges) fresh(edge.id, edge.id);

  const inFragment = new Set(fragment.nodes.map((n) => n.id));

  const nodes = fragment.nodes.map((node) => ({
    ...node,
    id: remap.get(node.id)!,
    // Keep the parent only if it came along; otherwise the copy becomes root.
    parentId: node.parentId && inFragment.has(node.parentId) ? remap.get(node.parentId)! : null,
    zoneId: node.zoneId ? (remap.get(node.zoneId) ?? null) : null,
    // Offset only the roots — a child is positioned relative to its parent,
    // which has already moved, so offsetting it too would double the shift.
    ...(node.parentId && inFragment.has(node.parentId)
      ? {}
      : { x: node.x + offset, y: node.y + offset }),
  }));

  const edges = fragment.edges.map((edge) => ({
    ...edge,
    id: remap.get(edge.id)!,
    source: remap.get(edge.source)!,
    target: remap.get(edge.target)!,
  }));

  const zones = [
    ...(template.zones ?? []),
    ...newZones.map((zone) => ({
      ...zone,
      id: remap.get(zone.id)!,
      x: zone.x + offset,
      y: zone.y + offset,
    })),
  ];

  return {
    template: validateTemplate(
      {
        ...template,
        ...(zones.length ? { zones } : {}),
        nodes: [...template.nodes, ...nodes],
        edges: [...template.edges, ...edges],
      },
      options,
    ),
    newNodeIds: nodes.map((n) => n.id),
    newZoneIds: newZones.map((z) => remap.get(z.id)!),
    idMap: Object.fromEntries(remap),
  };
}

/**
 * Duplicate a selection in place, carrying its connections.
 *
 * Two different intents, two behaviours:
 * - **Copy/paste** travels as a fragment and keeps only the edges wholly
 *   inside the selection — the other endpoint may not exist wherever the
 *   fragment lands.
 * - **Duplicate** (this) happens in the same document, so boundary edges are
 *   duplicated too: the selected endpoint moves to the clone, the outside
 *   endpoint stays on the original neighbour. Internal edges clone between
 *   the copies, exactly as paste does.
 */
export function duplicateWithConnections(
  template: DiagramTemplate,
  selectedIds: readonly string[],
  options: {
    offset?: number;
    makeId?: (prefix: string) => string;
    /** Zone ids to duplicate as subjects — the zone plus its members. */
    zones?: readonly string[];
  } & ValidateOptions = {},
): PasteResult {
  const fragment = copyFragment(template, selectedIds, { zones: options.zones });
  const copied = new Set(fragment.nodes.map((n) => n.id));

  // Boundary edges: exactly one endpoint in the copied set. Collected from
  // the ORIGINAL document — the fragment dropped them by design.
  const boundary = template.edges.filter(
    (e) => copied.has(e.source) !== copied.has(e.target),
  );

  const pasted = pasteFragment(template, fragment, options);

  const taken = new Set([
    ...pasted.template.nodes.map((n) => n.id),
    ...pasted.template.edges.map((e) => e.id),
  ]);
  let counter = 0;
  const freshEdgeId = (base: string) => {
    let id = `${base}_dup${Date.now().toString(36)}`;
    while (taken.has(id)) id = `${base}_dup${Date.now().toString(36)}${++counter}`;
    taken.add(id);
    return id;
  };

  const reattached = boundary.map((e) => ({
    ...e,
    id: freshEdgeId(e.id),
    source: pasted.idMap[e.source] ?? e.source,
    target: pasted.idMap[e.target] ?? e.target,
  }));

  return {
    ...pasted,
    template: validateTemplate(
      { ...pasted.template, edges: [...pasted.template.edges, ...reattached] },
      options,
    ),
  };
}

/** Parse clipboard text into a fragment, or null if it isn't one. */
export function parseFragment(text: string): DiagramTemplate | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.nodes)) return null;
    // Accept a whole template too — pasting an exported diagram into another
    // one is a reasonable thing to want.
    return validateTemplate(parsed);
  } catch {
    return null;
  }
}
