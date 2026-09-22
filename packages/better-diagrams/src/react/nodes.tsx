/**
 * nodes.tsx — the three custom React Flow node renderers.
 *
 *   shape      → a boxed service/database/queue/... node
 *   group      → a resizable container other nodes nest into
 *   annotation → free text with no chrome
 *
 * Which renderer a kind uses is decided by the registry (`container` /
 * `annotation` flags), not by a hard-coded list — see `toReactFlow`.
 */
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { CSSProperties, SyntheticEvent } from "react";
import { fieldKey } from "../contract/fields";
import { SvgIcon } from "./icons";
import { useStudio } from "./context";
import { DateChip } from "./chrome";
import { isOverdue } from "../contract/timeline";
import { kindDef, iconPaths } from "./registry-types";
import { ZoneNode } from "./ZoneNode";
import { silhouettePath, teamColor } from "./shapes";
import { groupContentBox, shapeMinHeight } from "./resize";
import {
  DEFAULT_CONTAINER_OPACITY,
  DEFAULT_FONT_SIZE,
  NODE_MIN_SIZE,
  ghostSourceId,
  isBoundaryNodeId,
  isGhostNodeId,
  type DiagramNodeData,
  type NodeField,
} from "../contract/schema";

/** Breathing room kept between a frame's edge and the last thing inside it. */

/** The icon glyph's pixel size per presentation mode; the chip around it is CSS. */
export const ICON_SIZE = { technical: 17, marketing: 22 } as const;

export type ShapeNodeType = Node<DiagramNodeData, "shape">;
export type GroupNodeType = Node<DiagramNodeData, "group">;
export type AnnotationNodeType = Node<DiagramNodeData, "annotation">;

/**
 * Four handles per node, all declared as sources. The editor runs React Flow
 * in `ConnectionMode.Loose`, which lets a source handle also accept an incoming
 * connection — so a drag from any side to any side works without doubling the
 * handle count, and without the user having to aim at a specific dot.
 */
const HANDLE_POSITIONS: Array<[string, Position]> = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
];

/**
 * `hidden` makes the handles inert, NOT absent.
 *
 * Unmounting them looks like the obvious way to hide a connect affordance, and
 * it silently removes every edge from the diagram: React Flow positions an
 * edge from its endpoints' measured handle bounds, and a node with no handles
 * has none, so `EdgeWrapper` renders nothing at all. A read-only or scrubbed
 * diagram would draw its boxes and none of its connections.
 *
 * Keeping them mounted, un-connectable, and painted-out costs four empty divs
 * per node and keeps the bounds React Flow needs.
 */
export function ConnectHandles({ hidden }: { hidden: boolean }) {
  return (
    <>
      {HANDLE_POSITIONS.map(([id, position]) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={position}
          isConnectable={!hidden}
          className={hidden ? "as-handle--inert" : undefined}
        />
      ))}
    </>
  );
}

// ─── Shape ───────────────────────────────────────────────────────────────────

/**
 * A node's rows — a table's columns, a class's properties.
 *
 * The rendered row height must stay equal to the contract's `FIELD_ROW_H`
 * (styles.css pins it, with the same warning). That constant is what a
 * field-anchored edge and the PNG exporter both compute a row's position from,
 * so a row that renders taller here would leave foreign-key lines pointing
 * between columns on screen while landing correctly in the export.
 */
/** Whether any mark is a whole table's — the sign a reference is being shown. */
function marksTables(marks: ReadonlySet<string>): boolean {
  for (const key of marks) if (key.endsWith("\u0000")) return true;
  return false;
}

/** Whether the card, or any row on it, carries a mark. */
function nodeMarked(marks: ReadonlySet<string>, nodeId: string): boolean {
  const prefix = `${nodeId}\u0000`;
  for (const key of marks) if (key.startsWith(prefix)) return true;
  return false;
}

