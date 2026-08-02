/**
 * chrome.tsx — the shared editor chrome.
 *
 * Both editors (ArchitectureStudio and SequenceStudio) speak the same UI
 * language: toolbar dropdowns with one open-menu slot, a floating inspector
 * bar of captioned sections, and the corner version-tag chip. These live here
 * so the two stay pixel-identical without either importing the other.
 */
import { useEffect, useState, type ReactNode } from "react";
import { VERSION_TAG_POSITIONS, type VersionTagPosition } from "../contract/schema";
import {
  TIMELINE_FUTURE_MODES,
  formatDiagramDate,
  timelineStop,
  type DiagramDate,
  type Timeline,
  type TimelineFutureMode,
} from "../contract/timeline";

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
}: {
  date?: DiagramDate;
  /** Flow beside a label instead of stacking under it. */
  inline?: boolean;
  /** Wording for the tooltip, e.g. "Due". Defaults to a bare date. */
  prefix?: string;
}) {
  if (!date) return null;
  const full = formatDiagramDate(date, { year: "always" });
  return (
    <span
      className={`as-date${inline ? " as-date--inline" : ""}`}
      title={prefix ? `${prefix} ${full}` : full}
    >
      {formatDiagramDate(date)}
    </span>
  );
}

/**
 * The timeline scrubber bar, shared by both editors.
 *
 * The stops ARE the document's distinct dates, so the bar can only ever land
 * on a date something actually happens — dragging never stops between two
 * frames where nothing changes. A buffer bar fills to the cursor and each stop
 * gets a tick, so the shape of the plan (three things in March, nothing until
 * September) is legible without moving the handle.
 *
 * A real `<input type="range">` under a transparent layer does the dragging:
 * pointer capture, arrow keys, Home/End, and screen-reader announcement all
 * come free, and none of it has to be re-implemented.
 */
export function TimelineScrubber({
  timeline,
  index,
  onIndex,
  futureMode,
  onFutureMode,
  futureCount,
  onExit,
}: {
  timeline: Timeline;
  index: number;
  onIndex: (index: number) => void;
  futureMode: TimelineFutureMode;
  onFutureMode: (mode: TimelineFutureMode) => void;
  /** Elements still ahead of the cursor, for the "N ahead" readout. */
  futureCount: number;
  onExit: () => void;
}) {
  const last = Math.max(0, timeline.stops.length - 1);
  const clamped = Math.max(0, Math.min(last, index));
  const at = timelineStop(timeline, clamped);
  // A single-stop timeline has no span to divide by; pin the fill at the end,
  // which is also true — that one stop is the whole plan.
  const percent = last === 0 ? 100 : (clamped / last) * 100;

  return (
    <div className="as-timeline" role="group" aria-label="Timeline scrubber">
      <span className="as-timeline__caption">Timeline</span>

      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => onIndex(clamped - 1)}
        disabled={clamped === 0}
        title="Previous date"
        aria-label="Previous date"
      >
        ◀
      </button>

      <div className="as-timeline__track">
        <div className="as-timeline__rail" />
        <div className="as-timeline__buffer" style={{ width: `${percent}%` }} />
        {timeline.stops.map((stop, i) => (
          <div
            key={stop}
            className={`as-timeline__tick${i <= clamped ? " as-timeline__tick--past" : ""}`}
            style={{ left: `${last === 0 ? 100 : (i / last) * 100}%` }}
          />
        ))}
        <input
          className="as-timeline__range"
          type="range"
          min={0}
          max={last}
          step={1}
          value={clamped}
          onChange={(event) => onIndex(Number(event.target.value))}
          // The editors bind arrow keys globally; the slider must keep them.
          onKeyDown={(event) => event.stopPropagation()}
          aria-label="Scrub to a date"
          aria-valuetext={at ? formatDiagramDate(at, { year: "always" }) : ""}
        />
      </div>

      <span className="as-timeline__date" aria-live="polite">
        {at ? formatDiagramDate(at, { year: "always" }) : "—"}
      </span>
      <span className="as-timeline__step">
        {clamped + 1}/{timeline.stops.length}
      </span>

      <button
        type="button"
        className="as-btn as-btn--icon"
        onClick={() => onIndex(clamped + 1)}
        disabled={clamped === last}
        title="Next date"
        aria-label="Next date"
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
 * A centred dialog over a dimmed canvas. Escape and a backdrop click both
 * dismiss, so nothing can trap the user behind it.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
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
        className="as-modal__card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 className="as-modal__title">{title}</h2>
        {children}
      </div>
    </div>
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
  onCreate?: () => void;
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
                {onDelete && files.length > 1 ? (
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
            <button type="button" role="menuitem" className="as-menu__item" onClick={onCreate}>
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
