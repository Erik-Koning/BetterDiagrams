/**
 * studio-inspectors.tsx — the architecture editor's inspector panels: one
 * node, one edge, one zone, a multi-selection, and the context-menu row.
 * Split out of ArchitectureStudio.tsx; each is a plain component fed by the
 * editor's state and patch callbacks.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";

import {
  DEFAULT_ZONE_OPACITY,
  EDGE_COLORS,
  EDGE_ANCHOR_SIDES,
  EDGE_COLOR_HEX,
  EDGE_HEADS,
  EDGE_ROUTINGS,
  EDGE_STYLES,
  FIELD_KEYS,
  MAX_NODE_FIELDS,
  NODE_OUTLINES,
  NODE_STATUSES,
  TASK_PRIORITIES,
  type TaskPriority,
  type TaskStage,
  NODE_TEXT_ALIGNS,
  NODE_TEXT_VALIGNS,
  defaultTextAlign,
  DEFAULT_CONTAINER_OPACITY,
  DEFAULT_FONT_SIZE,
  type NodeOutline,
  type NodeTextAlign,
  type NodeTextVAlign,
  toZoneNodeId,
  type DiagramEdgeData,
  type DiagramNodeData,
  type EdgeColor,
  type EdgeAnchorSide,
  type EdgeDirection,
  type EdgeHead,
  type EdgeRouting,
  type EdgeStyle,
  type FieldKey,
  type NodeField,
  type NodeStatus,
} from "../contract/schema";
import {
  DEFAULT_POLYGON_POINTS,
  ZONE_OUTLINES,
  ZONE_SHAPES,
  type DiagramZone,
  type ZoneOutline,
  type ZoneShape,
} from "../contract/zones";
import {
  InspectorSection,
} from "./chrome";
import { UiIcon, type UiIconName } from "./ui-icons";
import {
  DEPENDENCY_RELATION,
  MILESTONE_KIND,
  TASK_KIND,
} from "../contract/tasks";
import { assigneeSwatch, swatchColor } from "./shapes";
import { KindSelect } from "./KindSelect";
import { SearchSelect } from "./SearchSelect";
import type { ResolvedRegistry } from "./registry-types";
import { kindDef, providerDef, relationDef, zoneInk } from "./registry-types";
import { relationDressing } from "../contract/relations";
import { useStudio } from "./context";
import { isNodeLocked, type AlignMode, type EdgePatch, type NodePatch } from "./studio-shared";

const EMPTY_NAMES: readonly string[] = [];

// ─── Inspectors ──────────────────────────────────────────────────────────────

/**
 * Zone controls: label, shape, which providers it can be switched between, and
 * stacking. The active provider is switched on the zone itself, not here — a
 * toggle you have to open an inspector to reach isn't a toggle.
 */
/**
 * The one date control, shared by the node, edge, and zone inspectors.
 *
 * A native `<input type="date">` because its value format IS the stored
 * format — no parsing, no locale ambiguity, and the platform's own picker.
 * Clearing it passes `undefined`, which every patch path reads as "unset the
 * field" rather than "keep what was there".
 */
function DateSection({
  date,
  what,
  label,
  caption = "Date",
  clearable = !!date,
  clearLabel = "Clear date",
  onChange,
}: {
  date?: string;
  /** The section's caption — "Due" for a plan's tasks and milestones. */
  caption?: string;
  /** What carries the date — "Node", "Edge", "Zone". Names the control. */
  what: string;
  label: string;
  /**
   * Offer the clear button. Defaults to "there is a date to clear"; a
   * selection whose dates DISAGREE shows no one date yet still has some to
   * clear, so the bulk bar passes "any of them is dated" instead.
   */
  clearable?: boolean;
  /** The clear button's name — distinct when one inspector shows two dates. */
  clearLabel?: string;
  onChange: (date: string | undefined) => void;
}) {
  return (
    <InspectorSection caption={caption}>
      <input
        className="as-input as-inspector__date"
        type="date"
        value={date ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        // Not just "Date": the section's own caption is already that, and two
        // controls with the same accessible name are two ambiguous targets.
        aria-label={`${what} date`}
        title={label}
      />
      {clearable ? (
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onChange(undefined)}
          aria-label={clearLabel}
          title={clearLabel === "Clear date" ? "Clear the date — the element goes back to being always present" : clearLabel}
        >
          <UiIcon name="close" size={13} />
        </button>
      ) : null}
    </InspectorSection>
  );
}

/**
 * Chips with a free-text "add" input — the one editor behind zone Supports and
 * node tags. Click a chip to toggle it; type a name and press Enter to add an
 * entry that isn't among the offered options. Options the caller knows about
 * render in their own colour; ad-hoc entries fall back to neutral until the
 * host registers them.
 */
function ChipListEditor({
  caption,
  options,
  active,
  ariaLabel,
  addPlaceholder,
  labelOf = (id) => id,
  colorOf,
  customIds,
  onToggle,
  onAdd,
}: {
  caption: string;
  /** Chips to show — typically the union of known options and active entries. */
  options: string[];
  active: string[];
  ariaLabel: string;
  addPlaceholder: string;
  labelOf?: (id: string) => string;
  colorOf?: (id: string) => string | undefined;
  /** Entries not in the caller's registry — marked with × while active. */
  customIds?: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAdd: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const id = draft.trim();
    if (!id) return;
    setDraft("");
    if (active.includes(id)) return; // already on — nothing to add
    onAdd(id);
  };

  return (
    <span className="as-inspector__group" role="group" aria-label={ariaLabel}>
      <span className="as-inspector__caption">{caption}</span>
      {options.map((id) => {
        const on = active.includes(id);
        const color = colorOf?.(id);
        return (
          <button
            key={id}
            type="button"
            className={`as-chip${on ? " as-chip--on" : ""}`}
            style={on && color ? { borderColor: color, color } : undefined}
            aria-pressed={on}
            onClick={() => onToggle(id)}
            title={`${on ? "Remove" : "Add"} ${labelOf(id)}`}
          >
            {labelOf(id)}
            {on && customIds?.has(id) ? <span className="as-chip__x"> ×</span> : null}
          </button>
        );
      })}
      <input
        className="as-chip__add"
        value={draft}
        placeholder={addPlaceholder}
        aria-label={`${ariaLabel} — add`}
        title="Type a name and press Enter to add it"

        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          // Abandon the half-typed value rather than adding it. Committing on
          // blur turned "type two letters, then click the canvas" into a tag
          // nobody asked for — and on a zone, into a whole custom provider.
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft("");
            (event.target as HTMLInputElement).blur();
          }
          event.stopPropagation();
        }}
        onBlur={() => setDraft("")}
      />
    </span>
  );
}

/** One row of the right-click menu. */
export function ContextItem({
  label,
  hint,
  danger,
  disabled,
  onPick,
  close,
}: {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onPick: () => void;
  close: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`as-context__item${danger ? " as-context__item--danger" : ""}`}
      disabled={disabled}
      onClick={() => {
        onPick();
        close();
      }}
    >
      <span>{label}</span>
      {hint ? <span className="as-context__hint">{hint}</span> : null}
    </button>
  );
}

/**
 * The inspector for a selection of several things.
 *
 * There was none: the bar rendered only for exactly one element, so selecting
 * five nodes hid it — along with Delete and Duplicate, leaving a
 * multi-selection with fewer controls than a single node. And the fields a
 * team actually sets in bulk had to be set one box at a time.
 *
 * The node and edge settings are the SAME inspectors a single element gets,
 * handed the whole selection: each control shows the shared value (or
 * "Mixed" when they disagree) and writes to everything selected. This bar
 * adds only what a selection has and an element doesn't — the count, the
 * arrangement tools, grouping, and a lock that covers zones too.
 */

/**
 * The six alignment buttons, in reading order: the three horizontal edges,
 * then the three vertical ones. Each icon draws the rail it aligns TO plus two
 * bars of unequal length measured against it, which is what makes "left"
 * readable as left rather than as right seen in a mirror.
 */
const ALIGN_BUTTONS = [
  ["left", "alignLeft"],
  ["centerX", "alignCenterX"],
  ["right", "alignRight"],
  ["top", "alignTop"],
  ["centerY", "alignCenterY"],
  ["bottom", "alignBottom"],
] as const satisfies readonly (readonly [AlignMode, UiIconName])[];