function FieldList({ nodeId, fields }: { nodeId: string; fields: readonly NodeField[] }) {
  const { onFieldClick, pinnedFields, highlightFields } = useStudio();
  // Rows are inert unless the editor offers a field menu. When it does, a
  // row owns its own press: `nodrag` keeps React Flow and the marquee off it
  // (see marquee.ts PASSTHROUGH), the stops keep the wrapper's click-select
  // and double-click-drill from firing on top. The row stays an <li> — one
  // <button> per row would be a tab stop per field, and a nested box a risk
  // to the 19px the anchors and the PNG export are computed from.
  const interactive = !!onFieldClick;
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  return (
    <ul className="as-node__fields">
      {fields.map((field) => {
        const key = fieldKey({ nodeId, fieldId: field.id });
        const className = [
          "as-node__field",
          interactive ? "nodrag" : "",
          pinnedFields.has(key) ? "as-node__field--pinned" : "",
          highlightFields.has(key) ? "as-node__field--match" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
        <li
          key={field.id}
          className={className}
          data-field-id={field.id}
          role={interactive ? "button" : undefined}
          aria-label={interactive ? `${field.name} — field actions` : undefined}
          onPointerDown={interactive ? stop : undefined}
          onDoubleClick={interactive ? stop : undefined}
          onClick={
            interactive
              ? (event) => {
                  event.stopPropagation();
                  onFieldClick({ nodeId, fieldId: field.id }, { clientX: event.clientX, clientY: event.clientY });
                }
              : undefined
          }
          onContextMenu={
            interactive
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onFieldClick({ nodeId, fieldId: field.id }, { clientX: event.clientX, clientY: event.clientY });
                }
              : undefined
          }
        >
          {field.key ? (
            <span className={`as-node__fieldkey as-node__fieldkey--${field.key}`}>{field.key}</span>
          ) : null}
          <span
            className="as-node__fieldname"
            title={field.derived ? `${field.name} — derived: computed, not stored` : field.name}
          >
            {/* UML's leading slash for a derived attribute. */}
            {field.derived ? (
              <span className="as-node__fieldderived" aria-hidden="true">
                /
              </span>
            ) : null}
            {field.name}
            {field.required ? (
              <span className="as-node__fieldreq" title="Required">
                *
              </span>
            ) : null}
          </span>
          {field.unique ? (
            <span className="as-node__fieldflag" title="Unique">
              UQ
            </span>
          ) : null}
          {field.type ? (
            <span className="as-node__fieldtype" title={field.type}>
              {field.type}
            </span>
          ) : null}
        </li>
        );
      })}
    </ul>
  );
}

/**
 * A name, renameable in place where double-click has nothing better to do.
 *
 * Double-click is this editor's DRILL gesture, and that is worth keeping: a
 * box with internals opens them. But a box with NO internals answered the
 * universal rename gesture by zooming to 250% and showing an empty level —
 * so on those, and only those, the name takes the double-click. (F2 renames
 * whatever is selected, wherever it is; see the keyboard handler.)
 *
 * Enter commits, Escape abandons, blur commits — the same contract as the
 * annotation editor and the edge label, so the behaviour is learned once.
 */
export function InlineName({
  id,
  value,
  className,
  onCommit,
  title,
}: {
  id: string;
  value: string;
  className: string;
  onCommit: (next: string) => void;
  title?: string;
}) {
  const { renamingId, setRenamingId } = useStudio();
  const editing = renamingId === id;
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(value);
    inputRef.current?.focus();
    inputRef.current?.select();
    // `value` is deliberately not a dependency: re-seeding the draft on every
    // keystroke would fight the field it is meant to fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (!editing) {
    return (
      <div className={className} title={title ?? value}>
        {value}
      </div>
    );
  }

  const commit = () => {
    setRenamingId(null);
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
  };

  return (
    <input
      ref={inputRef}
      className={`${className} as-inline-name nodrag`}
      value={draft}
      aria-label="Name"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setRenamingId(null);
        event.stopPropagation();
      }}
    />
  );
}

/**
 * The accent a node draws with: the node's own colour if it has one, else the
 * kind's, resolved THROUGH a theme token.
 *
 * The registry's hex stays the fallback — it is what `draw.ts`, the minimap
 * and the inspector's colour input read directly, none of which can resolve a
 * CSS variable. Going through the token is what lets a light theme retune
 * every kind: the registry hues were picked for the dark canvas and sit around
 * 2:1 on a white card. Same shape `SequenceNodes` already uses for `--as-seq-*`.
 */
function nodeAccent(data: { color?: string; kind: string }, fallback: string): string {
  return data.color || `var(--as-node-${data.kind}, ${fallback})`;
}

