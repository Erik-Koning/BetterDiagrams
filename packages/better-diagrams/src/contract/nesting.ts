/**
 * nesting.ts — moving a container's contents between C4 levels.
 *
 * A `group` draws its children inside its frame, on this level. Any other
 * kind's children are its next C4 level: hidden inline, shown only when you
 * drill in. Those are the same relationship rendered two ways, and the ONLY
 * thing that decides which is the parent's kind (see `cardParentIds` in
 * schema.ts). So the transform between them is a kind change plus geometry —
 * and, crucially, NOTHING ELSE:
 *
 *   - no edge is rewritten. Cross-level connections are derived, never
 *     stored: `toReactFlow` re-anchors an edge onto the nearest visible
 *     ancestor and `scopedView` projects it back onto the level below. Both
 *     read the live parent chain, so both follow this transform for free.
 *   - no child moves when nesting. A group's children are already stored
 *     relative to its top-left, which is exactly what a drilled canvas means
 *     by its coordinates.
 *
 * That is what makes the pair lossless: nest then inline returns a document
 * that differs from the original only in the geometry the frame lost.
 */
import {
  CONTAINER_KINDS,
  KIND_DEFAULT_SIZE,
  NODE_MIN_SIZE,
  type DiagramTemplate,
  type IconName,
  type NodeKind,
} from "./schema";

/**
 * The inset a frame gives its children: room on three sides, and enough on top
 * to clear the name chip. The same numbers the generated prompt asks an LLM
 * for, so hand-authored and transformed documents look alike.
 */
const FRAME_PAD = 24;
const FRAME_HEADER = 48;

export interface NestOptions {
  /** What the frame becomes. Default "service" — C4's "container". */
  kind?: string;
  /** The kind's glyph. The registry owns icons, so the caller resolves it. */
  icon?: string;
  /** Registry container kinds; defaults to the built-in `["group"]`. */
  containerKinds?: readonly string[];
}

export interface InlineOptions {
  /** Which container kind to become. Default "group". */
  kind?: string;
  containerKinds?: readonly string[];
}

/**
 * Push a container's contents one level deeper: the frame becomes an ordinary
 * card, and everything inside it becomes that card's drill-in detail.
 *
 * Unknown id throws, as `scopedView` does — a caller naming a node that isn't
 * there has a bug, not a no-op. A node that is not a container, or holds
 * nothing, returns the document unchanged: the action is offered on exactly
 * the nodes it means something for, and this is the belt.
 */
export function nestContents(
  t: DiagramTemplate,
  containerId: string,
  opts: NestOptions = {},
): DiagramTemplate {
  const target = t.nodes.find((n) => n.id === containerId);
  if (!target) throw new Error(`nestContents: unknown node id "${containerId}"`);

  const containers = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  if (!containers.has(target.kind as string)) return t;
  if (!t.nodes.some((n) => n.parentId === containerId)) return t;

  const kind = opts.kind ?? "service";
  const size = KIND_DEFAULT_SIZE[kind] ?? KIND_DEFAULT_SIZE.default;

  return {
    ...t,
    nodes: t.nodes.map((node) => {
      if (node.id !== containerId) return node;
      const card = {
        ...node,
        kind: kind as NodeKind,
        ...(opts.icon ? { icon: opts.icon as IconName } : {}),
        // Centred on the frame it replaces: the card lands where the reader
        // was already looking, rather than in the frame's top-left corner.
        x: Math.round(node.x + (node.w - size.w) / 2),
        y: Math.round(node.y + (node.h - size.h) / 2),
        w: size.w,
        h: size.h,
      };
      // Frame vocabulary a card cannot render: the four styling knobs, and a
      // collapse flag that now means nothing (validation strips it too).
      delete card.fill;
      delete card.outline;
      delete card.color;
      delete card.opacity;
      delete card.collapsed;
      return card;
    }),
  };
}

/**
 * The inverse: a card's drill-in detail comes back onto this level, inside a
 * frame. Children are shifted clear of the frame's inset and the frame is
 * sized around them, so the result looks like a group somebody drew rather
 * than one that grew around wherever the contents happened to sit.
 */
export function inlineContents(
  t: DiagramTemplate,
  nodeId: string,
  opts: InlineOptions = {},
): DiagramTemplate {
  const target = t.nodes.find((n) => n.id === nodeId);
  if (!target) throw new Error(`inlineContents: unknown node id "${nodeId}"`);

  const containers = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  if (containers.has(target.kind as string)) return t;

  const children = t.nodes.filter((n) => n.parentId === nodeId);
  if (!children.length) return t;

  // Children are stored relative to their parent either way, so the shift is
  // the whole coordinate story — grandchildren ride their own parent.
  const dx = FRAME_PAD - Math.min(...children.map((c) => c.x));
  const dy = FRAME_HEADER - Math.min(...children.map((c) => c.y));
  const w = Math.max(
    NODE_MIN_SIZE.group.w,
    Math.max(...children.map((c) => c.x + dx + c.w)) + FRAME_PAD,
  );
  const h = Math.max(
    NODE_MIN_SIZE.group.h,
    Math.max(...children.map((c) => c.y + dy + c.h)) + FRAME_PAD,
  );
  const kind = opts.kind ?? "group";

  return {
    ...t,
    nodes: t.nodes.map((node) => {
      if (node.id === nodeId) {
        return {
          ...node,
          kind: kind as NodeKind,
          icon: "none" as IconName,
          // Unfold around the card rather than growing off its corner.
          x: Math.round(node.x + (node.w - w) / 2),
          y: Math.round(node.y + (node.h - h) / 2),
          w,
          h,
        };
      }
      if (node.parentId === nodeId) return { ...node, x: node.x + dx, y: node.y + dy };
      return node;
    }),
  };
}
