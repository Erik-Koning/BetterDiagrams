/**
 * chrome.tsx — the shared editor chrome.
 *
 * Both editors (ArchitectureStudio and SequenceStudio) speak the same UI
 * language: toolbar dropdowns with one open-menu slot, a floating inspector
 * bar of captioned sections, and the corner version-tag chip. These live here
 * so the two stay pixel-identical without either importing the other.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { VERSION_TAG_POSITIONS, type VersionTagPosition } from "../contract/schema";
import { isMac } from "./keys";
import {
  TIMELINE_FUTURE_MODES,
  dateToDay,
  dayToDate,
  formatDiagramDate,
  nearestStop,
  normalizeDate,
  type DiagramDate,
  type Timeline,
  type TimelineFutureMode,
} from "../contract/timeline";

/**
 * The BetterDiagrams mark — the repo's logo.svg redrawn in the editor's own
 * tokens: two nodes on the left converging along horizontal-tangent splines
 * into one vertically-centred node on the right, everything straddling a
 * rounded frame and clipping at its perimeter. Inline SVG rather than an
 * <img> so it recolours with the active theme; each token carries the dark
 * default as a fallback so the mark also renders outside `.as-root` (a host
 * page header, say). Strokes are a touch heavier than the standalone logo so
 * the mark still reads at toolbar size.
 */
export function BrandMark({ className }: { className?: string }) {
  // Two marks render per page (host chrome + welcome modal); the clip id must
  // not collide or one silently clips with the other's geometry.
  const clipId = `${useId()}-frame`;
  const accent = "var(--as-accent, #38bdf8)";
  const node = "var(--as-surface, #0b1220)";
  return (
    <svg className={className} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="256" height="256" rx="58" />
        </clipPath>
      </defs>
      <rect x="0" y="0" width="256" height="256" rx="58" fill="var(--as-surface-2, #1e293b)" />
      <g clipPath={`url(#${clipId})`}>
        {/* Splines: horizontal tangents at both ends, like the canvas edges. */}
        <path
          d="M 68 76 C 128 76 128 121 190 121"
          fill="none"
          stroke={accent}
          strokeWidth="10"
          strokeLinecap="round"
        />
        <path
          d="M 68 180 C 128 180 128 135 190 135"
          fill="none"
          stroke={accent}
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* Left nodes: a vertical pair, slightly past the left perimeter. */}
        <rect x="-18" y="48" width="86" height="56" rx="14" fill={node} stroke={accent} strokeWidth="10" />
        <rect x="-18" y="152" width="86" height="56" rx="14" fill={node} stroke={accent} strokeWidth="10" />
        {/* Right node: vertically centred, slightly past the right perimeter. */}
        <rect x="188" y="100" width="86" height="56" rx="14" fill={node} stroke={accent} strokeWidth="10" />
      </g>
      {/* The frame outline sits on top, so the cut nodes end cleanly under it. */}
      <rect x="4" y="4" width="248" height="248" rx="54" fill="none" stroke="var(--as-border, #334155)" strokeWidth="8" />
    </svg>
  );
}

/**
 * The one toolbar dropdown. Every menu — Insert, Arrange, View, Export — is
 * this component, so they all share the same button styling, aria wiring,
 * and (via the parent's single `openMenu` slot + document listener) the same
 * open-one-close-the-rest and click-outside behaviour.
 */