export const ShapeNode = memo(function ShapeNode({
  id,
  data,
  selected,
  width,
  height,
}: NodeProps<ShapeNodeType>) {
  const { registry, readOnly, mode, tagFilter, showTeams, showLinks, requestCommit, navigateFile, drillInto, navigateToNode, childCounts, dimmedIds, pinnedFields, highlightFields } = useStudio();
  const { updateNodeData } = useReactFlow();
  const def = kindDef(registry, data.kind);
  const paths = iconPaths(registry, data.icon);
  const shape = def.shape ?? "card";
  // Marketing mode draws a bigger glyph in a bigger chip. The size is a
  // pixel attribute on the SVG, so it cannot come from the stylesheet the way
  // the chip's does.
  const iconSize = mode === "marketing" ? ICON_SIZE.marketing : ICON_SIZE.technical;
  // A silhouette's gradient has to be an SVG <linearGradient>, referenced by
  // id — CSS gradients don't paint SVG fills. One per MOUNTED node, from
  // useId rather than the document id: the compare overlay renders a
  // document id twice, a ghost's id carries a colon, and an author's id can
  // hold anything — none of which a `url(#…)` reference should have to
  // survive. Stripped to the characters an id fragment never needs escaping.
  const gradientId = `as-grad-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  // A scoped view's ghost stands in for an element on another level: it
  // renders dimmed-and-dashed, and its double-click visits the real thing.
  const scopeGhost = isGhostNodeId(id);
  const childCount = scopeGhost ? 0 : (childCounts.get(id) ?? 0);
  const onDoubleClick = scopeGhost
    ? () => navigateToNode(ghostSourceId(id))
    : childCount > 0 || !readOnly
      ? () => drillInto(id)
      : undefined;

  const w = width ?? 170;
  const h = height ?? 76;

  // The same measurement `validateTemplate` uses, so the canvas and the
  // document can never disagree about how tall this box has to be — and the
  // same floor a multi-selection resize holds this box to (see resize.ts).
  const minHeight = shapeMinHeight(data, w);
  // Absolute-coordinate silhouette in a 1:1 viewBox — no stretch, so the
  // person's head and the pipe's ends stay circular at any aspect ratio.
  const sil = shape !== "card" ? silhouettePath(shape, 0.75, 0.75, w - 1.5, h - 1.5) : null;

  // The document node this card stands for — a ghost's rows and its place
  // in a reachable set belong to the real thing.
  const docId = scopeGhost ? ghostSourceId(id) : id;
  // Tag filter and the path panel's reachable set: dim, never hide. Purely
  // presentational, so neither can interact with the visibility machinery
  // that decides what persists.
  const dimmed =
    (tagFilter.length > 0 && !data.tags?.some((tag) => tagFilter.includes(tag))) ||
    (dimmedIds !== null && !dimmedIds.has(docId));

  const style = {
    // A colour stored on the node wins over the kind's registry accent: it is
    // the one thing someone writing `"color": "#ff0000"` on a service could
    // possibly mean, and until now it was accepted by the types, allowed by
    // the key lint, and then silently dropped.
    "--as-node-accent": nodeAccent(data, def.accent),
    // The title carries the node's own size; the eyebrow, description and
    // rows keep their fixed scale so a resized label doesn't drag the whole
    // card's typography with it.
    ...(data.fontSize && data.fontSize !== DEFAULT_FONT_SIZE
      ? { "--as-node-font": `${data.fontSize}px` }
      : {}),
    ...(sil
      ? { paddingTop: 6 + sil.contentTop, paddingInline: 12 + sil.contentInlinePad }
      : {}),
  } as CSSProperties;

  const className = [
    "as-node",
    shape !== "card" ? `as-node--shaped as-node--${shape}` : "",
    data.fields?.length ? "as-node--record" : "",
    selected ? "as-node--selected" : "",
    data.ghost || scopeGhost ? "as-ghost" : "",
    scopeGhost ? "as-node--scope-ghost" : "",
    dimmed ? "as-node--dimmed" : "",
    pinnedFields.has(fieldKey({ nodeId: docId })) ? "as-node--pinned" : "",
    highlightFields.has(fieldKey({ nodeId: docId })) ? "as-node--match" : "",
    // A shown reference marks TABLES (keys ending in an empty field). While
    // one is up, every card it did not touch steps back, so the marked ones
    // read as the picture rather than as a few bars in a crowd. A followed
    // reference or a search hit marks rows only and fades nothing.
    marksTables(highlightFields) && !nodeMarked(highlightFields, docId) ? "as-node--unmarked" : "",
    data.status ? `as-node--status-${data.status}` : "",
    // Text layout. Absent data means the pre-existing look, so no class.
    data.textAlign ? `as-node--align-${data.textAlign}` : "",
    data.textVAlign ? `as-node--valign-${data.textVAlign}` : "",
    data.wrap ? "as-node--wrap" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <NodeResizer
        isVisible={!!selected && !readOnly && !data.locked && !scopeGhost}
        minWidth={NODE_MIN_SIZE.shape.w}
        // Rows and a wrapped title are CONTENT: `validateTemplate` grows the
        // stored height to hold them, so a box dragged shorter than they need
        // spilled its text out of the card AND saved a height the canvas was
        // not showing — the file then reloaded taller than the screen. The
        // floor is whatever the content actually needs.
        minHeight={minHeight}
        lineClassName="as-resize-line"
        onResizeEnd={requestCommit}
      />
      <ConnectHandles hidden={readOnly} />
      <div
        className={className}
        style={style}
        onDoubleClick={onDoubleClick}
        title={
          scopeGhost
            ? "External to this view — double-click to visit"
            : data.ghost
              ? `Hidden by the current provider selection — visible on ${data.providers?.join(", ")}`
              : undefined
        }
      >
        {sil ? (
          <svg className="as-node__silhouette" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            {/* The marketing gradient, as stops the stylesheet colours
                (`stop-color` is a presentation property, so the same
                `--as-node-accent` mix the card gradient uses applies here).
                The path that references it is display:none in technical
                mode, so the def is inert there. */}
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <stop className="as-node__gradstop as-node__gradstop--from" offset="0" />
                <stop className="as-node__gradstop as-node__gradstop--to" offset="1" />
              </linearGradient>
            </defs>
            {/* The path glow, traced along the outline: a box-shaped halo
                around a person or a cylinder would light up the empty
                corners. Hidden unless the wrapper says the node is lit. */}
            <path className="as-node__silhouette-glow" d={sil.body} />
            <path className="as-node__silhouette-base" d={sil.body} />
            <path className="as-node__silhouette-grad" d={sil.body} fill={`url(#${gradientId})`} />
            <path className="as-node__silhouette-tint" d={sil.body} />
            {sil.detail ? <path className="as-node__silhouette-detail" d={sil.detail} /> : null}
          </svg>
        ) : null}
        {paths ? (
          <span className="as-node__iconbox" aria-hidden="true">
            <SvgIcon paths={paths} size={iconSize} color={nodeAccent(data, def.accent)} />
          </span>
        ) : null}
        <div className="as-node__body">
          <div className="as-node__kind">
            {/* The kind's name in its own span so marketing mode can tuck it
                away (the icon already says it) while the status and the
                drill badge beside it stay. */}
            <span className="as-node__kindname">{def.label}</span>
            {data.status ? (
              <span className="as-node__status">
                <span className="as-node__statussep"> · </span>
                {data.status}
              </span>
            ) : null}
            {childCount > 0 ? (
              <button
                type="button"
                className="as-node__drill nodrag"
                title={`${childCount} inside — open this level`}
                aria-label={`Open ${data.label} — ${childCount} inside`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  drillInto(id);
                }}
              >
                ⊞ {childCount}
              </button>
            ) : null}
          </div>
          <InlineName
            id={id}
            className="as-node__title"
            value={data.label}
            title={data.label}
            onCommit={(label) => {
              updateNodeData(id, { label });
              requestCommit();
            }}
          />
          {data.description ? <div className="as-node__desc">{data.description}</div> : null}
          {data.fields?.length ? <FieldList nodeId={docId} fields={data.fields} /> : null}
          <DateChip date={data.date} prefix="Lands" overdue={isOverdue(data.date, data.status)} />
        </div>
        {!showLinks ? null : data.url?.startsWith("file:") ? (
          navigateFile ? (
            <button
              type="button"
              className="as-node__link nodrag"
              title={`Open linked file: ${data.url.slice(5)}`}
              aria-label={`Open linked file ${data.url.slice(5)}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                navigateFile(data.url!.slice(5));
              }}
            >
              ↗
            </button>
          ) : null
        ) : data.url ? (
          <a
            className="as-node__link nodrag"
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            title={data.url}
            aria-label={`Open ${data.url}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            ↗
          </a>
        ) : null}
        {data.locked ? (
          <span className="as-node__lock" title="Locked" aria-label="Locked">
            🔒
          </span>
        ) : null}
        {data.ghost ? <span className="as-ghost__badge">{data.providers?.join(" · ")}</span> : null}
        {data.team && showTeams ? (
          <span
            className="as-node__team"
            style={{ "--as-team-color": teamColor(data.team) } as CSSProperties}
            title={`Owned by ${data.team}`}
          >
            {data.team}
          </span>
        ) : null}
      </div>
    </>
  );
});

