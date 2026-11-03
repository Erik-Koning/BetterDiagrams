/**
 * HtmlSettingsModal — Export → Interactive HTML → Page settings…: how the exported
 * page opens. Lines on hover or all shown, the legend, and for a dated
 * document the timeline bar, the date it opens on, and whether what comes
 * later is ghosted or hidden. Saved to the document's `settings.html*`, so
 * every export of it — from any host, or an agent's — opens the same way;
 * the reader can still change each from the page's ⋯ menu.
 */
import { useState } from "react";
import type {
  DiagramSettings,
  HtmlLater,
  HtmlLegend,
  HtmlLines,
  HtmlTimeline,
  HtmlTimelineDate,
} from "../contract/schema";
import { formatDiagramDate, type DiagramDate } from "../contract/timeline";
import { Modal } from "./chrome";

/** The settings this dialog owns — what `withHtmlSettings` writes. */
export type HtmlSettings = Pick<DiagramSettings, "htmlLines" | "htmlTimeline" | "htmlTimelineDate" | "htmlLater" | "htmlLegend">;

const HTML_KEYS = ["htmlLines", "htmlTimeline", "htmlTimelineDate", "htmlLater", "htmlLegend"] as const;

/**
 * `settings` with the dialog's keys replaced by `next`, a default stored as
 * nothing — so a document that never strays from them carries none — and
 * undefined when nothing is left.
 */
export function withHtmlSettings(settings: DiagramSettings | undefined, next: HtmlSettings): DiagramSettings | undefined {
  const out: DiagramSettings = { ...settings };
  for (const key of HTML_KEYS) delete out[key];
  if (next.htmlLines === "all") out.htmlLines = "all";
  if (next.htmlTimeline === "hide") out.htmlTimeline = "hide";
  if (next.htmlTimelineDate === "first" || next.htmlTimelineDate === "last") out.htmlTimelineDate = next.htmlTimelineDate;
  if (next.htmlLater === "hide") out.htmlLater = "hide";
  if (next.htmlLegend === "hide") out.htmlLegend = "hide";
  return Object.keys(out).length ? out : undefined;
}

/** What each setting comes to, a default for what the document leaves out. */
export function htmlSettingsOf(settings: DiagramSettings | undefined): Required<HtmlSettings> {
  return {
    htmlLines: settings?.htmlLines ?? "hover",
    htmlTimeline: settings?.htmlTimeline ?? "show",
    htmlTimelineDate: settings?.htmlTimelineDate ?? "today",
    htmlLater: settings?.htmlLater ?? "ghost",
    htmlLegend: settings?.htmlLegend ?? "show",
  };
}

/** Whether `next` opens the page as `settings` already does. */
export function sameHtmlSettings(settings: DiagramSettings | undefined, next: HtmlSettings): boolean {
  const was = htmlSettingsOf(settings);
  const now = htmlSettingsOf(next);
  return HTML_KEYS.every((key) => was[key] === now[key]);
}

/** One line for the Export menu: how the page opens now. */
export function htmlSettingsSummary(settings: DiagramSettings | undefined, dated: boolean): string {
  const s = settings ?? {};
  const parts = [s.htmlLines === "all" ? "All lines" : "Lines on hover"];
  if (dated) {
    if (s.htmlTimeline === "hide") parts.push("no timeline bar");
    else parts.push(`timeline on ${s.htmlTimelineDate === "first" ? "the first date" : s.htmlTimelineDate === "last" ? "the last date" : "today"}`);
    parts.push(s.htmlLater === "hide" ? "later hidden" : "later ghosted");
  }
  parts.push(s.htmlLegend === "hide" ? "no legend" : "legend shown");
  return parts.join(" · ");
}

export interface HtmlSettingsModalProps {
  settings: DiagramSettings | undefined;
  /** The document's dates, ascending: none means its page has no timeline. */
  stops: readonly DiagramDate[];
  onSave: (next: HtmlSettings) => void;
  onClose: () => void;
}