export function MultiInspector({
  nodes,
  edges,
  zoneIds,
  registry,
  zones,
  zoneIdOf,
  relevantProviders,
  fieldsOf,
  labelOf,
  onNavigate,
  onPatchNodes,
  onPatchEdges,
  onPatchZone,
  onSwapEnds,
  onClearRoutes,
  onAlign,
  onDistribute,
  onDuplicate,
  onDelete,
  onGroup,
  kindOf,
  assigneeOptions,
}: {
  /** The selected document nodes (ghosts and boundary frames already excluded). */
  nodes: readonly Node[];
  /** A node's kind by canvas id — see EdgeInspector. */
  kindOf: (nodeId: string) => string | undefined;
  /** Everyone on a task in the document — see NodeInspector. */
  assigneeOptions: readonly string[];
  edges: readonly Edge[];
  zoneIds: string[];
  registry: ResolvedRegistry;
  zones: DiagramZone[];
  zoneIdOf: (id: string) => string | null;
  relevantProviders: ReadonlySet<string>;
  fieldsOf: (nodeId: string) => readonly NodeField[];
  labelOf: (nodeId: string) => string;
  /** One selected line still names its two ends, and each is a way there. */
  onNavigate: (nodeId: string) => void;
  onPatchNodes: (ids: readonly string[], patch: NodePatch) => void;
  onPatchEdges: (ids: readonly string[], patch: EdgePatch) => void;
  onPatchZone: (id: string, patch: Partial<DiagramZone>) => void;
  onSwapEnds: (ids: readonly string[]) => void;
  onClearRoutes: (ids: readonly string[]) => void;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: "x" | "y") => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
}) {
  const flow = useReactFlow();
  const nodeIds = nodes.map((n) => n.id);

  const nodeCount = nodeIds.length ? `${nodeIds.length} node${nodeIds.length === 1 ? "" : "s"}` : "";
  const zoneCount = zoneIds.length ? `${zoneIds.length} zone${zoneIds.length === 1 ? "" : "s"}` : "";
  const edgeCount = edges.length ? `${edges.length} connection${edges.length === 1 ? "" : "s"}` : "";
  /**
   * A selection of nodes AND connections edits one side at a time: the two
   * inspectors together ran to five rows and hid the canvas they were for.
   * The count doubles as the tab strip, so nothing new has to be learned —
   * and a selection of one kind reads exactly as it always did.
   */
  const [wanted, setWanted] = useState<"nodes" | "edges">("nodes");
  const mixed = nodes.length > 0 && edges.length > 0;
  const tab: "nodes" | "edges" = mixed ? wanted : nodes.length ? "nodes" : "edges";

  // The lock covers nodes AND zones, so it is read across both.
  const lockables = [
    ...nodes.map((n) => !!(n.data as DiagramNodeData).locked),
    ...zoneIds.map((id) => isNodeLocked(flow.getNode(toZoneNodeId(id)))),
  ];
  const allLocked = lockables.length > 0 && lockables.every(Boolean);

  return (
    <>
      <InspectorSection caption="Selection">
        {mixed ? (
          <span
            className="as-inspector__tabs"
            role="tablist"
            aria-label="Which part of the selection to edit"
          >
            {(
              [
                ["nodes", nodeCount],
                ["edges", edgeCount],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`as-btn${tab === key ? " as-btn--on" : ""}`}
                onClick={() => setWanted(key)}
              >
                {label}
              </button>
            ))}
            {zoneCount ? <span className="as-inspector__count">· {zoneCount}</span> : null}
          </span>
        ) : (
          <span className="as-inspector__count">
            {[nodeCount, zoneCount, edgeCount].filter(Boolean).join(" · ")}
          </span>
        )}
      </InspectorSection>

      {nodes.length && tab === "nodes" ? (
        <NodeInspector
          nodes={nodes}
          registry={registry}
          zones={zones}
          zoneIdOf={zoneIdOf}
          relevantProviders={relevantProviders}
          lock={false}
          onPatch={onPatchNodes}
          assigneeOptions={assigneeOptions}
        />
      ) : null}

      {edges.length && tab === "edges" ? (
        <EdgeInspector
          edges={edges}
          kindOf={kindOf}
          fieldsOf={fieldsOf}
          labelOf={labelOf}
          onNavigate={onNavigate}
          relevantProviders={[...relevantProviders]}
          registry={registry}
          onPatch={onPatchEdges}
          onSwapEnds={onSwapEnds}
          onClearRoutes={onClearRoutes}
        />
      ) : null}

      <InspectorSection caption="Arrange">
        {ALIGN_BUTTONS.map(([edge, icon]) => (
          <button
            key={edge}
            type="button"
            className="as-btn as-btn--icon"
            onClick={() => onAlign(edge)}
            aria-label={`Align ${edge}`}
            title={`Align ${edge}`}
          >
            <UiIcon name={icon} />
          </button>
        ))}
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onDistribute("x")}
          aria-label="Distribute horizontally"
          title="Distribute horizontally"
        >
          <UiIcon name="distributeX" />
        </button>
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onDistribute("y")}
          aria-label="Distribute vertically"
          title="Distribute vertically"
        >
          <UiIcon name="distributeY" />
        </button>
      </InspectorSection>

      {nodeIds.length > 1 ? (
        <button type="button" className="as-btn" onClick={onGroup} title="Wrap the selection in a container">
          <UiIcon name="group" />
          Group
        </button>
      ) : null}
      {lockables.length ? (
        <button
          type="button"
          className={`as-btn as-btn--icon${allLocked ? " as-btn--on" : ""}`}
          onClick={() => {
            const next = !allLocked;
            onPatchNodes(nodeIds, { locked: next || undefined });
            for (const id of zoneIds) onPatchZone(id, { locked: next || undefined });
          }}
          aria-pressed={allLocked}
          aria-label={allLocked ? "Unlock the selection" : "Lock the selection in place"}
          title={allLocked ? "Unlock the selection" : "Lock the selection in place"}
        >
          <UiIcon name={allLocked ? "lock" : "unlock"} />
        </button>
      ) : null}
      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={onDuplicate}
        aria-label="Duplicate the selection"
        title="Duplicate the selection with its direct connections"
      >
        <UiIcon name="copy" />
      </button>
      <button type="button" className="as-btn as-btn--danger" onClick={onDelete}>
        Delete
      </button>
    </>
  );
}