// ─── Group ───────────────────────────────────────────────────────────────────

export const GroupNode = memo(function GroupNode({ id, data, selected }: NodeProps<GroupNodeType>) {
  const { registry, readOnly, showTeams, requestCommit, focus, drillInto, navigateToNode, childCounts, dimmedIds } = useStudio();
  const { updateNodeData, getNodes, setNodes } = useReactFlow();
  const def = kindDef(registry, data.kind);

  /**
   * Dragging the TOP or LEFT handle moves the frame's origin, and a child's
   * stored position is relative to that origin — so every child slid across
   * the canvas while the user believed they were only moving an edge of the
   * box. Counter-move them by the same delta, each frame, so the frame grows
   * around its contents instead of dragging them along.
   */
  const resizeOrigin = useRef<{ x: number; y: number } | null>(null);
  const holdChildrenStill = useCallback(
    (_event: unknown, params: { x: number; y: number }) => {
      const from = resizeOrigin.current;
      if (!from) return;
      const dx = params.x - from.x;
      const dy = params.y - from.y;
      resizeOrigin.current = { x: params.x, y: params.y };
      if (!dx && !dy) return;
      setNodes((current) =>
        current.map((n) =>
          n.parentId === id
            ? { ...n, position: { x: n.position.x - dx, y: n.position.y - dy } }
            : n,
        ),
      );
    },
    [id, setNodes],
  );

  /** How much room the children need, in the frame's own coordinates. */
  const contentBox = groupContentBox(id, getNodes());

  // In a scoped view every group child renders as a chip BY FORCE — expanding
  // one there would write the chip's 180×44 over the stored size. The toggle
  // disappears while drilled in; double-click drills instead.
  const scopeGhost = isGhostNodeId(id);
  const isBoundary = isBoundaryNodeId(id);
  const inScopedView = focus !== null;
  const childCount = scopeGhost || isBoundary ? 0 : (childCounts.get(id) ?? 0);
  const onDoubleClick = isBoundary
    ? undefined
    : scopeGhost
      ? () => navigateToNode(ghostSourceId(id))
      : () => drillInto(id);
  const drillBadge =
    childCount > 0 ? (
      <button
        type="button"
        className="as-node__drill nodrag"
        title={`${childCount} inside — open this level`}
        aria-label={`Open ${data.label} — ${childCount} inside`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          drillInto(id);
        }}
      >
        ⊞ {childCount}
      </button>
    ) : null;

  // Frame styling, resolved exactly as a zone's is: the stored colour is the
  // INK (what a human reads as the boundary), and the fill is derived from it
  // as a tint at `opacity`, so light and dark mode each get a sensible wash
  // from one stored value. `fill: false` + `outline: "none"` is the fully
  // transparent grouping frame.
  const ink = data.color || def.accent;
  // Untinted groups keep the neutral surface wash they have always had — the
  // ink-derived tint kicks in only once a colour or an opacity is actually
  // stored, so every pre-existing diagram renders pixel-identical.
  const tinted = !!data.color || data.opacity !== undefined;
  const fill =
    data.fill === false
      ? "transparent"
      : tinted
        ? `color-mix(in srgb, ${ink} ${Math.round((data.opacity ?? DEFAULT_CONTAINER_OPACITY) * 100)}%, transparent)`
        : "color-mix(in srgb, var(--as-surface-2) 28%, transparent)";
  const style = {
    "--as-node-accent": nodeAccent(data, def.accent),
    "--as-group-ink": ink,
    "--as-group-fill": fill,
    "--as-group-outline": data.outline ?? "dashed",
    "--as-group-border-width": data.outline === "none" ? "0" : "1px",
  } as CSSProperties;
  const teamBadge =
    data.team && showTeams ? (
      <span
        className="as-node__team as-node__team--inline"
        style={{ "--as-team-color": teamColor(data.team) } as CSSProperties}
        title={`Owned by ${data.team}`}
      >
        {data.team}
      </span>
    ) : null;

  // Flipping `collapsed` changes which nodes exist on the canvas, so it flows
  // through the same materialization path as a provider switch: this data
  // change reaches the derived template, the view signature changes, and the
  // canvas rebuilds (hiding/revealing children, re-routing their edges). It
  // lands in the undo stack like any other document change.
  const toggle = (
    <button
      type="button"
      className="as-group__collapse nodrag"
      onClick={(event) => {
        event.stopPropagation();
        updateNodeData(id, { collapsed: !data.collapsed });
      }}
      title={data.collapsed ? "Expand — restores the saved size and layout" : "Collapse to a chip"}
      aria-label={data.collapsed ? `Expand ${data.label}` : `Collapse ${data.label}`}
      aria-expanded={!data.collapsed}
    >
      {data.collapsed ? "▸" : "▾"}
    </button>
  );

  if (data.collapsed || data.folded) {
    // The chip: a solid mini-card standing in for the whole group. Edges from
    // the hidden contents attach here (see toReactFlow's re-routing).
    //
    // A FOLDED chip is the document's doing (`settings.groupContents`), not
    // this group's, so it shows no expand toggle: flipping the group's own
    // flag underneath a fold would change nothing on screen and leave a
    // stray `collapsed` behind for when the fold lifts. The toolbar's
    // "Fold groups" toggle is where the fold is undone.
    //
    // The chip recedes with the tables it hides. The paths panel's keep-set
    // is widened to stand-ins (`keptOnCanvas`), so a chip hiding a kept
    // table is in the set and stays bright; one hiding none steps back like
    // any other card. An open frame never dims — its children do, each for
    // itself.
    const dimmed = dimmedIds !== null && !dimmedIds.has(scopeGhost ? ghostSourceId(id) : id);
    return (
      <>
        <ConnectHandles hidden={readOnly} />
        <div
          className={`as-group-chip${selected ? " as-group-chip--selected" : ""}${scopeGhost ? " as-ghost as-node--scope-ghost" : ""}${dimmed ? " as-node--dimmed" : ""}`}
          style={style}
          onDoubleClick={onDoubleClick}
          title={
            scopeGhost
              ? "External to this view — double-click to visit"
              : data.folded
                ? `${data.label} — contents folded by the diagram's group setting · double-click to open`
                : `${data.label} — collapsed · double-click to open`
          }
        >
          {!readOnly && !inScopedView && !scopeGhost && !data.folded ? (
            toggle
          ) : (
            <span className="as-group__collapse">▸</span>
          )}
          <span className="as-group-chip__label">{data.label}</span>
          {!scopeGhost ? drillBadge : null}
          <DateChip date={data.date} inline prefix="Lands" overdue={isOverdue(data.date, data.status)} />
          {teamBadge}
        </div>
      </>
    );
  }

  return (
    <>
      <NodeResizer
        isVisible={!!selected && !readOnly && !data.locked}
        // Never smaller than what it contains: shrinking past a child used to
        // leave it parented but hanging outside the frame, visibly not in the
        // box it still belongs to.
        minWidth={Math.max(NODE_MIN_SIZE.group.w, contentBox.w)}
        minHeight={Math.max(NODE_MIN_SIZE.group.h, contentBox.h)}
        onResize={holdChildrenStill}
        onResizeEnd={(event, params) => {
          holdChildrenStill(event, params);
          resizeOrigin.current = null;
          requestCommit();
        }}
        onResizeStart={(_event, params) => {
          resizeOrigin.current = { x: params.x, y: params.y };
        }}
      />
      <ConnectHandles hidden={readOnly} />
      <div
        className={`as-group${selected ? " as-group--selected" : ""}${data.status ? ` as-node--status-${data.status}` : ""}`}
        style={style}
      >
        <div className="as-group__label" title={data.label} onDoubleClick={onDoubleClick}>
          {!readOnly && !inScopedView ? toggle : null}
          {/* The name owns the truncation so the chips after it stay whole. */}
          <InlineName
            id={id}
            className="as-group__name"
            value={data.label}
            title={data.label}
            onCommit={(label) => {
              updateNodeData(id, { label });
              requestCommit();
            }}
          />
          {drillBadge}
          <DateChip date={data.date} inline prefix="Lands" overdue={isOverdue(data.date, data.status)} />
          {teamBadge}
        </div>
      </div>
    </>
  );
});

