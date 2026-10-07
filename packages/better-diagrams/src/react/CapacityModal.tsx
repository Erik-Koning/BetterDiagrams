/**
 * CapacityModal — View → Team capacity…: how many story points each person
 * on the plan can take on. Their open points are shown beside the field, so
 * the number is set against what they hold now. Saved to the document's
 * `settings.capacity`, which the People legend and the plan checks read; an
 * empty field means no limit.
 */
import { useState } from "react";
import { Modal } from "./chrome";
import { assigneeSwatch, swatchColor } from "./shapes";
import type { TaskWorkload } from "../contract/tasks";

export interface CapacityModalProps {
  people: readonly TaskWorkload[];
  /** A person's colour, as the legend paints it. */
  colorOf?: (name: string) => string;
  onSave: (capacity: Record<string, number>) => void;
  onClose: () => void;
}

export function CapacityModal({ people, colorOf, onSave, onClose }: CapacityModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(people.map((p) => [p.name, p.capacity !== undefined ? String(p.capacity) : ""])),
  );
  const submit = () => {
    const capacity: Record<string, number> = {};
    for (const [name, raw] of Object.entries(values)) {
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n) && n > 0) capacity[name] = n;
    }
    onSave(capacity);
  };
  return (
    <Modal title="Team capacity" onClose={onClose}>
      <p className="as-modal__body">
        Story points each person can take on. Someone holding more open points than this shows over capacity in the
        People legend and in Checks. Leave a field empty for no limit.
      </p>
      <form
        className="as-capacity"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="as-capacity__rows" role="list" aria-label="Capacity per person">
          {people.map((p) => {
            const value = values[p.name] ?? "";
            const limit = Number.parseFloat(value);
            const over = Number.isFinite(limit) && limit > 0 && p.openPoints > limit;
            return (
              <label key={p.name} className="as-capacity__row" role="listitem">
                <span
                  className="as-capacity__swatch"
                  style={{ background: colorOf?.(p.name) ?? swatchColor(assigneeSwatch(p.name)) }}
                  aria-hidden="true"
                />
                <span className="as-capacity__name">{p.name}</span>
                <span className={`as-capacity__open${over ? " as-capacity__open--over" : ""}`}>
                  {p.openPoints} pts open
                </span>
                <input
                  className="as-input as-capacity__input"
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  placeholder="No limit"
                  value={value}
                  onChange={(event) => setValues((v) => ({ ...v, [p.name]: event.target.value }))}
                  aria-label={`${p.name}'s capacity in story points`}
                />
              </label>
            );
          })}
        </div>
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