export function ZoneInspector({
  zone,
  registry,
  zones,
  onPatch,
  onRestack,
}: {
  zone: DiagramZone;
  registry: ResolvedRegistry;
  /** Every zone in the document — the palette harvests their custom colours. */
  zones: DiagramZone[];
  onPatch: (zoneId: string, patch: Partial<DiagramZone>) => void;
  /** Same swap semantics as ⌘] / ⌘[ — see `restackZones`. */
  onRestack: (mode: "front" | "back" | "forward" | "backward") => void;
}) {
  const ink = zoneInk(registry, zone);

  /**
   * The swatch palette: every provider default, then every custom colour any
   * zone in the document already uses — matching an existing colour should be
   * one click, not an eyedropper exercise. Deduped by canonical hex; customs
   * that merely equal a default collapse into it.
   */
  const paletteColors = useMemo(() => {
    const out: Array<{ color: string; label: string }> = [];
    const seen = new Set<string>();
    for (const providerId of registry.providerOrder) {
      const def = providerDef(registry, providerId);
      const hex = def.color.toLowerCase();
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push({ color: def.color, label: def.label });
    }
    for (const other of zones) {
      const hex = other.color?.toLowerCase();
      if (!hex || seen.has(hex)) continue;
      seen.add(hex);
      out.push({ color: hex, label: `Custom (${other.label})` });
    }
    return out;
  }, [registry, zones]);
  const toggleProvider = (provider: string) => {
    const next = zone.providers.includes(provider)
      ? zone.providers.filter((p) => p !== provider)
      : [...zone.providers, provider];
    // A zone with no providers has no colour and no toggle; keep at least one.
    if (!next.length) return;
    onPatch(zone.id, {
      providers: next,
      provider: next.includes(zone.provider) ? zone.provider : next[0],
    });
  };

  // Chips are the UNION of registry providers and whatever the zone already
  // lists — a custom provider (typed here, or from LLM output, which the
  // validator deliberately keeps) must render, or it can never be removed.
  const providerOptions = useMemo(() => {
    const out = [...registry.providerOrder];
    for (const p of zone.providers) if (!out.includes(p)) out.push(p);
    return out;
  }, [registry.providerOrder, zone.providers]);
  const customProviders = useMemo(
    () => new Set(zone.providers.filter((p) => !registry.providerOrder.includes(p))),
    [zone.providers, registry.providerOrder],
  );

  return (
    <>
      <InspectorSection caption="Zone">
        <input
          className="as-input as-inspector__name"
          value={zone.label}
          onChange={(event) => onPatch(zone.id, { label: event.target.value })}
          aria-label="Zone label"
        />
        <SearchSelect
          value={zone.shape}
          options={ZONE_SHAPE_OPTIONS}
          onChange={(value) => {
            const shape = value as ZoneShape;
            onPatch(zone.id, {
              shape,
              // Seed an editable outline the first time polygon is chosen.
              ...(shape === "polygon" && !zone.points ? { points: [...DEFAULT_POLYGON_POINTS] } : {}),
            });
          }}
          aria-label="Zone shape"
        />
      </InspectorSection>

      {/* The picker sets the OUTLINE colour — the vivid one a human reads —
          and the background fill derives from it as a dull tint, so one choice
          styles the whole region coherently in either theme. */}
      <InspectorSection caption="Colour">
        <div className="as-swatches">
          {paletteColors.map(({ color, label }) => (
            <button
              key={color}
              type="button"
              title={label}
              aria-label={`Zone colour ${label}`}
              aria-pressed={color.toLowerCase() === ink.toLowerCase()}
              className={`as-swatch${color.toLowerCase() === ink.toLowerCase() ? " as-swatch--on" : ""}`}
              style={{ background: color }}
              onClick={() => onPatch(zone.id, { color: color.toLowerCase() })}
            />
          ))}
        </div>
        <input
          className="as-swatch as-swatch--custom"
          type="color"
          value={ink}
          onChange={(event) => onPatch(zone.id, { color: event.target.value.toLowerCase() })}
          aria-label="Custom zone colour"
          title="Pick any outline colour — the fill derives from it"
        />
        {zone.color ? (
          <button
            type="button"
            className="as-chip"
            onClick={() => onPatch(zone.id, { color: undefined })}
            title="Back to the provider's colour"
          >
            Auto
          </button>
        ) : null}
      </InspectorSection>

      <InspectorSection caption="Style">
        <SearchSelect
          value={zone.outline ?? "solid"}
          options={ZONE_OUTLINE_OPTIONS}
          onChange={(value) =>
            // `solid` is the default and never stored.
            onPatch(zone.id, { outline: value === "solid" ? undefined : (value as ZoneOutline) })
          }
          aria-label="Zone outline style"
          title="Outline — solid, dashed, dotted, or none"
        />
        <label className="as-check" title="Draw the derived background tint">
          <input
            type="checkbox"
            checked={zone.fill !== false}
            onChange={(event) =>
              // Filled is the default; only the opt-out is stored.
              onPatch(zone.id, { fill: event.target.checked ? undefined : false })
            }
          />
          Fill
        </label>
        <input
          className="as-range"
          type="range"
          min={0}
          max={0.6}
          step={0.02}
          value={zone.opacity ?? DEFAULT_ZONE_OPACITY}
          disabled={zone.fill === false}
          onChange={(event) => onPatch(zone.id, { opacity: Number(event.target.value) })}
          aria-label="Fill opacity"
          title="How strong the background tint is"
        />
      </InspectorSection>

      <ChipListEditor
        caption="Supports"
        ariaLabel="Providers this zone supports"
        addPlaceholder="+ add…"
        options={providerOptions}
        active={zone.providers}
        customIds={customProviders}
        labelOf={(p) => providerDef(registry, p).label}
        colorOf={(p) => providerDef(registry, p).color}
        onToggle={toggleProvider}
        onAdd={toggleProvider}
      />

      <DateSection
        date={zone.date}
        what="Zone"
        label="When this region comes into existence. It does not date the nodes on it."
        onChange={(date) => onPatch(zone.id, { date })}
      />

      <button
        type="button"
        className={`as-btn as-btn--icon${zone.locked ? " as-btn--on" : ""}`}
        onClick={() => onPatch(zone.id, { locked: !zone.locked })}
        aria-pressed={!!zone.locked}
        aria-label={zone.locked ? "Unlock" : "Lock in place"}
        title={zone.locked ? "Unlock — allow moving and resizing" : "Lock in place"}
      >
        <UiIcon name={zone.locked ? "lock" : "unlock"} />
      </button>
      {/* Swap with the neighbour rather than ±1 on `z`: equal z resolves by
          array order, so incrementing past a zone two levels up looks like
          the button doing nothing at all. Both directions, because a raise
          you cannot undo by eye is a one-way door. */}
      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => onRestack("backward")}
        aria-label="Send this zone behind the one below it"
        title="Send backward — behind the zone below it"
      >
        <UiIcon name="sendBackward" />
      </button>
      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => onRestack("forward")}
        aria-label="Bring this zone in front of the one above it"
        title="Bring forward — in front of the zone above it"
      >
        <UiIcon name="bringForward" />
      </button>
    </>
  );
}

/**
 * A field read across a selection: the value every element carries, and
 * whether they disagree. Each inspector control reads through this, which is
 * what lets ONE element and FIVE render through the same markup — the only
 * thing a multi-selection changes is that a disagreeing field shows "Mixed"
 * until the user sets it, at which point the value is written to everything
 * selected. Arrays compare by content, so two nodes tagged ["pci"] agree.
 */
function sharedField<D, T>(datas: readonly D[], pick: (d: D) => T): { value: T; mixed: boolean } {
  const first = pick(datas[0]!);
  const key = (v: T) => (Array.isArray(v) ? JSON.stringify(v) : v);
  const mixed = datas.some((d) => !Object.is(key(pick(d)), key(first)));
  return { value: first, mixed };
}

// The node inspector's fixed choices, built once rather than on every render.
const TASK_STAGE_OPTIONS = [
  { value: "todo", label: "To do" },
  { value: "in-progress", label: "In progress" },
  { value: "in-review", label: "In review" },
  { value: "done", label: "Done" },
];
const TASK_PRIORITY_OPTIONS = [
  { value: "", label: "No priority" },
  ...TASK_PRIORITIES.map((p) => ({ value: p, label: p.toUpperCase() })),
];
const FONT_SIZE_OPTIONS = [11, 13, 16, 20, 26].map((size) => ({ value: String(size), label: `${size}px` }));
const FIELD_KEY_OPTIONS = [
  { value: "", label: "—", keywords: "none" },
  ...FIELD_KEYS.map((key) => ({ value: key, label: key })),
];

// …and the edge and zone inspectors'.
const EDGE_DIRECTION_OPTIONS = [
  { value: "forward", label: "→", keywords: "arrow one way" },
  { value: "both", label: "↔", keywords: "arrows two way" },
  { value: "none", label: "—", keywords: "plain line" },
];
const EDGE_TAIL_OPTIONS = ["default", ...EDGE_HEADS].map((head) => ({ value: head, label: `tail: ${head}` }));
const EDGE_HEAD_OPTIONS = ["default", ...EDGE_HEADS].map((head) => ({ value: head, label: `head: ${head}` }));
const EDGE_STYLE_OPTIONS = EDGE_STYLES.map((s) => ({ value: s, label: s }));
const EDGE_ROUTING_OPTIONS = [
  { value: "default", label: "routing: default" },
  ...EDGE_ROUTINGS.map((mode) => ({ value: mode, label: mode })),
];
const EDGE_START_OPTIONS = ["auto", ...EDGE_ANCHOR_SIDES].map((side) => ({ value: side, label: `start: ${side}` }));
const EDGE_END_OPTIONS = ["auto", ...EDGE_ANCHOR_SIDES].map((side) => ({ value: side, label: `end: ${side}` }));
const ZONE_SHAPE_OPTIONS = ZONE_SHAPES.map((shape) => ({ value: shape, label: shape }));
const ZONE_OUTLINE_OPTIONS = ZONE_OUTLINES.map((o) => ({ value: o, label: `outline: ${o}` }));