export function ToolbarMenu({
  label,
  title,
  active = false,
  open,
  onToggle,
  menuClassName,
  children,
}: {
  label: string;
  title?: string;
  /** Highlight the button even while closed (an active filter, say). */
  active?: boolean;
  open: boolean;
  onToggle: () => void;
  menuClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="as-menu-wrap">
      <button
        type="button"
        className={`as-btn${active || open ? " as-btn--on" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
      >
        {label} ▾
      </button>
      {open ? (
        <div className={`as-menu${menuClassName ? ` ${menuClassName}` : ""}`} role="menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The revision notice pinned in a canvas corner. Document data, not view
 * state — it saves with the diagram and appears in exports. Click to edit
 * the label or move it to another corner; clearing the label removes it.
 */
export function VersionTagChip({
  tag,
  position,
  readOnly,
  onCommit,
}: {
  tag: string;
  position: VersionTagPosition;
  readOnly: boolean;
  onCommit: (patch: { versionTag?: string; versionTagPosition?: VersionTagPosition }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag);
  useEffect(() => setDraft(tag), [tag]);

  if (!editing || readOnly) {
    return (
      <button
        type="button"
        className={`as-version-tag${readOnly ? " as-version-tag--static" : ""}`}
        onClick={readOnly ? undefined : () => setEditing(true)}
        title={readOnly ? undefined : "Edit the version tag"}
      >
        {tag}
      </button>
    );
  }
  const commit = () => {
    onCommit({ versionTag: draft.trim() || undefined });
    setEditing(false);
  };
  return (
    <span className="as-version-tag as-version-tag--editing">
      <input
        className="as-input as-version-tag__input"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            setDraft(tag);
            setEditing(false);
          }
          event.stopPropagation();
        }}
        aria-label="Version tag"
      />
      <select
        className="as-select as-version-tag__corner"
        value={position}
        onChange={(event) => onCommit({ versionTagPosition: event.target.value as VersionTagPosition })}
        aria-label="Version tag corner"
        title="Which corner the tag sits in"
      >
        {VERSION_TAG_POSITIONS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button type="button" className="as-btn as-btn--icon" onClick={commit} aria-label="Done editing version tag">
        ✓
      </button>
    </span>
  );
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/**
 * The little outlined chip showing when an element lands.
 *
 * One component for every surface that carries a date — architecture nodes,
 * group labels, annotations, zone headers, sequence participants — so the
 * abbreviation rule ("Mar 14", and the year only once it stops being this
 * year) is decided in exactly one place. The `title` always spells the full
 * date out, because the abbreviation deliberately drops information.
 */
export function DateChip({
  date,
  inline = false,
  prefix,
  overdue = false,
}: {
  date?: DiagramDate;
  /** Flow beside a label instead of stacking under it. */
  inline?: boolean;
  /** Wording for the tooltip, e.g. "Due". Defaults to a bare date. */
  prefix?: string;
  /**
   * The date is past but the element hasn't become active — the one moment
   * this chip needs to be louder than grey. Compute with `isOverdue`.
   */
  overdue?: boolean;
}) {
  if (!date) return null;
  const full = formatDiagramDate(date, { year: "always" });
  const label = prefix ? `${prefix} ${full}` : full;
  return (
    <span
      className={`as-date${inline ? " as-date--inline" : ""}${overdue ? " as-date--overdue" : ""}`}
      title={overdue ? `${label} — overdue` : label}
    >
      {formatDiagramDate(date)}
    </span>
  );
}

/**
 * The timeline scrubber bar, shared by both editors.
 *
 * The cursor is a DATE, not a stop index — scrubbing is continuous over days,
 * so "what did this look like on the 20th of April" is answerable even though
 * nothing is dated then. The stops still matter: each gets a tick, and the
 * handle SNAPS to one whenever it comes within a few pixels, so landing
 * exactly on a real date stays effortless while the space between them stays
 * reachable.
 *
 * Snapping is specified in pixels and converted to days against the measured
 * track, so the pull feels identical whether the plan spans a month or a
 * decade — a fixed day threshold would be unusably sticky on one and useless
 * on the other.
 *
 * A real `<input type="range">` under a transparent layer does the dragging:
 * pointer capture, arrow keys, Home/End, and screen-reader announcement all
 * come free, and none of it has to be re-implemented.
 */

/** How close, in pixels, the handle must come to a stop before it snaps. */
const SNAP_PX = 11;
/** How close the pointer must come to a tick before it previews landing there. */
const HOVER_PX = 14;

export function TimelineScrubber({
  timeline,
  at,
  onScrub,
  futureMode,
  onFutureMode,
  futureCount,
  onExit,
  /** Shown in the hanging tab: new elements will be stamped with the cursor. */
  stampNotice,
}: {
  timeline: Timeline;
  /** The cursor. May sit between stops, or outside them entirely. */
  at: DiagramDate;
  onScrub: (date: DiagramDate) => void;
  futureMode: TimelineFutureMode;
  onFutureMode: (mode: TimelineFutureMode) => void;
  /** Elements still ahead of the cursor, for the "N ahead" readout. */
  futureCount: number;
  onExit: () => void;
  stampNotice?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverStop, setHoverStop] = useState<DiagramDate | null>(null);
  const [picking, setPicking] = useState(false);

  const stops = timeline.stops;
  const cursorDay = dateToDay(at);
  // The domain always contains the cursor: a date typed into the picker may
  // sit outside the plan entirely, and the handle still has to represent it.
  const minDay = Math.min(cursorDay, stops.length ? dateToDay(stops[0]) : cursorDay);
  const maxDay = Math.max(cursorDay, stops.length ? dateToDay(stops[stops.length - 1]) : cursorDay);
  const span = Math.max(1, maxDay - minDay);
  const percentOf = (day: number) => ((day - minDay) / span) * 100;

  /** Pixel threshold → days, measured against the track as it is right now. */
  const daysFor = (px: number) => {
    const width = trackRef.current?.offsetWidth ?? 0;
    return width > 0 ? (px * span) / width : 0;
  };

  const scrubTo = (day: number) => {
    const raw = dayToDate(day);
    onScrub(nearestStop(timeline, raw, daysFor(SNAP_PX)) ?? raw);
  };

  /** Step to the next real stop in a direction — what the arrows are for. */
  const stepStop = (direction: 1 | -1) => {
    const next =
      direction === 1
        ? stops.find((s) => dateToDay(s) > cursorDay)
        : [...stops].reverse().find((s) => dateToDay(s) < cursorDay);
    if (next) onScrub(next);
  };

  const prevStop = stops.some((s) => dateToDay(s) < cursorDay);
  const nextStop = stops.some((s) => dateToDay(s) > cursorDay);
  const onStop = stops.includes(at);

  return (
    <div className="as-timeline" role="group" aria-label="Timeline scrubber">
      <span className="as-timeline__caption">Timeline</span>

      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => stepStop(-1)}
        disabled={!prevStop}
        title="Previous dated point"
        aria-label="Previous dated point"
      >
        ◀
      </button>

      <div
        className="as-timeline__track"
        ref={trackRef}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) return;
          const day = minDay + ((event.clientX - rect.left) / rect.width) * span;
          setHoverStop(nearestStop(timeline, dayToDate(day), daysFor(HOVER_PX)));
        }}
        onPointerLeave={() => setHoverStop(null)}
      >
        <div className="as-timeline__rail" />
        <div className="as-timeline__buffer" style={{ width: `${percentOf(cursorDay)}%` }} />
        {stops.map((stop) => (
          <div
            key={stop}
            className={`as-timeline__tick${dateToDay(stop) <= cursorDay ? " as-timeline__tick--past" : ""}${
              hoverStop === stop ? " as-timeline__tick--hot" : ""
            }`}
            style={{ left: `${percentOf(dateToDay(stop))}%` }}
            title={formatDiagramDate(stop, { year: "always" })}
          />
        ))}
        {/* Where the handle would land if released here. Its twin is the
            `--ghosting` class below, which fades the real handle so the two
            read as one move rather than two dots. */}
        {hoverStop && hoverStop !== at ? (
          <div
            className="as-timeline__ghostdot"
            style={{ left: `${percentOf(dateToDay(hoverStop))}%` }}
            aria-hidden="true"
          />
        ) : null}
        <input
          className={`as-timeline__range${hoverStop && hoverStop !== at ? " as-timeline__range--ghosting" : ""}`}
          type="range"
          min={minDay}
          max={maxDay}
          step={1}
          value={cursorDay}
          onChange={(event) => scrubTo(Number(event.target.value))}
          // The editors bind arrow keys globally; the slider must keep them.
          onKeyDown={(event) => event.stopPropagation()}
          aria-label="Scrub to a date"
          aria-valuetext={formatDiagramDate(at, { year: "always" })}
        />
      </div>

      {picking ? (
        <input
          className="as-input as-timeline__picker"
          type="date"
          value={at}
          autoFocus
          onChange={(event) => {
            const next = normalizeDate(event.target.value);
            if (next) onScrub(next);
          }}
          onBlur={() => setPicking(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") setPicking(false);
            event.stopPropagation();
          }}
          aria-label="Jump to a date"
        />
      ) : (
        <button
          type="button"
          className={`as-timeline__date${onStop ? " as-timeline__date--onstop" : ""}`}
          onClick={() => setPicking(true)}
          title="Jump to a specific date"
        >
          {formatDiagramDate(at, { year: "always" })}
        </button>
      )}

      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => stepStop(1)}
        disabled={!nextStop}
        title="Next dated point"
        aria-label="Next dated point"
      >
        ▶
      </button>

      <span className="as-timeline__ahead">
        {futureCount === 0 ? "all here" : `${futureCount} ahead`}
      </span>

      <span className="as-zone__toggle" role="group" aria-label="How to treat later elements">
        {TIMELINE_FUTURE_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`as-zone__seg${futureMode === mode ? " as-zone__seg--on" : ""}`}
            style={futureMode === mode ? { background: "var(--as-accent)" } : undefined}
            aria-pressed={futureMode === mode}
            onClick={() => onFutureMode(mode)}
            title={
              mode === "dim"
                ? "Show what is still to come, greyed out"
                : "Leave out everything that has not landed yet"
            }
          >
            {mode === "dim" ? "Ghost later" : "Hide later"}
          </button>
        ))}
      </span>

      <button type="button" className="as-btn" onClick={onExit}>
        Exit timeline
      </button>

      {/* Hangs off the bottom edge of the bar — rounded only where it leaves
          the bar, so it reads as part of it rather than a floating chip. */}
      {/* Visually informative, aurally decorative: the slider's aria-valuetext
          is the one announcer per scrub tick — this repeating the date (and
          the date button doing so too) made every drag a triple broadcast. */}
      {stampNotice ? (
        <span className="as-timeline__stamp">
          New elements dated {formatDiagramDate(at, { year: "always" })}
        </span>
      ) : null}
    </div>
  );
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** One document in the host's workspace. The editor never stores these. */
export interface StudioFile {
  id: string;
  name: string;
  /** Badge shown in the menu — e.g. "arch" / "seq". The host decides. */
  kind?: string;
  /**
   * True when the document has nothing in it. Deleting an empty file happens
   * immediately; anything else asks first. Absent counts as NOT empty, so the
   * safe path (confirm) is the default when a host doesn't compute this.
   */
  empty?: boolean;
}

/**
 * Optional seed for `onFileCreate`. The "＋ New file" menu item passes nothing;
 * the welcome modal passes a name and (when JSON was inserted) a validated
 * document, so a host can create the file already filled in. Every field is
 * optional and the whole argument may be absent — zero-arg hosts keep working.
 */
export interface StudioFileInit {
  name?: string;
  /** "architecture" | "sequence" — absent means "same kind as the active file". */
  kind?: string;
  /** A validated template/sequence document to seed the file with. */
  doc?: unknown;
}

/**
 * A window-centred dialog over a dimmed canvas. Escape and a backdrop click
 * both dismiss, so nothing can trap the user behind it.
 */
export function Modal({
  title,
  onClose,
  children,
  cardClassName,
  hideTitle,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra class on the card — e.g. the welcome modal's wide variant. */
  cardClassName?: string;
  /** Skip the visible heading; `title` still labels the dialog for AT. */
  hideTitle?: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="as-modal" onPointerDown={onClose}>
      <div
        className={`as-modal__card${cardClassName ? ` ${cardClassName}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {hideTitle ? null : <h2 className="as-modal__title">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/**
 * The `?` sheet: every binding the editor answers to, in one place.
 *
 * Written as data rather than markup so the same list can be asserted against
 * in tests — a shortcut that stops working should also stop being advertised.
 * `mod` renders as ⌘ on a Mac and Ctrl elsewhere, decided once here rather
 * than by each row.
 */
export type ShortcutGroup = {
  title: string;
  items: ReadonlyArray<[keys: string, description: string]>;
};

export const SHORTCUT_GROUPS: Record<"architecture" | "sequence", ReadonlyArray<ShortcutGroup>> = {
  architecture: [
    {
      title: "Essentials",
      items: [
        ["mod+Z", "Undo"],
        ["mod+⇧+Z", "Redo"],
        ["mod+S", "Save"],
        ["mod+A", "Select all"],
        ["Delete", "Delete selection (cascades into groups)"],
        ["Esc", "Close panels · leave a drilled level"],
        ["?", "This sheet"],
      ],
    },
    {
      title: "Clipboard",
      items: [
        ["mod+C", "Copy"],
        ["mod+V", "Paste"],
        ["mod+X", "Cut"],
        ["mod+D", "Duplicate, keeping connections"],
        ["Alt+drag", "Drag a copy, leaving the original"],
      ],
    },
    {
      title: "Insert",
      items: [
        ["N", "Node"],
        ["G", "Group"],
        ["T", "Text note"],
        ["Z", "Zone"],
      ],
    },
    {
      title: "Arrange",
      items: [
        ["←↑→↓", "Nudge 1px"],
        ["⇧+←↑→↓", "Nudge 10px"],
        ["mod+⇧+←↑→↓", "Align selection"],
        ["mod+G", "Group selection into a container"],
        ["mod+⇧+G", "Ungroup"],
        ["mod+⇧+L", "Lock / unlock"],
        ["mod+] / mod+[", "Zone forward / backward"],
        ["mod+⇧+] / mod+⇧+[", "Zone to front / to back"],
      ],
    },
    {
      title: "View",
      items: [
        ["mod+= / mod+-", "Zoom in / out"],
        ["mod+0", "Reset zoom"],
        ["⇧+1", "Zoom to fit"],
        ["⇧+2", "Zoom to selection"],
        ["mod+'", "Snap to grid"],
        ["mod+K", "Search"],
        ["mod+⇧+E", "Export PNG"],
        ["Space+drag", "Pan"],
      ],
    },
  ],
  // Sequence mode has no grouping, no zones and no free placement, so those
  // rows are absent rather than listed against a no-op.
  sequence: [
    {
      title: "Essentials",
      items: [
        ["mod+Z", "Undo"],
        ["mod+⇧+Z", "Redo"],
        ["mod+S", "Save"],
        ["mod+A", "Select all"],
        ["Delete", "Delete selection"],
        ["Esc", "Close panels"],
        ["?", "This sheet"],
      ],
    },
    {
      title: "Insert",
      items: [
        ["N", "Participant"],
        ["A", "Actor"],
        ["M", "Message"],
        ["T", "Note"],
      ],
    },
    {
      title: "View",
      items: [
        ["mod+= / mod+-", "Zoom in / out"],
        ["mod+0", "Reset zoom"],
        ["⇧+1", "Zoom to fit"],
        ["←/→", "Step the timeline"],
        ["Space+drag", "Pan"],
      ],
    },
  ],
};

export function ShortcutsModal({
  mode = "architecture",
  onClose,
}: {
  mode?: "architecture" | "sequence";
  onClose: () => void;
}) {
  const render = (combo: string) =>
    combo.split(" / ").map((part) => part.replace(/mod/g, isMac() ? "⌘" : "Ctrl").replace(/\+/g, " "));

  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} cardClassName="as-modal__card--shortcuts">
      <div className="as-shortcuts">
        {SHORTCUT_GROUPS[mode].map((group) => (
          <section key={group.title} className="as-shortcuts__group">
            <h3 className="as-shortcuts__caption">{group.title}</h3>
            <dl className="as-shortcuts__list">
              {group.items.map(([combo, description]) => (
                <div key={combo} className="as-shortcuts__row">
                  <dt className="as-shortcuts__keys">
                    {render(combo).map((part, i) => (
                      <kbd key={i} className="as-kbd">
                        {part}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="as-shortcuts__desc">{description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/**
 * The file selector that replaces the brand when a host supplies `files`.
 * Switching, creating, rename, delete, and restore all call back into the
 * host — the editor owns none of the storage. Slots into the editor's single
 * open-menu system like every other toolbar dropdown.
 *
 * Deleting a file that still has content opens a confirmation first; the
 * host's removed-files list (if any) is reachable from the menu footer, so a
 * mistaken delete is recoverable rather than final.
 */
export function FileMenu({
  files,
  activeFileId,
  open,
  onToggle,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  removedFiles,
  onFileRestore,
}: {
  files: StudioFile[];
  activeFileId?: string;
  open: boolean;
  onToggle: () => void;
  onSelect?: (id: string) => void;
  onCreate?: (init?: StudioFileInit) => void;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
  /** Recently deleted documents the host still holds, newest first. */
  removedFiles?: StudioFile[];
  onFileRestore?: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<StudioFile | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const active = files.find((f) => f.id === activeFileId) ?? files[0];

  const commitRename = (id: string) => {
    const name = draft.trim();
    if (name) onRename?.(id, name);
    setRenaming(null);
  };

  /** Empty files go quietly; anything with content asks first. */
  const requestDelete = (file: StudioFile) => {
    if (file.empty === true) {
      onDelete?.(file.id);
      return;
    }
    onToggle();
    setPendingDelete(file);
  };

  return (
    <div className="as-menu-wrap">
      <button
        type="button"
        className={`as-btn as-filemenu__button${open ? " as-btn--on" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Files — switch, create, rename, delete"
      >
        <span className="as-filemenu__name">{active?.name ?? "Untitled"}</span> ▾
      </button>
      {open ? (
        <div className="as-menu as-menu--left" role="menu">
          {files.map((file) =>
            renaming === file.id ? (
              <div key={file.id} className="as-filemenu__row as-filemenu__row--editing">
                <input
                  className="as-input as-filemenu__rename"
                  value={draft}
                  autoFocus
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => commitRename(file.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename(file.id);
                    if (event.key === "Escape") setRenaming(null);
                    event.stopPropagation();
                  }}
                  aria-label="File name"
                />
              </div>
            ) : (
              <div
                key={file.id}
                className={`as-filemenu__row${file.id === activeFileId ? " as-filemenu__row--active" : ""}`}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="as-filemenu__select"
                  onClick={() => onSelect?.(file.id)}
                  title={`Open ${file.name}`}
                >
                  <span className="as-filemenu__label">{file.name}</span>
                  {file.kind ? <span className="as-filemenu__kind">{file.kind}</span> : null}
                </button>
                {onRename ? (
                  // A dedicated affordance: a double-click can't work here,
                  // because the first click selects and closes the menu.
                  <button
                    type="button"
                    className="as-btn as-btn--icon as-filemenu__rename-btn"
                    onClick={() => {
                      setDraft(file.name);
                      setRenaming(file.id);
                    }}
                    aria-label={`Rename ${file.name}`}
                    title={`Rename ${file.name}`}
                  >
                    ✎
                  </button>
                ) : null}
                {/* Deleting the last file is allowed — the editor greets the
                    resulting empty workspace with the welcome modal. */}
                {onDelete ? (
                  <button
                    type="button"
                    className="as-btn as-btn--icon as-filemenu__delete"
                    onClick={() => requestDelete(file)}
                    aria-label={`Delete ${file.name}`}
                    title={`Delete ${file.name}`}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ),
          )}
          {onCreate ? (
            // Wrapped so the click event doesn't leak into the init argument.
            <button type="button" role="menuitem" className="as-menu__item" onClick={() => onCreate()}>
              <div className="as-menu__label">＋ New file</div>
            </button>
          ) : null}
          {removedFiles?.length && onFileRestore ? (
            <button
              type="button"
              role="menuitem"
              className="as-menu__item"
              onClick={() => {
                onToggle();
                setShowRemoved(true);
              }}
            >
              <div className="as-menu__label">🗑 Recently removed…</div>
              <div className="as-menu__hint">
                {removedFiles.length} recoverable file{removedFiles.length === 1 ? "" : "s"}
              </div>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Modals live outside the dropdown — it closes when they open. */}
      {pendingDelete ? (
        <Modal title={`Delete ${pendingDelete.name}?`} onClose={() => setPendingDelete(null)}>
          <p className="as-modal__body">
            <strong>{pendingDelete.name}</strong> still has content. You can restore it
            afterwards from <em>Recently removed</em>.
          </p>
          <div className="as-modal__actions">
            <button type="button" className="as-btn" onClick={() => setPendingDelete(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="as-btn as-btn--danger"
              onClick={() => {
                onDelete?.(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete file
            </button>
          </div>
        </Modal>
      ) : null}

      {showRemoved ? (
        <Modal title="Recently removed" onClose={() => setShowRemoved(false)}>
          {removedFiles?.length ? (
            <div className="as-modal__list">
              {removedFiles.map((file) => (
                <div key={file.id} className="as-modal__row">
                  <span className="as-filemenu__label">{file.name}</span>
                  {file.kind ? <span className="as-filemenu__kind">{file.kind}</span> : null}
                  <button
                    type="button"
                    className="as-btn"
                    onClick={() => onFileRestore?.(file.id)}
                    aria-label={`Restore ${file.name}`}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="as-modal__body">Everything has been restored.</p>
          )}
          <div className="as-modal__actions">
            <button type="button" className="as-btn" onClick={() => setShowRemoved(false)}>
              Close
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * A captioned cluster in the floating inspector bar. Related controls sit
 * behind one tiny uppercase caption and a hairline divider, so the bar reads
 * as labelled sections instead of an unbroken run of inputs.
 */
export function InspectorSection({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <span className="as-inspector__section" role="group" aria-label={caption}>
      <span className="as-inspector__caption">{caption}</span>
      {children}
    </span>
  );
}

// ─── Drill breadcrumbs ───────────────────────────────────────────────────────

/** C4 level names by drill depth. Depth 0 (the root) never shows the bar. */
const LEVEL_LABELS = ["C1 · Context", "C2 · Containers", "C3 · Components", "C4 · Code"];

export function levelLabel(depth: number): string {
  return depth < LEVEL_LABELS.length ? LEVEL_LABELS[depth] : "C4+ · Code";
}

export interface BreadcrumbEntry {
  /** null marks the root crumb (no focus). */
  id: string | null;
  label: string;
}

/**
 * The drill-in bar: where you are (root ▸ … ▸ focus), how deep in C4 terms,
 * and the way out. Same chrome contract as the compare bar and the timeline
 * scrubber — a mode is active, so the bar says so and carries its own exit.
 */
export function Breadcrumbs({
  path,
  onNavigate,
  onExit,
}: {
  /** [0] is the root entry; the last entry is the current focus. */
  path: BreadcrumbEntry[];
  /** Clicking crumb `i` drills to that level (`i === 0` exits to the root). */
  onNavigate: (index: number) => void;
  onExit: () => void;
}) {
  const depth = path.length - 1;
  return (
    <nav className="as-focusbar" aria-label="Diagram level">
      {path.map((entry, i) => (
        <span key={`${entry.id ?? "root"}-${i}`} className="as-focusbar__crumbwrap">
          {i > 0 ? (
            <span className="as-focusbar__sep" aria-hidden="true">
              ›
            </span>
          ) : null}
          <button
            type="button"
            className={`as-focusbar__crumb${i === path.length - 1 ? " as-focusbar__crumb--here" : ""}`}
            onClick={() => onNavigate(i)}
            disabled={i === path.length - 1}
            title={i === path.length - 1 ? undefined : `Back to ${entry.label}`}
          >
            {entry.label}
          </button>
        </span>
      ))}
      <span
        className="as-focusbar__level"
        title="C4 model level — each drill-in is one level of decomposition"
      >
        {levelLabel(depth)}
      </span>
      <span className="as-focusbar__spacer" />
      <button type="button" className="as-btn" onClick={onExit}>
        Exit focus
      </button>
    </nav>
  );
}
