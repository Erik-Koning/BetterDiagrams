/**
 * FieldGridModal.tsx — every field of one node, as a grid.
 *
 * Read-only on purpose: the rows a diagram draws are edited in the
 * inspector, and the rest belongs to whatever generated the document. What
 * the grid adds is the view a spreadsheet gives — sort by any column, filter,
 * drag a column wider, walk the rows with the keyboard, copy the table out
 * or download it — plus the two things a spreadsheet can't: follow a
 * reference to its table, and pin a field for a path search.
 *
 * Hand-rolled; the package takes no dependencies.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { DiagramNode, DiagramTemplate } from "../contract/schema";
import { fieldKey, fieldRecords, type FieldRecord, type FieldRef } from "../contract/fields";
import { Modal } from "./chrome";
import { copyText } from "./copy-text";
import {
  GRID_COLUMNS,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  cellText,
  fileSlug,
  filterRecords,
  sortRecords,
  toCsv,
  toTsv,
  type GridColumn,
} from "./field-grid";

export interface FieldGridModalProps {
  node: DiagramNode;
  /** The document the node lives in — references resolve against it. */
  doc: DiagramTemplate;
  /** Open scrolled to, and with the cursor on, this field. */
  initialFieldId?: string;
  /** Base name for the CSV download. */
  filename: string;
  pins: readonly FieldRef[];
  onTogglePin: (ref: FieldRef) => void;
  /** Follow a reference: the parent closes the grid and goes to the table. */
  onNavigate: (nodeId: string) => void;
  /** Hand the reader a file — the editor's download helper. */
  onDownload: (blob: Blob, filename: string) => void;
  onClose: () => void;
}

type Sort = { col: GridColumn; dir: "asc" | "desc" } | null;

const PIN_COLUMN_WIDTH = 36;
const PAGE = 20;

