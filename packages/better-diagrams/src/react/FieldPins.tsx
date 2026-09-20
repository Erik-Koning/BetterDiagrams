/**
 * FieldPins.tsx — the strip of pinned fields above the canvas.
 *
 * A pin is a field the reader has marked to come back to: a chip per pin
 * (click = go to the field), a way off for each, Clear, and — once two are
 * pinned — Show paths, which opens the path panel. Pure presentational: the
 * pins themselves are the studio's view state.
 */
import type { Pin } from "../contract/fields";
import { fieldKey } from "../contract/fields";

export interface PinStripProps {
  pins: readonly Pin[];
  /** "Account · AccountId" — the node's label and the field's name; a table pin is the label alone. */
  labelOf: (ref: Pin) => string;
  onJump: (ref: Pin) => void;
  onRemove: (ref: Pin) => void;
  onClear: () => void;
  pathsOpen: boolean;
  onTogglePaths: () => void;
}

export function PinStrip({ pins, labelOf, onJump, onRemove, onClear, pathsOpen, onTogglePaths }: PinStripProps) {
  return (
    <div className="as-pinstrip" role="toolbar" aria-label="Pinned fields">
      <span className="as-pinstrip__caption">
        {pins.length} pinned
      </span>
      <div className="as-pinstrip__chips">
        {pins.map((pin) => {
          const label = labelOf(pin);
          return (
            <span key={fieldKey(pin)} className="as-pinstrip__chip">
              <button
                type="button"
                className="as-chip as-chip--on as-pinstrip__jump"
                title={`Go to ${label}`}
                onClick={() => onJump(pin)}
              >
                {label}
              </button>
              <button
                type="button"
                className="as-chip as-chip--on as-pinstrip__x"
                aria-label={`Unpin ${label}`}
                title="Unpin"
                onClick={() => onRemove(pin)}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <button
        type="button"
        className={`as-btn${pathsOpen ? " as-btn--on" : ""}`}
        disabled={pins.length < 2}
        aria-pressed={pathsOpen}
        title={pins.length < 2 ? "Pin a second field to search for paths" : "Routes between the pinned fields"}
        onClick={onTogglePaths}
      >
        Show paths
      </button>
      <button type="button" className="as-btn" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
