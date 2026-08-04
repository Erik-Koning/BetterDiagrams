/**
 * ExportStatesModal — "which states?" for PNG/SVG/PDF exports.
 *
 * A document with switchable zones or a timeline is many pictures; a snapshot
 * export has to pick. The modal offers the three answers — what's on screen,
 * everything, or a chosen subset — and, for PDF, whether the states become
 * pages of one file or files of their own.
 *
 * The custom section stays visible (greyed) in the other modes: seeing the
 * axes is what teaches a first-time user what "all states" even means, and
 * keeping it mounted stops the card from changing height as modes switch.
 */
import { useMemo, useState } from "react";

import {
  countStateCombos,
  enumerateStateCombos,
  comboSlug,
  type StateAxes,
  type StateCombo,
  type StateSelection,
} from "../contract/states";
import { formatDiagramDate, type DiagramDate } from "../contract/timeline";
import { Modal } from "./chrome";
import { providerDef, type ResolvedRegistry } from "./registry-types";
import type { PdfLayout, StateExportFormat } from "./state-export";

/** Anything past this is a mistake, not an export — refuse rather than hang. */
const MAX_COMBOS = 200;
/** Past this, the count line turns cautionary but the export still runs. */
const WARN_COMBOS = 30;

export type ExportStatesChoice =
  | { kind: "current" }
  | { kind: "combos"; combos: StateCombo[]; pdfLayout: PdfLayout };

type Mode = "current" | "all" | "custom";

export function ExportStatesModal({
  format,
  axes,
  registry,
  filename,
  onCancel,
  onConfirm,
}: {
  format: StateExportFormat;
  axes: StateAxes;
  registry: ResolvedRegistry;
  /** Base filename, no extension — the count line previews the output name. */
  filename: string;
  onCancel: () => void;
  onConfirm: (choice: ExportStatesChoice) => void;
}) {
  const [mode, setMode] = useState<Mode>("current");
  const [providers, setProviders] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(axes.zones.map((z) => [z.zoneId, [...z.providers]])),
  );
  const [stops, setStops] = useState<DiagramDate[]>(() => [...axes.stops]);
  const [pdfLayout, setPdfLayout] = useState<PdfLayout>("single");

  const selection: StateSelection | undefined = mode === "all" ? undefined : { providers, stops };
  const count = mode === "current" ? 1 : countStateCombos(axes, selection);
  const blocked = mode !== "custom" ? false : count === 0 || count > MAX_COMBOS;

  const toggle = (zoneId: string, provider: string) => {
    setProviders((prev) => {
      const current = prev[zoneId] ?? [];
      const next = current.includes(provider)
        ? current.filter((p) => p !== provider)
        : [...current, provider];
      return { ...prev, [zoneId]: next };
    });
  };
  const toggleStop = (stop: DiagramDate) => {
    setStops((prev) =>
      prev.includes(stop) ? prev.filter((s) => s !== stop) : [...prev, stop],
    );
  };

  const countLine = useMemo(() => {
    if (mode === "current") return `1 file → ${filename}.${format}`;
    if (count === 0) return "Select at least one option in every group";
    if (count > MAX_COMBOS) return `${count} states — too many; narrow the selection`;
    if (format === "pdf" && pdfLayout === "single") {
      return `${count} page${count === 1 ? "" : "s"} → ${filename}-states.pdf`;
    }
    if (count === 1) {
      const combo = enumerateStateCombos(axes, selection)[0];
      return `1 file → ${filename}${combo ? comboSlug(axes, combo) : ""}.${format}`;
    }
    return `${count} files → ${filename}-states.zip`;
  }, [mode, count, format, pdfLayout, filename, axes, selection]);

  const confirm = () => {
    if (mode === "current") {
      onConfirm({ kind: "current" });
      return;
    }
    onConfirm({ kind: "combos", combos: enumerateStateCombos(axes, selection), pdfLayout });
  };

  return (
    <Modal title={`Export ${format.toUpperCase()}`} onClose={onCancel}>
      <div
        className="as-export-states__modes"
        role="radiogroup"
        aria-label="Which states to export"
      >
        <label className="as-check">
          <input
            type="radio"
            name="as-export-states-mode"
            checked={mode === "current"}
            onChange={() => setMode("current")}
          />
          Current state — exactly what's on screen
        </label>
        <label className="as-check">
          <input
            type="radio"
            name="as-export-states-mode"
            checked={mode === "all"}
            onChange={() => setMode("all")}
          />
          All states — every combination
        </label>
        <label className="as-check">
          <input
            type="radio"
            name="as-export-states-mode"
            checked={mode === "custom"}
            onChange={() => setMode("custom")}
          />
          Custom…
        </label>
      </div>

      <div
        className={`as-export-states__custom${
          mode === "custom" ? "" : " as-export-states__custom--off"
        }`}
      >
        {axes.zones.map((zone) => (
          <fieldset
            key={zone.zoneId}
            className="as-export-states__axis"
            disabled={mode !== "custom"}
          >
            <legend className="as-export-states__axis-title">{zone.label}</legend>
            <div className="as-export-states__options">
              {zone.providers.map((provider) => (
                <label className="as-check" key={provider}>
                  <input
                    type="checkbox"
                    checked={(providers[zone.zoneId] ?? []).includes(provider)}
                    onChange={() => toggle(zone.zoneId, provider)}
                  />
                  {providerDef(registry, provider).label}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {axes.stops.length > 0 ? (
          <fieldset className="as-export-states__axis" disabled={mode !== "custom"}>
            <legend className="as-export-states__axis-title">Dates</legend>
            <div className="as-export-states__options">
              {axes.stops.map((stop) => (
                <label className="as-check" key={stop}>
                  <input
                    type="checkbox"
                    checked={stops.includes(stop)}
                    onChange={() => toggleStop(stop)}
                  />
                  {formatDiagramDate(stop, { year: "always" })}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>

      {format === "pdf" ? (
        <div
          className={`as-export-states__pdf${
            mode === "current" ? " as-export-states__custom--off" : ""
          }`}
          role="radiogroup"
          aria-label="PDF layout"
        >
          <label className="as-check">
            <input
              type="radio"
              name="as-export-states-pdf"
              disabled={mode === "current"}
              checked={pdfLayout === "single"}
              onChange={() => setPdfLayout("single")}
            />
            One PDF, one page per state
          </label>
          <label className="as-check">
            <input
              type="radio"
              name="as-export-states-pdf"
              disabled={mode === "current"}
              checked={pdfLayout === "separate"}
              onChange={() => setPdfLayout("separate")}
            />
            One PDF per state (.zip)
          </label>
        </div>
      ) : null}

      <p
        className={`as-export-states__count${
          !blocked && count > WARN_COMBOS ? " as-export-states__count--warn" : ""
        }`}
        aria-live="polite"
      >
        {countLine}
      </p>

      <div className="as-modal__actions">
        <button type="button" className="as-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="as-btn as-btn--primary" disabled={blocked} onClick={confirm}>
          Export
        </button>
      </div>
    </Modal>
  );
}