// ─── Annotation ──────────────────────────────────────────────────────────────

export const AnnotationNode = memo(function AnnotationNode({
  id,
  data,
  selected,
}: NodeProps<AnnotationNodeType>) {
  const { readOnly, requestCommit } = useStudio();
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  /** What the text was when editing began, so Escape can put it back. */
  const beforeEdit = useRef(data.label);

  const stopEditing = useCallback(() => {
    setEditing(false);
    // Inline edits go through updateNodeData, which bypasses the editor's
    // commit path — record the finished edit so it's undoable and emitted.
    requestCommit();
  }, [requestCommit]);

  /**
   * Escape ABANDONS the edit, because that is what Escape means in a text
   * field everywhere else. Committing on Escape left a mistyped note with no
   * way back except undo — and undo, from inside a field, is not where anyone
   * looks first.
   */
  const cancelEditing = useCallback(() => {
    updateNodeData(id, { label: beforeEdit.current });
    setEditing(false);
  }, [id, updateNodeData]);

  const style = {
    fontSize: data.fontSize ?? 13,
    lineHeight: 1.35,
  } as CSSProperties;

  return (
    <>
      <NodeResizer
        isVisible={!!selected && !readOnly && !data.locked}
        minWidth={NODE_MIN_SIZE.annotation.w}
        minHeight={NODE_MIN_SIZE.annotation.h}
        onResizeEnd={requestCommit}
      />
      <ConnectHandles hidden={readOnly} />
      <div
        className={`as-annotation${data.plain ? "" : " as-annotation--boxed"}${selected ? " as-annotation--selected" : ""}`}
        style={style}
        onDoubleClick={
          readOnly
            ? undefined
            : () => {
                beforeEdit.current = data.label;
                setEditing(true);
              }
        }
        title={readOnly ? undefined : "Double-click to edit · Escape to cancel"}
      >
        {editing ? (
          <textarea
            ref={areaRef}
            className="as-annotation__input nodrag nowheel"
            value={data.label}
            onChange={(e) => updateNodeData(id, { label: e.target.value })}
            onBlur={stopEditing}
            onKeyDown={(e) => {
              // Escape reverts and exits; the editor's global Delete/Backspace
              // handler must not fire while a caret is in this field.
              if (e.key === "Escape") {
                e.stopPropagation();
                cancelEditing();
              }
              e.stopPropagation();
            }}
          />
        ) : (
          <>
            {data.label}
            {/* A note's description is a sub-line under its sentence — the
                same dim gray a component card gives its own description, so
                the two read as the same kind of remark. Editing targets the
                label only, so it hides while the textarea is up. */}
            {data.description ? (
              <div className="as-annotation__desc">{data.description}</div>
            ) : null}
            <DateChip date={data.date} inline prefix="Lands" />
          </>
        )}
      </div>
    </>
  );
});