/** A checkbox that reads indeterminate while the selection disagrees. */
function SharedCheck({
  checked,
  mixed,
  label,
  title,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  label: string;
  title: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="as-check" title={title}>
      <input
        type="checkbox"
        checked={!mixed && checked}
        ref={(el) => {
          if (el) el.indeterminate = mixed;
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * The node inspector — for one node, or for every node in a selection.
 *
 * One component for both, deliberately. There used to be a second, thinner
 * bar for multi-selections that offered a handful of bulk fields; every
 * control the single-node bar grew (text alignment, the frame styling, wrap)
 * had to be added there a second time or it simply wasn't available in
 * bulk — and mostly it wasn't. Here every control reads the selection's
 * shared value (or "Mixed") and writes to every node, so a multi-selection
 * has exactly the settings a single node has, minus the ones that name ONE
 * thing: the label, the description, the rows, the link.
 *
 * Sections gated on kind (the frame controls, a note's outline) appear when
 * every selected node qualifies — the settings the selection SHARES — so a
 * frame picker never writes `outline` onto a service.
 */
export function NodeInspector({
  nodes,
  linkRef,
  registry,
  zones,
  zoneIdOf,
  relevantProviders,
  lock = true,
  onPatch,
  editFieldId,
  onEditFieldFocused,
  viewFieldsCount = 0,
  onViewFields,
  assigneeOptions = EMPTY_NAMES,
}: {
  /** The selection — at least one. */
  nodes: readonly Node[];
  /** Everyone already on a task anywhere in the document — the assignee picker's offer. */
  assigneeOptions?: readonly string[];
  /** The row whose name input should take the cursor — the field menu's Edit…. */
  editFieldId?: string;
  onEditFieldFocused?: () => void;
  /** Field records on the single selected node; > 0 offers the grid. */
  viewFieldsCount?: number;
  onViewFields?: (nodeId: string) => void;
  /** So ⌘⇧K can put the cursor straight in the Link field. */
  linkRef?: React.Ref<HTMLInputElement>;
  registry: ResolvedRegistry;
  zones: DiagramZone[];
  /** Authoritative zone membership, by node id (from the derived template). */
  zoneIdOf: (id: string) => string | null;
  /** Providers the document references — the kind picker demotes the rest. */
  relevantProviders: ReadonlySet<string>;
  /** Render the lock button. A mixed selection's bar draws its own, covering zones too. */
  lock?: boolean;
  onPatch: (ids: readonly string[], patch: NodePatch) => void;
}) {
  const ids = nodes.map((n) => n.id);
  const datas = nodes.map((n) => n.data as DiagramNodeData);
  const single = nodes.length === 1;
  const data = datas[0]!;
  const defs = datas.map((d) => kindDef(registry, d.kind));
  const def = defs[0]!;
  const patch = (p: NodePatch) => onPatch(ids, p);
  const read = <T,>(pick: (d: DiagramNodeData) => T) => sharedField(datas, pick);

  // Which sections the selection qualifies for — ALL of it, or none.
  const allContainers = defs.every((d) => d.container);
  const allAnnotations = defs.every((d) => d.annotation);
  const noAnnotations = defs.every((d) => !d.annotation);
  const allPlainBoxes = defs.every((d) => !d.container && !d.annotation);
  const allTasks = datas.every((d) => d.kind === TASK_KIND);
  const allWork = datas.every((d) => d.kind === TASK_KIND || d.kind === MILESTONE_KIND);
  // Inside the studio's provider: the plan-wide colours the cards wear.
  const { assigneeColorOf } = useStudio();

  // Provider scoping lives on a zone, so it is offered when the whole
  // selection sits in the same one.
  const zoneIds = new Set(ids.map(zoneIdOf));
  const sharedZoneId = zoneIds.size === 1 ? [...zoneIds][0] : null;
  const zone = sharedZoneId ? zones.find((z) => z.id === sharedZoneId) : undefined;

  /**
   * Toggling a provider off restricts the node to the remaining ones. Turning
   * every provider on is the same as "always visible", so that clears the list
   * rather than storing a redundant full set. Applied per node, since each
   * starts from its own list.
   */
  const toggleNodeProvider = (provider: string) => {
    if (!zone) return;
    patch((d) => {
      const current = d.providers?.length ? d.providers : [...zone.providers];
      const next = current.includes(provider)
        ? current.filter((p) => p !== provider)
        : [...current, provider];
      const all = zone.providers.every((p) => next.includes(p));
      return { providers: all || !next.length ? undefined : next };
    });
  };
  /** A provider is "on" for the selection when every node shows on it. */
  const providerOn = (p: string) => datas.every((d) => !d.providers?.length || d.providers.includes(p));

  const kind = read((d) => d.kind as string);
  const linked = datas.filter((d) => !!d.url);
  const status = read((d) => d.status ?? "active");
  const icon = read((d) => d.icon as string);
  const fontSize = read((d) => d.fontSize ?? DEFAULT_FONT_SIZE);
  const plain = read((d) => !!d.plain);
  const textAlign = read((d) => d.textAlign ?? defaultTextAlign(d.kind));
  const textVAlign = read((d) => d.textVAlign ?? "middle");
  const wrap = read((d) => !!d.wrap);
  const outline = read((d) => d.outline ?? "dashed");
  const fill = read((d) => d.fill !== false);
  const opacity = read((d) => d.opacity ?? DEFAULT_CONTAINER_OPACITY);
  const color = read((d) => d.color ?? "");
  const team = read((d) => d.team ?? "");
  const date = read((d) => d.date);
  const startDate = read((d) => d.startDate);
  const locked = read((d) => !!d.locked);
  // Tags: every tag anyone carries is offered; a chip is ON when everyone
  // carries it. Toggling an ON chip strips it from all, an OFF one adds it
  // to all — so "tag these five pci" is one click.
  const tagUnion = [...new Set(datas.flatMap((d) => d.tags ?? []))];
  const tagsOnAll = tagUnion.filter((tag) => datas.every((d) => d.tags?.includes(tag)));
  // Assignees work the same way, except the offer is everyone on ANY task in
  // the document — picking an existing person, not retyping them, is what
  // keeps "Ana" one colour and one legend row.
  const assigneeUnion = [...new Set([...assigneeOptions, ...datas.flatMap((d) => d.assignees ?? [])])];
  const assigneesOnAll = assigneeUnion.filter((name) => datas.every((d) => d.assignees?.includes(name)));
  const storyPoints = read((d) => d.storyPoints);
  const done = read((d) => !!d.done);
  const stage = read((d) => (d.done ? "done" : (d.stage ?? "todo")));
  const priority = read((d) => d.priority ?? "");
  const capacity = read((d) => d.capacity);

  return (
    <>
      <InspectorSection caption={single ? "Node" : "Nodes"}>
        {single ? (
          <input
            className="as-input as-inspector__name"
            value={data.label}
            onChange={(event) => patch({ label: event.target.value })}
            aria-label="Node label"
          />
        ) : null}
        <KindSelect
          registry={registry}
          value={kind.mixed ? "" : kind.value}
          placeholder="Mixed kinds"
          relevantProviders={relevantProviders}
          onChange={(next) => {
            // Adopt the new kind's default icon so the node doesn't keep a glyph
            // that made sense only for the old kind.
            patch({ kind: next, icon: kindDef(registry, next).icon });
          }}
        />
        {noAnnotations ? (
          <SearchSelect
            value={status.value}
            mixed={status.mixed}
            options={NODE_STATUSES.map((s) => ({ value: s, label: s }))}
            onChange={(value) =>
              // `active` is the default and never stored.
              patch({ status: value === "active" ? undefined : (value as NodeStatus) })
            }
            aria-label="Lifecycle status"
            title="Lifecycle stage — proposed/planned/stubbed outline, dark hazard-taped, deprecated/retired dim"
          />
        ) : null}
      </InspectorSection>

      {allPlainBoxes ? (
        <InspectorSection caption="Style">
          <SearchSelect
            value={icon.value}
            mixed={icon.mixed}
            options={registry.iconNames.map((name) => ({ value: name, label: name === "none" ? "no icon" : name }))}
            onChange={(value) => patch({ icon: value })}
            aria-label="Node icon"
          />
          {single && allTasks ? (
            // A ticket's detail runs to sentences and lines; the card shows
            // the first two.
            <textarea
              className="as-input as-inspector__desc as-inspector__desc--multi"
              value={data.description}
              rows={3}
              placeholder="Description…"
              onChange={(event) => patch({ description: event.target.value })}
              aria-label="Node description"
            />
          ) : single ? (
            <input
              className="as-input as-inspector__desc"
              value={data.description}
              placeholder="Description…"
              onChange={(event) => patch({ description: event.target.value })}
              aria-label="Node description"
            />
          ) : null}
        </InspectorSection>
      ) : null}

      {allTasks ? (
        <InspectorSection caption="Task">
          <input
            className="as-input as-inspector__points"
            type="number"
            min={0}
            step="any"
            value={storyPoints.mixed ? "" : (storyPoints.value ?? "")}
            placeholder={storyPoints.mixed ? "Mixed" : "Points"}
            onChange={(event) => {
              const n = Number.parseFloat(event.target.value);
              patch({ storyPoints: Number.isFinite(n) && n >= 0 ? n : undefined });
            }}
            aria-label="Story points"
            title="Estimate in story points — shown in the card's header"
          />
          <SearchSelect
            value={stage.value}
            mixed={stage.mixed}
            options={TASK_STAGE_OPTIONS}
            onChange={(next) =>
              // Done is the corner check; the others are an open task's stage.
              patch(
                next === "done"
                  ? { done: true, stage: undefined }
                  : { done: undefined, stage: next === "todo" ? undefined : (next as TaskStage) },
              )
            }
            aria-label="Task status"
            title="Where the task stands — to do, in progress, in review, or done"
          />
          <SearchSelect
            value={priority.value}
            mixed={priority.mixed}
            options={TASK_PRIORITY_OPTIONS}
            onChange={(value) => patch({ priority: (value || undefined) as TaskPriority | undefined })}
            aria-label="Priority"
            title="How urgent — P0 the most; shown as a badge on the card"
          />
          <SharedCheck
            checked={done.value}
            mixed={done.mixed}
            label="Done"
            title="Finished — the card's corner check turns green, and the tasks waiting on it are no longer blocked"
            onChange={(checked) => patch(checked ? { done: true, stage: undefined } : { done: undefined })}
          />
        </InspectorSection>
      ) : null}

      {allAnnotations ? (
        <InspectorSection caption="Style">
          <SearchSelect
            value={String(fontSize.value)}
            mixed={fontSize.mixed}
            options={FONT_SIZE_OPTIONS}
            onChange={(value) => patch({ fontSize: Number(value) })}
            aria-label="Font size"
          />
          <SharedCheck
            checked={!plain.value}
            mixed={plain.mixed}
            label="Outline"
            title="Draw an outline and background behind this note"
            // Boxed is the default, so only the opt-OUT is stored.
            onChange={(checked) => patch({ plain: checked ? undefined : true })}
          />
          {/* A note's sentence is its label (double-click the note to edit);
              the description is the dim sub-line under it, and this is the
              only place to type one. */}
          {single ? (
            <input
              className="as-input as-inspector__desc"
              value={data.description}
              placeholder="Description…"
              onChange={(event) => patch({ description: event.target.value })}
              aria-label="Node description"
            />
          ) : null}
        </InspectorSection>
      ) : null}

      {/* Text layout. Every default is left (centred in a diamond) / middle /
          unwrapped, and validation stores a value only when it differs — so
          touching nothing here leaves the document byte-identical.
          Annotations keep their own editor. */}
      {noAnnotations ? (
        <InspectorSection caption="Text">
          <SearchSelect
            value={textAlign.value}
            mixed={textAlign.mixed}
            options={NODE_TEXT_ALIGNS.map((a) => ({ value: a, label: `align: ${a}` }))}
            // Per node: in a mixed selection, "left" is a service's default
            // but has to be written down on a diamond.
            onChange={(value) =>
              patch((d) => ({ textAlign: value === defaultTextAlign(d.kind) ? undefined : (value as NodeTextAlign) }))
            }
            aria-label="Text alignment"
            title="Horizontal alignment of the label and description"
          />
          <SearchSelect
            value={textVAlign.value}
            mixed={textVAlign.mixed}
            options={NODE_TEXT_VALIGNS.map((a) => ({ value: a, label: `vertical: ${a}` }))}
            onChange={(value) => patch({ textVAlign: value === "middle" ? undefined : (value as NodeTextVAlign) })}
            aria-label="Vertical text alignment"
            // A wrapped card reads from the top whatever this says (see
            // `.as-node--wrap`); the value is kept for when it unwraps.
            disabled={wrap.value && !wrap.mixed}
            title={
              wrap.value && !wrap.mixed
                ? "A wrapped card reads from the top"
                : "Where the text block sits in the box"
            }
          />
          <SearchSelect
            value={String(fontSize.value)}
            mixed={fontSize.mixed}
            options={FONT_SIZE_OPTIONS}
            onChange={(value) => {
              const size = Number(value);
              patch({ fontSize: size === DEFAULT_FONT_SIZE ? undefined : size });
            }}
            aria-label="Label size"
            title="Label size"
          />
          <SharedCheck
            checked={wrap.value}
            mixed={wrap.mixed}
            label="Wrap"
            title="Show all the text: the title wraps, the description runs the full width below it, and the box grows to fit"
            // One ellipsised line is the default, so only the opt-IN is stored.
            onChange={(checked) => patch({ wrap: checked ? true : undefined })}
          />
        </InspectorSection>
      ) : null}

      {/* A sprint's or phase's capacity — what its task roll-up is weighed against. */}
      {allContainers ? (
        <InspectorSection caption="Capacity">
          <input
            className="as-input as-inspector__points"
            type="number"
            min={0}
            step="any"
            value={capacity.mixed ? "" : (capacity.value ?? "")}
            placeholder={capacity.mixed ? "Mixed" : "No limit"}
            onChange={(event) => {
              const n = Number.parseFloat(event.target.value);
              patch({ capacity: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
            aria-label="Capacity in story points"
            title="Story points this sprint or phase can hold — its roll-up warns past it"
          />
        </InspectorSection>
      ) : null}

      {/* Container frame — the same three controls a zone gets, because it is
          the same vocabulary. Fill off + outline none is an invisible grouping
          box that still nests, still accepts drops, and still drills in. */}
      {allContainers ? (
        <InspectorSection caption="Frame">
          <SearchSelect
            value={outline.value}
            mixed={outline.mixed}
            options={NODE_OUTLINES.map((o) => ({ value: o, label: `outline: ${o}` }))}
            onChange={(value) =>
              // `dashed` is the group default and never stored.
              patch({ outline: value === "dashed" ? undefined : (value as NodeOutline) })
            }
            aria-label="Frame outline style"
            title="Outline — solid, dashed, dotted, or none"
          />
          <SharedCheck
            checked={fill.value}
            mixed={fill.mixed}
            label="Fill"
            title="Draw the background tint"
            // Filled is the default; only the opt-out is stored.
            onChange={(checked) => patch({ fill: checked ? undefined : false })}
          />
          <input
            className="as-range"
            type="range"
            min={0}
            max={0.6}
            step={0.02}
            value={opacity.mixed ? DEFAULT_CONTAINER_OPACITY : opacity.value}
            disabled={!fill.mixed && !fill.value}
            onChange={(event) => patch({ opacity: Number(event.target.value) })}
            aria-label="Frame fill opacity"
            title={opacity.mixed ? "Mixed — drag to set one tint for all" : "How strong the background tint is"}
          />
          <input
            className="as-swatch as-swatch--custom"
            type="color"
            value={color.mixed || !color.value ? def.accent : color.value}
            onChange={(event) => patch({ color: event.target.value })}
            aria-label="Frame colour"
            title={color.mixed ? "Mixed — pick one ink for all" : "Frame ink — the outline colour the fill is derived from"}
          />
          {datas.some((d) => d.color) ? (
            <button
              type="button"
              className="as-chip"
              onClick={() => patch({ color: undefined, opacity: undefined })}
              title="Back to the kind's own colour"
            >
              Auto
            </button>
          ) : null}
        </InspectorSection>
      ) : null}

      {/* Which deployments this node exists in. Only meaningful on a zone —
          without one there is no provider to compare against. */}
      {zone && zone.providers.length > 1 ? (
        <span className="as-inspector__group" role="group" aria-label="Visible on">
          <span className="as-inspector__caption">On</span>
          {zone.providers.map((p) => {
            const on = providerOn(p);
            const pd = providerDef(registry, p);
            return (
              <button
                key={p}
                type="button"
                className={`as-chip${on ? " as-chip--on" : ""}`}
                style={on ? { borderColor: pd.color, color: pd.color } : undefined}
                aria-pressed={on}
                onClick={() => toggleNodeProvider(p)}
                title={on ? `Hide on ${pd.label}` : `Show on ${pd.label}`}
              >
                {pd.label}
              </button>
            );
          })}
        </span>
      ) : null}

      {single && onViewFields && viewFieldsCount > 0 ? (
        <button type="button" className="as-btn as-inspector__viewfields" onClick={() => onViewFields(ids[0]!)}>
          View all fields ({viewFieldsCount})
        </button>
      ) : null}

      {/* Rows, for the kinds whose substance is rows — plus any node that
          already has some, so a document that arrived with fields on a
          "service" can still be edited rather than only viewed. */}
      {single && (def.record || data.fields?.length) ? (
        <FieldsEditor
          fields={data.fields ?? []}
          onChange={(fields) => patch({ fields })}
          focusFieldId={editFieldId}
          onFocused={onEditFieldFocused}
        />
      ) : null}

      {noAnnotations ? (
        <ChipListEditor
          caption="Tags"
          ariaLabel="Node tags"
          addPlaceholder="+ tag…"
          options={tagUnion}
          active={tagsOnAll}
          customIds={new Set(tagUnion)}
          onToggle={(tag) =>
            tagsOnAll.includes(tag)
              ? patch((d) => {
                  const next = (d.tags ?? []).filter((t) => t !== tag);
                  return { tags: next.length ? next : undefined };
                })
              : patch((d) => ({ tags: d.tags?.includes(tag) ? d.tags : [...(d.tags ?? []), tag] }))
          }
          onAdd={(tag) =>
            patch((d) => ({ tags: d.tags?.includes(tag) ? d.tags : [...(d.tags ?? []), tag] }))
          }
        />
      ) : null}

      {allTasks ? (
        <ChipListEditor
          caption="Assignees"
          ariaLabel="Assignees"
          addPlaceholder="+ person…"
          options={assigneeUnion}
          active={assigneesOnAll}
          colorOf={assigneeColorOf ?? ((name) => swatchColor(assigneeSwatch(name)))}
          customIds={new Set(assigneeUnion)}
          onToggle={(name) =>
            assigneesOnAll.includes(name)
              ? patch((d) => {
                  const next = (d.assignees ?? []).filter((a) => a !== name);
                  return { assignees: next.length ? next : undefined };
                })
              : patch((d) => ({
                  assignees: d.assignees?.includes(name) ? d.assignees : [...(d.assignees ?? []), name],
                }))
          }
          onAdd={(name) =>
            patch((d) => ({
              assignees: d.assignees?.includes(name) ? d.assignees : [...(d.assignees ?? []), name],
            }))
          }
        />
      ) : null}

      {noAnnotations ? (
        <InspectorSection caption="Team">
          <input
            className="as-input as-inspector__team"
            value={team.mixed ? "" : team.value}
            placeholder={team.mixed ? "Mixed" : "Owning team…"}
            onChange={(event) => patch({ team: event.target.value || undefined })}
            aria-label="Owning team"
          />
        </InspectorSection>
      ) : null}

      <DateSection
        date={date.mixed ? undefined : date.value}
        clearable={datas.some((d) => !!d.date)}
        what={allWork ? "Due" : "Node"}
        caption={allWork ? "Due" : "Date"}
        label={
          date.mixed
            ? "Mixed — pick one date for all"
            : allWork
              ? "When this is due. It shows overdue once the date passes unfinished."
              : "When this node lands. Undated means it is always there."
        }
        onChange={(next) => patch({ date: next })}
      />

      {allTasks ? (
        <DateSection
          date={startDate.mixed ? undefined : startDate.value}
          clearable={datas.some((d) => !!d.startDate)}
          what="Start"
          caption="Start"
          clearLabel="Clear start date"
          label={
            startDate.mixed
              ? "Mixed — pick one start for all"
              : "When work starts. Laid out by date, the task runs from here to its due date."
          }
          onChange={(next) => patch({ startDate: next })}
        />
      ) : null}

      {single && noAnnotations ? (
        <InspectorSection caption="Link">
          <input
            ref={linkRef}
            className="as-input as-inspector__url"
            value={data.url ?? ""}
            placeholder="https://… or file:Name"
            onChange={(event) => patch({ url: event.target.value || undefined })}
            aria-label="Documentation link"
          />
          {data.url && !data.url.startsWith("file:") ? (
            <a
              className="as-btn as-btn--icon"
              href={data.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${data.url}`}
              aria-label="Open link"
            >
              <UiIcon name="externalLink" />
            </a>
          ) : null}
        </InspectorSection>
      ) : !single && noAnnotations && linked.length ? (
        // A link names ONE place, so a selection gets no input for it — but
        // it can drop the ones it has, which is what a hundred imported
        // tables all wearing their source's ↗ actually want.
        <InspectorSection caption="Link">
          <button
            type="button"
            className="as-btn"
            onClick={() => patch({ url: undefined })}
            title={`${linked.length} of ${ids.length} selected nodes carry a ↗ link — remove them all; ⌘Z restores them`}
          >
            Clear link{linked.length > 1 ? "s" : ""} ({linked.length})
          </button>
        </InspectorSection>
      ) : null}

      {lock ? (
        <button
          type="button"
          className={`as-btn as-btn--icon${locked.value && !locked.mixed ? " as-btn--on" : ""}`}
          onClick={() => patch({ locked: locked.value && !locked.mixed ? undefined : true })}
          aria-pressed={locked.value && !locked.mixed}
          aria-label={locked.value && !locked.mixed ? "Unlock" : "Lock in place"}
          title={locked.value && !locked.mixed ? "Unlock — allow moving and resizing" : "Lock in place"}
        >
          <UiIcon name={locked.value && !locked.mixed ? "lock" : "unlock"} />
        </button>
      ) : null}
    </>
  );
}

/**
 * A row's tags as one comma-separated input. Edited as a draft and committed
 * on blur or Enter: splitting on every keystroke would eat the comma the
 * user just typed, and a chip list per row would not fit the row.
 */
function FieldTagsInput({
  tags,
  label,
  onChange,
}: {
  tags: readonly string[];
  label: string;
  onChange: (tags: string[] | undefined) => void;
}) {
  const joined = tags.join(", ");
  const [draft, setDraft] = useState(joined);
  // A change from outside — undo, an AI edit — resets the draft.
  useEffect(() => setDraft(joined), [joined]);
  const commit = () => {
    const next = [...new Set(draft.split(",").map((t) => t.trim()).filter(Boolean))];
    if (next.join(", ") !== joined) onChange(next.length ? next : undefined);
    setDraft(next.join(", "));
  };
  return (
    <input
      className="as-input as-fieldrow__tags"
      value={draft}
      placeholder="tags"
      title="Tags, comma-separated — ro (read-only), hidden, pii…"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      aria-label={label}
    />
  );
}

/**
 * The row editor for a record node — a table's columns, a class's properties.
 *
 * Rows are ordered, and the order is visible: it decides where each one sits
 * in the box and therefore where a foreign-key line lands, so the list offers
 * a move-up rather than making the user retype a column to re-place it.
 */
function FieldsEditor({
  fields,
  onChange,
  focusFieldId,
  onFocused,
}: {
  fields: readonly NodeField[];
  onChange: (fields: NodeField[] | undefined) => void;
  /** Put the cursor in this row's name input once, then report it done. */
  focusFieldId?: string;
  onFocused?: () => void;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!focusFieldId) return;
    const input = rootRef.current?.querySelector<HTMLInputElement>(
      `input[data-field-id="${focusFieldId.replace(/["\\]/g, "\\$&")}"]`,
    );
    input?.focus();
    input?.select();
    onFocused?.();
  }, [focusFieldId, onFocused]);
  /** An id nothing else in this node uses — edges reference rows by id. */
  const freshId = () => {
    const taken = new Set(fields.map((f) => f.id));
    let n = fields.length + 1;
    while (taken.has(`field_${n}`)) n++;
    return `field_${n}`;
  };

  const replace = (next: NodeField[]) => onChange(next.length ? next : undefined);
  const patch = (index: number, part: Partial<NodeField>) =>
    replace(fields.map((f, i) => (i === index ? { ...f, ...part } : f)));

  return (
    <span ref={rootRef} className="as-inspector__section as-fields" role="group" aria-label="Fields">
      <span className="as-inspector__caption">Fields</span>
      <span className="as-fields__list">
        {fields.map((field, index) => (
          <span className="as-fieldrow" key={field.id}>
            <SearchSelect
              className="as-fieldrow__key"
              value={field.key ?? ""}
              options={FIELD_KEY_OPTIONS}
              onChange={(value) => patch(index, { key: (value || undefined) as FieldKey | undefined })}
              aria-label={`Key role of ${field.name || "field"}`}
              title="Key role — primary, foreign, or both"
            />
            <input
              className="as-input as-fieldrow__name"
              data-field-id={field.id}
              value={field.name}
              placeholder="column"
              onChange={(event) => patch(index, { name: event.target.value })}
              aria-label={`Field ${index + 1} name`}
            />
            <input
              className="as-input as-fieldrow__type"
              value={field.type ?? ""}
              placeholder="type"
              onChange={(event) => patch(index, { type: event.target.value || undefined })}
              aria-label={`Field ${index + 1} type`}
            />
            <FieldTagsInput
              tags={field.tags ?? []}
              label={`Field ${index + 1} tags`}
              onChange={(tags) => patch(index, { tags })}
            />
            <button
              type="button"
              className={`as-btn as-btn--icon${field.required ? " as-btn--on" : ""}`}
              onClick={() => patch(index, { required: field.required ? undefined : true })}
              aria-pressed={!!field.required}
              aria-label={`${field.required ? "Optional" : "Required"}: ${field.name || `field ${index + 1}`}`}
              title={field.required ? "Required — click to make optional" : "Optional — click to require"}
            >
              <UiIcon name="asterisk" size={12} />
            </button>
            {/* Both directions. Row order is meaning here — a foreign-key
                line anchors to a column by its position — and with only ↑,
                moving the first of ten columns to the bottom was nine clicks
                on nine other rows. */}
            <button
              type="button"
              className="as-btn as-btn--icon"
              disabled={index === 0}
              onClick={() => {
                const next = [...fields];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                replace(next);
              }}
              aria-label={`Move ${field.name || `field ${index + 1}`} up`}
              title="Move up"
            >
              <UiIcon name="arrowUp" size={13} />
            </button>
            <button
              type="button"
              className="as-btn as-btn--icon"
              disabled={index === fields.length - 1}
              onClick={() => {
                const next = [...fields];
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                replace(next);
              }}
              aria-label={`Move ${field.name || `field ${index + 1}`} down`}
              title="Move down"
            >
              <UiIcon name="arrowDown" size={13} />
            </button>
            <button
              type="button"
              className="as-btn as-btn--icon"
              onClick={() => replace(fields.filter((_, i) => i !== index))}
              aria-label={`Remove ${field.name || `field ${index + 1}`}`}
              title="Remove this field"
            >
              <UiIcon name="close" size={12} />
            </button>
          </span>
        ))}
      </span>
      <button
        type="button"
        className="as-btn"
        disabled={fields.length >= MAX_NODE_FIELDS}
        onClick={() => replace([...fields, { id: freshId(), name: "" }])}
        title={
          fields.length >= MAX_NODE_FIELDS
            ? `A node holds at most ${MAX_NODE_FIELDS} fields`
            : "Add a field"
        }
      >
        <UiIcon name="plus" size={13} />
        Add field
      </button>
    </span>
  );
}

/**
 * The edge inspector — for one connection, or every connection selected.
 *
 * Same doctrine as `NodeInspector`: one component, every control reading the
 * shared value and writing to the whole selection. A multi-selection keeps
 * every setting a line can share — heads, direction, routing, the side each
 * end leaves from, style, colour, tech, date, providers, cardinality — and
 * drops only what names ONE line: its label, its step number, and which row
 * of which box it attaches to.
 */
/**
 * The two kinds of line between tasks, as a two-way switch: a PREREQUISITE
 * is an ordinary arrow, always drawn; a DEPENDENCY links work elsewhere in
 * the plan and is drawn only while either task is hovered or selected.
 * `null` is a selection of both.
 */
function TaskLinkSwitch({
  value,
  onChange,
}: {
  value: "prerequisite" | "dependency" | null;
  onChange: (next: "prerequisite" | "dependency") => void;
}) {
  return (
    <InspectorSection caption="Link">
      <span className="as-inspector__group" role="group" aria-label="Link type">
        <button
          type="button"
          className={`as-btn${value === "prerequisite" ? " as-btn--on" : ""}`}
          aria-pressed={value === "prerequisite"}
          title="Finish the first task before the one the arrow points at — always drawn"
          onClick={() => onChange("prerequisite")}
        >
          Prerequisite
        </button>
        <button
          type="button"
          className={`as-btn${value === "dependency" ? " as-btn--on" : ""}`}
          aria-pressed={value === "dependency"}
          title="Waits on work elsewhere in the plan — drawn only while either task is hovered or selected"
          onClick={() => onChange("dependency")}
        >
          Dependency (on hover)
        </button>
      </span>
    </InspectorSection>
  );
}

export function EdgeInspector({
  edges,
  fieldsOf,
  labelOf,
  onNavigate,
  relevantProviders,
  registry,
  onPatch,
  onSwapEnds,
  onClearRoutes,
  kindOf,
}: {
  /** The selection — at least one. */
  edges: readonly Edge[];
  /** A node's kind by canvas id — tells a line between two tasks from any other. */
  kindOf?: (nodeId: string) => string | undefined;
  /** Rows of a node — what an end may attach to. */
  fieldsOf: (nodeId: string) => readonly NodeField[];
  /** What a node is called, so the bar can say what a line joins. */
  labelOf: (nodeId: string) => string;
  /** Go to one end by its canvas id — the studio resolves what it stands for. */
  onNavigate: (nodeId: string) => void;
  relevantProviders: readonly string[];
  registry: ResolvedRegistry;
  onPatch: (ids: readonly string[], patch: EdgePatch) => void;
  onSwapEnds: (ids: readonly string[]) => void;
  /**
   * Drop these lines' waypoints. Goes through the studio's shared clear rather
   * than a `points: undefined` patch of its own, so the inspector, the
   * right-click menu and the Arrange item are one code path with one
   * undo entry — they used to be two.
   */
  onClearRoutes: (ids: readonly string[]) => void;
}) {
  const ids = edges.map((e) => e.id);
  const datas = edges.map((e) => (e.data ?? {}) as DiagramEdgeData);
  const single = edges.length === 1;
  const edge = edges[0]!;
  const data = datas[0]!;
  const patch = (p: EdgePatch) => onPatch(ids, p);
  const read = <T,>(pick: (d: DiagramEdgeData) => T) => sharedField(datas, pick);

  const sourceFields = single ? fieldsOf(edge.source) : [];
  const targetFields = single ? fieldsOf(edge.target) : [];
  // Cardinality is offered where it means something: an endpoint has rows,
  // or a line already carries end labels. Across a selection, "any" of them.
  const anyEndRows = edges.some((e) => fieldsOf(e.source).length || fieldsOf(e.target).length);
  const anyEndLabels = datas.some((d) => d.startLabel || d.endLabel);
  const anyRelation = datas.some((d) => d.relation);
  // Every line joins two tasks: it is a prerequisite or a dependency, and
  // that switch replaces the data-model cardinality controls.
  const allTaskLinks =
    !!kindOf && edges.every((e) => kindOf(e.source) === TASK_KIND && kindOf(e.target) === TASK_KIND);
  const routed = edges.filter((e) => (e.data as DiagramEdgeData | undefined)?.points?.length);

  const tech = read((d) => d.tech ?? "");
  const relation = read((d) => d.relation ?? "");
  const direction = read((d) => d.direction ?? "forward");
  const startHead = read((d) => d.startHead ?? "default");
  const endHead = read((d) => d.endHead ?? "default");
  const startLabel = read((d) => d.startLabel ?? "");
  const endLabel = read((d) => d.endLabel ?? "");
  const date = read((d) => d.date);
  const style = read((d) => d.style ?? "solid");
  const routing = read((d) => d.routing ?? "default");
  const startSide = read((d) => d.start?.side ?? "auto");
  const endSide = read((d) => d.end?.side ?? "auto");
  const color = read((d) => d.color);
  // Providers, like node tags: every provider any line names is offered, a
  // chip is ON when every line names it.
  const providerUnion = [...new Set([...relevantProviders, ...datas.flatMap((d) => d.providers ?? [])])];
  const providersOnAll = providerUnion.filter((p) => datas.every((d) => d.providers?.includes(p)));

  return (
    <>
      {/* Which boxes this line joins, and a way to turn it round. The schema
          has carried edge endpoints since the beginning and the inspector
          never showed them — so "I drew that the wrong way" meant deleting
          the line and drawing it again, losing its label and its route. */}
      <InspectorSection caption={single ? "Between" : "Connections"}>
        {single ? (
          // Each end is a way there. Selecting a line is how you ask what it
          // joins, and on anything bigger than a screenful the answer named
          // two boxes you then had to go and find.
          <span className="as-inspector__ends">
            <button
              type="button"
              className="as-inspector__endjump"
              title={`Go to ${labelOf(edge.source)}`}
              onClick={() => onNavigate(edge.source)}
            >
              {labelOf(edge.source)}
            </button>
            <span aria-hidden="true"> → </span>
            <button
              type="button"
              className="as-inspector__endjump"
              title={`Go to ${labelOf(edge.target)}`}
              onClick={() => onNavigate(edge.target)}
            >
              {labelOf(edge.target)}
            </button>
          </span>
        ) : null}
        <button
          type="button"
          className="as-btn as-btn--icon"
          onClick={() => onSwapEnds(ids)}
          aria-label={single ? "Reverse this connection" : "Reverse the selected connections"}
          title="Reverse — swap which end it starts from"
        >
          <UiIcon name="swap" />
        </button>
      </InspectorSection>

      {providerUnion.length ? (
        // An edge can be scoped to a topology exactly like a node — the
        // README sells "a replication stream present on AWS but not Azure" —
        // and there was no control for it anywhere, so the field could only
        // be set by hand-editing the JSON.
        <ChipListEditor
          caption="On"
          ariaLabel="Providers this connection exists on"
          addPlaceholder="+ add…"
          options={providerUnion}
          active={providersOnAll}
          labelOf={(p) => providerDef(registry, p).label}
          colorOf={(p) => providerDef(registry, p).color}
          onToggle={(p) =>
            providersOnAll.includes(p)
              ? patch((d) => {
                  const next = (d.providers ?? []).filter((x) => x !== p);
                  return { providers: next.length ? next : undefined };
                })
              : patch((d) => ({
                  providers: d.providers?.includes(p) ? d.providers : [...(d.providers ?? []), p],
                }))
          }
          onAdd={(p) =>
            patch((d) => ({
              providers: d.providers?.includes(p) ? d.providers : [...(d.providers ?? []), p],
            }))
          }
        />
      ) : null}

      <InspectorSection caption="Edge">
        {single ? (
          <input
            className="as-input as-inspector__name"
            value={data.label ?? ""}
            placeholder="Edge label"
            onChange={(event) => patch({ label: event.target.value })}
            aria-label="Edge label"
          />
        ) : null}
        <input
          className="as-input as-inspector__tech"
          value={tech.mixed ? "" : tech.value}
          placeholder={tech.mixed ? "Tech: mixed" : "Tech: JSON/HTTPS"}
          onChange={(event) => patch({ tech: event.target.value })}
          aria-label="Edge technology"
        />
      </InspectorSection>

      <InspectorSection caption="Flow">
        <SearchSelect
          value={direction.value}
          mixed={direction.mixed}
          options={EDGE_DIRECTION_OPTIONS}
          onChange={(value) => patch({ direction: value as EdgeDirection })}
          aria-label="Edge direction"
          title="Arrowheads"
        />
        <SearchSelect
          value={startHead.value}
          mixed={startHead.mixed}
          options={EDGE_TAIL_OPTIONS}
          onChange={(value) => patch({ startHead: value === "default" ? undefined : (value as EdgeHead) })}
          aria-label="Start glyph"
          title="Glyph at the source end — default follows the direction setting"
        />
        <SearchSelect
          value={endHead.value}
          mixed={endHead.mixed}
          options={EDGE_HEAD_OPTIONS}
          onChange={(value) => patch({ endHead: value === "default" ? undefined : (value as EdgeHead) })}
          aria-label="End glyph"
          title="Glyph at the target end — default follows the direction setting"
        />
        {single ? (
          <input
            className="as-input as-inspector__seq"
            type="number"
            min={0}
            value={data.seq ?? ""}
            placeholder="#"
            onChange={(event) => {
              const n = Number.parseInt(event.target.value, 10);
              patch({ seq: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
            aria-label="Sequence number"
            title="Step number for a dynamic (numbered-flow) diagram"
          />
        ) : null}
      </InspectorSection>

      {allTaskLinks ? (
        <TaskLinkSwitch
          value={relation.mixed ? null : relation.value === DEPENDENCY_RELATION ? "dependency" : "prerequisite"}
          onChange={(next) => {
            const dressing = relationDressing(relationDef(registry, DEPENDENCY_RELATION));
            if (next === "dependency") {
              patch({ relation: DEPENDENCY_RELATION, ...dressing });
              return;
            }
            // Back to an ordinary line. The dependency look comes off only
            // where the line still wears it — a hand-recoloured line keeps
            // its colour.
            patch((d) =>
              d.relation !== DEPENDENCY_RELATION
                ? {}
                : {
                    relation: undefined,
                    ...(d.style === dressing.style ? { style: "solid" as const } : {}),
                    ...(d.color === dressing.color ? { color: "slate" as const } : {}),
                  },
            );
          }}
        />
      ) : null}

      {/* Cardinality and the rows each end attaches to. Offered where it means
          something — either endpoint has rows, or this edge already carries
          end labels — rather than on every architecture connection. */}
      {!allTaskLinks && (anyEndRows || anyEndLabels || anyRelation) ? (
        <InspectorSection caption="Ends">
          {/* What kind of relationship the line is. Choosing one dresses the
              line the way the legend shows that kind — style, colour, end
              glyphs, cardinality — as one edit; clearing it leaves the
              dressing alone, so a line keeps looking as it did. */}
          <SearchSelect
            value={relation.value}
            mixed={relation.mixed}
            options={[
              { value: "", label: "relation: none", keywords: "none" },
              // A dependency is a task graph's line (see the switch above), so a
              // data model's picker offers it only to a line already wearing it.
              ...registry.relationOrder
                .filter((id) => id !== DEPENDENCY_RELATION || relation.value === id)
                .map((id) => ({
                  value: id,
                  label: registry.relationKinds[id]?.label ?? id,
                  title: registry.relationKinds[id]?.description,
                })),
              // A kind the document names that nobody registered stays pickable rather than reading as "none".
              ...(!relation.mixed && relation.value && !registry.relationKinds[relation.value]
                ? [{ value: relation.value, label: relationDef(registry, relation.value).label }]
                : []),
            ]}
            onChange={(id) =>
              patch(id ? { relation: id, ...relationDressing(relationDef(registry, id)) } : { relation: undefined })
            }
            aria-label="Relationship kind"
            title="What kind of relationship this is — picking one dresses the line to match"
          />
          <input
            className="as-input as-inspector__end"
            value={startLabel.mixed ? "" : startLabel.value}
            placeholder={startLabel.mixed ? "Mixed" : "1"}
            onChange={(event) => patch({ startLabel: event.target.value || undefined })}
            aria-label="Cardinality at the source end"
            title="Cardinality at the source end — 1, 0..1, 0..*, 1..*"
          />
          {sourceFields.length ? (
            <SearchSelect
              value={data.startField ?? ""}
              options={[
                { value: "", label: "from: box" },
                ...sourceFields.map((field) => ({ value: field.id, label: field.name || field.id })),
              ]}
              onChange={(value) => patch({ startField: value || undefined })}
              aria-label="Source field"
              title="Which row of the source this line leaves from"
            />
          ) : null}
          {targetFields.length ? (
            <SearchSelect
              value={data.endField ?? ""}
              options={[
                { value: "", label: "to: box" },
                ...targetFields.map((field) => ({ value: field.id, label: field.name || field.id })),
              ]}
              onChange={(value) => patch({ endField: value || undefined })}
              aria-label="Target field"
              title="Which row of the target this line lands on"
            />
          ) : null}
          <input
            className="as-input as-inspector__end"
            value={endLabel.mixed ? "" : endLabel.value}
            placeholder={endLabel.mixed ? "Mixed" : "0..*"}
            onChange={(event) => patch({ endLabel: event.target.value || undefined })}
            aria-label="Cardinality at the target end"
            title="Cardinality at the target end — 1, 0..1, 0..*, 1..*"
          />
        </InspectorSection>
      ) : null}

      <DateSection
        date={date.mixed ? undefined : date.value}
        clearable={datas.some((d) => !!d.date)}
        what="Edge"
        label={
          date.mixed
            ? "Mixed — pick one date for all"
            : "When this connection lands. It is never shown before the nodes it joins."
        }
        onChange={(next) => patch({ date: next })}
      />

      <InspectorSection caption="Style">
        <SearchSelect
          value={style.value}
          mixed={style.mixed}
          options={EDGE_STYLE_OPTIONS}
          onChange={(value) => patch({ style: value as EdgeStyle })}
          aria-label="Edge style"
        />
        <SearchSelect
          value={routing.value}
          mixed={routing.mixed}
          options={EDGE_ROUTING_OPTIONS}
          onChange={(value) => patch({ routing: value === "default" ? undefined : (value as EdgeRouting) })}
          aria-label="Edge routing"
          title="Routing — default follows the diagram setting"
        />
        <SearchSelect
          value={startSide.value}
          mixed={startSide.mixed}
          options={EDGE_START_OPTIONS}
          // Choosing a side drops any stored fraction: the picker pins the
          // centre of that side; drag the line itself for finer routing.
          onChange={(value) => patch({ start: value === "auto" ? undefined : { side: value as EdgeAnchorSide } })}
          aria-label="Start anchor"
          title="Which side of the source box the line leaves — auto faces wherever it's going"
        />
        <SearchSelect
          value={endSide.value}
          mixed={endSide.mixed}
          options={EDGE_END_OPTIONS}
          onChange={(value) => patch({ end: value === "auto" ? undefined : { side: value as EdgeAnchorSide } })}
          aria-label="End anchor"
          title="Which side of the target box the line arrives at"
        />
        {routed.length ? (
          <button
            type="button"
            className="as-btn"
            onClick={() => onClearRoutes(routed.map((e) => e.id))}
            title="Remove the waypoints these lines bend through (drag a line to bend it; double-click edits the label) — ⌘Z restores them"
          >
            Clear route{routed.length > 1 ? "s" : ""} (
            {single ? data.points!.length : routed.length})
          </button>
        ) : null}
        <div className="as-swatches">
          {EDGE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              aria-label={`Edge colour ${c}`}
              aria-pressed={!color.mixed && color.value === c}
              className={`as-swatch${!color.mixed && color.value === c ? " as-swatch--on" : ""}`}
              // Resolves through the theme's --as-edge-* override when set,
              // so the picker shows the colour the edge will actually be.
              style={{ background: `var(--as-edge-${c}, ${EDGE_COLOR_HEX[c as EdgeColor]})` }}
              onClick={() => patch({ color: c as EdgeColor })}
            />
          ))}
        </div>
      </InspectorSection>
    </>
  );
}
