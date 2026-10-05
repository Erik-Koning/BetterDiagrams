/**
 * SavedAnalyses.tsx — keeping an analysis with the model, and finding it
 * again.
 *
 * `SaveAnalysisDialog` names one (a title and a note) — to save the open
 * analysis, or to rename a saved one. `SavedAnalysesMenu` is the toolbar's
 * Analyses menu: save the open analysis, then every saved one with what it
 * says now and how far that drifted from when it was saved — open it, rename
 * it, delete it. Presentational: the studio owns the document edits (one
 * undoable commit each) and what opening one does.
 */
import { useState } from "react";
import type { SavedAnalysis } from "../contract/analyses";
import { ANALYSIS_KIND_LABEL } from "../contract/analyses";
import { Modal } from "./chrome";
import { UiIcon } from "./ui-icons";

export interface SaveAnalysisDialogProps {
  heading: string;
  /** What the analysis says now, shown under the heading. */
  headline?: string;
  initialTitle: string;
  initialNote?: string;
  submitLabel: string;
  onSubmit: (title: string, note: string) => void;
  onClose: () => void;
}

export function SaveAnalysisDialog({ heading, headline, initialTitle, initialNote = "", submitLabel, onSubmit, onClose }: SaveAnalysisDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [note, setNote] = useState(initialNote);
  const submit = () => {
    if (!title.trim()) return;
    onSubmit(title.trim(), note.trim());
  };
  return (
    <Modal title={heading} onClose={onClose}>
      {headline ? <p className="as-modal__body">{headline}</p> : null}
      <form
        className="as-analysis-save"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="as-analysis-save__field">
          <span>Title</span>
          <input className="as-input" value={title} autoFocus onChange={(event) => setTitle(event.target.value)} maxLength={200} />
        </label>
        <label className="as-analysis-save__field">
          <span>Note</span>
          <textarea className="as-input" value={note} rows={3} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Why it matters, what to watch for" />
        </label>
        <div className="as-modal__actions">
          <button type="button" className="as-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="as-btn as-btn--primary" disabled={!title.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface SavedAnalysesMenuProps {
  analyses: readonly SavedAnalysis[];
  /** What each says now, and how far that drifted from its snapshot. */
  readings: ReadonlyMap<string, { headline: string; drift: string | null }>;
  /** The open analysis, if one can be saved ("Key usage") — null when none is open. */
  current: string | null;
  canEdit: boolean;
  onSaveCurrent: () => void;
  onOpen: (a: SavedAnalysis) => void;
  onRename: (a: SavedAnalysis) => void;
  onDelete: (a: SavedAnalysis) => void;
}

export function SavedAnalysesMenu({ analyses, readings, current, canEdit, onSaveCurrent, onOpen, onRename, onDelete }: SavedAnalysesMenuProps) {
  return (
    <>
      {canEdit ? (
        <button type="button" role="menuitem" className="as-menu__item" disabled={!current} onClick={onSaveCurrent}>
          <div className="as-menu__label">{current ? `Save ${current.toLowerCase()}…` : "Save this analysis…"}</div>
          <div className="as-menu__hint">
            {current ? "Keep it with the model, to open and re-run later" : "Open key usage, routes, coverage, impact or a neighbourhood first"}
          </div>
        </button>
      ) : null}
      <div className="as-menu__caption">Saved</div>
      {analyses.length ? (
        analyses.map((a) => {
          const reading = readings.get(a.id);
          return (
            <div key={a.id} className="as-analyses__row">
              <button type="button" role="menuitem" className="as-menu__item as-analyses__open" title={a.note} onClick={() => onOpen(a)}>
                <div className="as-menu__label">{a.title}</div>
                <div className="as-menu__hint">
                  {ANALYSIS_KIND_LABEL[a.kind]}
                  {reading ? ` · ${reading.headline}` : ""}
                </div>
                {reading?.drift ? <div className="as-analyses__drift">{reading.drift}</div> : null}
              </button>
              {canEdit ? (
                <>
                  <button type="button" role="menuitem" className="as-btn as-btn--icon" aria-label={`Rename ${a.title}`} title="Rename" onClick={() => onRename(a)}>
                    <UiIcon name="pencil" size={13} />
                  </button>
                  <button type="button" role="menuitem" className="as-btn as-btn--icon" aria-label={`Delete ${a.title}`} title="Delete" onClick={() => onDelete(a)}>
                    <UiIcon name="trash" size={13} />
                  </button>
                </>
              ) : null}
            </div>
          );
        })
      ) : (
        <p className="as-menu__hint as-analyses__empty">Nothing saved yet.</p>
      )}
    </>
  );
}