export function FieldGridModal({
  node,
  doc,
  initialFieldId,
  filename,
  pins,
  onTogglePin,
  onNavigate,
  onDownload,
  onClose,
}: FieldGridModalProps) {
  const records = useMemo(() => fieldRecords(node, doc), [node, doc]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [widths, setWidths] = useState<Record<GridColumn, number>>(
    () => Object.fromEntries(GRID_COLUMNS.map((c) => [c.id, c.width])) as Record<GridColumn, number>,
  );
  const [activeId, setActiveId] = useState<string | null>(initialFieldId ?? null);
  const [copied, setCopied] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const filtered = filterRecords(records, query);
    return sort ? sortRecords(filtered, sort.col, sort.dir) : filtered;
  }, [records, query, sort]);
  const pinned = useMemo(() => new Set(pins.map(fieldKey)), [pins]);

  // The row the grid opened on: scrolled into view once, when it exists.
  useEffect(() => {
    if (!initialFieldId) return;
    const row = tableRef.current?.querySelector<HTMLElement>(`tr[data-field-id="${cssAttr(initialFieldId)}"]`);
    row?.scrollIntoView?.({ block: "center" });
  }, [initialFieldId]);

  /** Move the cursor to a row and put keyboard focus on it. */
  const activate = useCallback((id: string | null) => {
    setActiveId(id);
    if (!id) return;
    const row = tableRef.current?.querySelector<HTMLElement>(`tr[data-field-id="${cssAttr(id)}"]`);
    row?.focus({ preventScroll: false });
  }, []);

  const cycleSort = (col: GridColumn) =>
    setSort((current) =>
      current?.col !== col ? { col, dir: "asc" } : current.dir === "asc" ? { col, dir: "desc" } : null,
    );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = activeId ? visible.findIndex((r) => r.id === activeId) : -1;
    const go = (next: number) => {
      const clamped = Math.max(0, Math.min(visible.length - 1, next));
      if (visible[clamped]) activate(visible[clamped].id);
    };
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        go(index + 1);
        break;
      case "ArrowUp":
        go(index <= 0 ? 0 : index - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(visible.length - 1);
        break;
      case "PageDown":
        go(index + PAGE);
        break;
      case "PageUp":
        go(index - PAGE);
        break;
      case "Enter": {
        const target = index >= 0 ? visible[index].fk.find((t) => t.nodeId) : undefined;
        if (target?.nodeId) onNavigate(target.nodeId);
        else handled = false;
        break;
      }
      case "p":
      case "P":
        if (index >= 0 && !event.metaKey && !event.ctrlKey) onTogglePin({ nodeId: node.id, fieldId: visible[index].id });
        else handled = false;
        break;
      case "/":
        filterRef.current?.focus();
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  /** Drag a column edge; pointer capture keeps the drag alive off the header. */
  const startResize = (col: GridColumn) => (event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = widths[col];
    handle.setPointerCapture?.(event.pointerId);
    const move = (e: globalThis.PointerEvent) => {
      const next = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, startWidth + (e.clientX - startX)));
      setWidths((current) => (current[col] === next ? current : { ...current, [col]: next }));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const copy = async () => {
    if (await copyText(toTsv(visible))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };
  const download = () =>
    onDownload(new Blob([toCsv(visible)], { type: "text/csv" }), `${filename}-${fileSlug(node.label)}-fields.csv`);

  const total = records.length;
  return (
    <Modal title={`${node.label} — fields`} onClose={onClose} cardClassName="as-modal__card--grid">
      <div className="as-grid__bar">
        <input
          ref={filterRef}
          className="as-input as-grid__filter"
          type="search"
          placeholder="Filter fields…  ( / )"
          aria-label="Filter fields"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // The filter is a text field: keep the grid's row keys off it,
            // but let ArrowDown hand the cursor to the first row.
            event.stopPropagation();
            if (event.key === "ArrowDown" && visible[0]) {
              event.preventDefault();
              activate(activeId && visible.some((r) => r.id === activeId) ? activeId : visible[0].id);
            }
          }}
        />
        <span className="as-grid__count" aria-live="polite">
          {query ? `${visible.length} / ${total}` : `${total} field${total === 1 ? "" : "s"}`}
        </span>
        <span className="as-grid__spacer" />
        <button type="button" className="as-btn" onClick={() => void copy()} disabled={!visible.length}>
          {copied ? "Copied" : "Copy TSV"}
        </button>
        <button type="button" className="as-btn" onClick={download} disabled={!visible.length}>
          Download CSV
        </button>
        <button type="button" className="as-btn as-btn--outline" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="as-grid__scroll">
        <table ref={tableRef} className="as-grid" role="grid" aria-rowcount={visible.length} aria-label={`${node.label} fields`} onKeyDown={onKeyDown}>
          <colgroup>
            <col style={{ width: PIN_COLUMN_WIDTH }} />
            {GRID_COLUMNS.map((c) => (
              <col key={c.id} style={{ width: widths[c.id] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="as-grid__th as-grid__th--pin" aria-label="Pinned" />
              {GRID_COLUMNS.map((c) => {
                const sorted = sort?.col === c.id ? sort.dir : undefined;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    className={`as-grid__th${c.align === "center" ? " as-grid__th--center" : ""}`}
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                  >
                    <button type="button" className="as-grid__sort" onClick={() => cycleSort(c.id)} title={`Sort by ${c.title}`}>
                      {c.title}
                      {sorted ? <span className="as-grid__arrow" aria-hidden="true">{sorted === "asc" ? "▲" : "▼"}</span> : null}
                    </button>
                    <span
                      className="as-grid__resizer"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${c.title}`}
                      onPointerDown={startResize(c.id)}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((record) => (
              <GridRow
                key={record.id}
                record={record}
                active={record.id === activeId}
                pinned={pinned.has(fieldKey({ nodeId: node.id, fieldId: record.id }))}
                onActivate={() => setActiveId(record.id)}
                onTogglePin={() => onTogglePin({ nodeId: node.id, fieldId: record.id })}
                onNavigate={onNavigate}
              />
            ))}
            {!visible.length ? (
              <tr>
                <td className="as-grid__empty" colSpan={GRID_COLUMNS.length + 1}>
                  {total ? "No field matches the filter" : "This node has no fields"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function GridRow({
  record,
  active,
  pinned,
  onActivate,
  onTogglePin,
  onNavigate,
}: {
  record: FieldRecord;
  active: boolean;
  pinned: boolean;
  onActivate: () => void;
  onTogglePin: () => void;
  onNavigate: (nodeId: string) => void;
}) {
  return (
    <tr
      role="row"
      data-field-id={record.id}
      className={`as-grid__row${active ? " as-grid__row--active" : ""}${record.row ? "" : " as-grid__row--data"}`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onActivate}
      onFocus={onActivate}
    >
      <td className="as-grid__td as-grid__td--center">
        <button
          type="button"
          className={`as-grid__pin${pinned ? " as-grid__pin--on" : ""}`}
          aria-pressed={pinned}
          aria-label={`${pinned ? "Unpin" : "Pin"} ${record.name}`}
          title={pinned ? "Unpin" : "Pin for search"}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
        >
          {pinned ? "★" : "☆"}
        </button>
      </td>
      {GRID_COLUMNS.map((c) => {
        const text = cellText(record, c.id);
        const className = `as-grid__td${c.align === "center" ? " as-grid__td--center" : ""}${c.mono ? " as-grid__td--mono" : ""}`;
        if (c.id === "fk" && record.fk.length) {
          return (
            <td key={c.id} className={className} title={text}>
              {record.fk.map((t, i) => (
                <span key={`${t.nodeId ?? ""}:${t.label}`}>
                  {i > 0 ? " | " : "→ "}
                  {t.nodeId ? (
                    <button
                      type="button"
                      className="as-grid__link"
                      title={`Go to ${t.label}`}
                      aria-label={`Go to ${t.label}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onNavigate(t.nodeId!);
                      }}
                    >
                      {t.label}
                    </button>
                  ) : (
                    t.label
                  )}
                </span>
              ))}
            </td>
          );
        }
        return (
          <td key={c.id} className={className} title={text}>
            {text}
          </td>
        );
      })}
    </tr>
  );
}

/** A field id inside an attribute selector — quotes and backslashes escaped. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