export function HtmlSettingsModal({ settings, stops, onSave, onClose }: HtmlSettingsModalProps) {
  const [initial] = useState(() => htmlSettingsOf(settings));
  const [lines, setLines] = useState<HtmlLines>(initial.htmlLines);
  const [timeline, setTimeline] = useState<HtmlTimeline>(initial.htmlTimeline);
  const [date, setDate] = useState<HtmlTimelineDate>(initial.htmlTimelineDate);
  const [later, setLater] = useState<HtmlLater>(initial.htmlLater);
  const [legend, setLegend] = useState<HtmlLegend>(initial.htmlLegend);
  const dated = stops.length > 0;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const day = (d: DiagramDate | undefined) => (d ? formatDiagramDate(d, { year: "always" }) : "");

  return (
    <Modal title="Interactive HTML page settings" onClose={onClose}>
      <p className="as-modal__body">
        How the exported page opens. Saved with the diagram, so every export of it opens this way; a reader can still
        change each from the page's ⋯ menu.
      </p>
      <form
        className="as-html-settings"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ htmlLines: lines, htmlTimeline: timeline, htmlTimelineDate: date, htmlLater: later, htmlLegend: legend });
        }}
      >
        <fieldset className="as-html-settings__group">
          <legend className="as-html-settings__title">Lines</legend>
          <div className="as-html-settings__options" role="radiogroup" aria-label="Lines">
            <label className="as-check">
              <input type="radio" name="as-html-lines" checked={lines === "hover"} onChange={() => setLines("hover")} />
              A box's lines when it is hovered
            </label>
            <label className="as-check">
              <input type="radio" name="as-html-lines" checked={lines === "all"} onChange={() => setLines("all")} />
              Every line shown
            </label>
          </div>
        </fieldset>

        <fieldset className="as-html-settings__group">
          <legend className="as-html-settings__title">Legend</legend>
          <div className="as-html-settings__options">
            <label className="as-check">
              <input
                type="checkbox"
                checked={legend === "show"}
                onChange={() => setLegend(legend === "show" ? "hide" : "show")}
              />
              Show the legend
            </label>
          </div>
        </fieldset>

        {/* Kept on show without dates, greyed, so the dialog says why the
            page has no timeline rather than leaving the reader to wonder. */}
        <fieldset className={`as-html-settings__group${dated ? "" : " as-html-settings__group--off"}`} disabled={!dated}>
          <legend className="as-html-settings__title">Timeline</legend>
          {dated ? null : <p className="as-html-settings__note">This diagram has no dates, so its page has no timeline.</p>}
          <div className="as-html-settings__options">
            <label className="as-check">
              <input
                type="checkbox"
                checked={timeline === "show"}
                onChange={() => setTimeline(timeline === "show" ? "hide" : "show")}
              />
              Show the timeline bar
            </label>
          </div>
          {/* Without the bar the page shows everything, as at the last
              date — there is no date to open on. */}
          <fieldset
            className={`as-html-settings__sub${timeline === "show" || !dated ? "" : " as-html-settings__group--off"}`}
            disabled={!dated || timeline !== "show"}
          >
            <legend className="as-html-settings__label">Opens on</legend>
            <div className="as-html-settings__options" role="radiogroup" aria-label="Opens on">
              <label className="as-check">
                <input type="radio" name="as-html-date" checked={date === "today"} onChange={() => setDate("today")} />
                Today
              </label>
              <label className="as-check">
                <input type="radio" name="as-html-date" checked={date === "first"} onChange={() => setDate("first")} />
                First date{first ? ` (${day(first)})` : ""}
              </label>
              <label className="as-check">
                <input type="radio" name="as-html-date" checked={date === "last"} onChange={() => setDate("last")} />
                Last date{last ? ` (${day(last)})` : ""}
              </label>
            </div>
          </fieldset>
          <fieldset className="as-html-settings__sub" disabled={!dated}>
            <legend className="as-html-settings__label">What comes later</legend>
            <div className="as-html-settings__options" role="radiogroup" aria-label="What comes later">
              <label className="as-check">
                <input type="radio" name="as-html-later" checked={later === "ghost"} onChange={() => setLater("ghost")} />
                Ghosted
              </label>
              <label className="as-check">
                <input type="radio" name="as-html-later" checked={later === "hide"} onChange={() => setLater("hide")} />
                Hidden
              </label>
            </div>
          </fieldset>
        </fieldset>

        <div className="as-modal__actions">
          <button type="button" className="as-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="as-btn as-btn--primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