export type PointNodeType = Node<DiagramNodeData, "point">;

/**
 * The free end of a dangling arrow: a bare dot. Born when a connection drag
 * is released over empty canvas, and dragged around like any node — the
 * arrow follows. Its handles stay mounted so a chain can continue FROM the
 * dot, and so the edge that ends on it can be measured at all (see
 * ConnectHandles on why unmounting them would erase the edge).
 *
 * Unlike every other node, the handles do NOT appear on mere hover: on a
 * 12px dot the four of them cover everything, burying the head the pointer
 * came to drag. They arm — become visible and grabbable — only while the
 * pointer rests EXACTLY on the small trigger dot beside the head, and
 * disarm when it leaves the cluster (trigger, head, and handles all count
 * as inside, so travelling from the trigger to a handle keeps them armed).
 * Incoming connections are unaffected: drops snap to handles by distance,
 * not through these pointer targets.
 */
export const PointNode = memo(function PointNode({ selected }: NodeProps<PointNodeType>) {
  const { readOnly } = useStudio();
  const [armed, setArmed] = useState(false);
  return (
    <div
      className={["as-point", selected ? "as-point--selected" : "", armed ? "as-point--armed" : ""]
        .filter(Boolean)
        .join(" ")}
      onMouseLeave={() => setArmed(false)}
    >
      <ConnectHandles hidden={readOnly} />
      <div className="as-point__dot" />
      {!readOnly ? (
        <div
          className="as-point__arm nodrag"
          onMouseEnter={() => setArmed(true)}
          title="Start another arrow from this point"
        />
      ) : null}
    </div>
  );
});

export const NODE_TYPES = {
  shape: ShapeNode,
  group: GroupNode,
  annotation: AnnotationNode,
  point: PointNode,
  zone: ZoneNode,
};
