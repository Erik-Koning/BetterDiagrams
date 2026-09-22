/**
 * ReferencePanel.tsx — the side panel for one table's (or one field's) keys.
 *
 * Two lists: the keys it carries, each resolved to the key it lands on, and
 * the keys elsewhere that point at it. A row is a jump: a carried key
 * follows the reference (both rows marked, as the row menu does), a
 * referencing key goes to the field that holds it — on whatever level it
 * lives. The subject chip under the title is a jump too, back to what the
 * panel is about. Presentational: the studio owns the pin and the computed
 * view.
 */
import type { FieldRef, KeyLink, KeyReferences, Pin } from "../contract/fields";
import { fieldKey } from "../contract/fields";
import { UiIcon } from "./ui-icons";

export interface ReferencePanelProps {
  pin: Pin;
  view: KeyReferences;
  /** "Account · AccountId" — the node's label and the field's name; a table pin is the label alone. */
  labelOf: (ref: Pin) => string;
  nodeLabel: (id: string) => string;
  /** A carried key: go to the key it lands on, both rows marked. */
  onFollow: (link: KeyLink) => void;
  /** A referencing key: go to the field holding it. */
  onNavigateField: (ref: FieldRef) => void;
  /** The subject chip: go back to the table (or row) the panel is about. */
  onJump: (pin: Pin) => void;
  onClose: () => void;
}

/** More rows than this and the list says how many it left out. */
const LIST_CAP = 500;

export function ReferencePanel({ pin, view, labelOf, nodeLabel, onFollow, onNavigateField, onJump, onClose }: ReferencePanelProps) {
  const end = (ref: Pin) => `${nodeLabel(ref.nodeId)}${ref.fieldId ? `.${ref.fieldId}` : ""}`;
  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="References">
      <div className="as-panel__head">
        <h2 className="as-panel__title">References</h2>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close references panel">
          <UiIcon name="close" />
        </button>
      </div>
      <div className="as-paths__pins">
        {/* The subject names a box that may be off-screen, on another level,
            or folded into a chip — every other label in this panel takes you
            to what it names, and this one used to be the exception. */}
        <button
          type="button"
          className="as-chip as-chip--on"
          title={`Go to ${labelOf(pin)}`}
          onClick={() => onJump(pin)}
        >
          {labelOf(pin)}
        </button>
      </div>

      <LinkList
        caption={pin.fieldId ? "Points at" : "Keys it carries"}
        links={view.carries}
        text={(link) => `${link.from.fieldId} → ${end(link.to)}`}
        onPick={onFollow}
        empty={pin.fieldId ? "Not a reference." : "No foreign keys of its own."}
      />
      <LinkList
        caption="Referenced by"
        links={view.referencedBy}
        text={(link) => `${end(link.from)} → ${link.to.fieldId ?? nodeLabel(link.to.nodeId)}`}
        onPick={(link) => onNavigateField(link.from)}
        empty="Nothing points at it."
      />
    </div>
  );
}

function LinkList({
  caption,
  links,
  text,
  onPick,
  empty,
}: {
  caption: string;
  links: readonly KeyLink[];
  text: (link: KeyLink) => string;
  onPick: (link: KeyLink) => void;
  empty: string;
}) {
  const shown = links.slice(0, LIST_CAP);
  return (
    <section className="as-paths__section" aria-label={caption}>
      <h3 className="as-paths__caption">
        {caption} <span className="as-paths__count">{links.length}</span>
      </h3>
      {links.length ? (
        <ul className="as-paths__list">
          {shown.map((link) => (
            <li key={`${fieldKey(link.from)}\u0000${fieldKey(link.to)}`}>
              <button type="button" className="as-paths__item" title={`Go to ${text(link)}`} onClick={() => onPick(link)}>
                <span className="as-paths__itemlabel">{text(link)}</span>
                {link.edgeId === undefined ? <span className="as-paths__itemdetail">not drawn</span> : null}
              </button>
            </li>
          ))}
          {links.length > shown.length ? <li className="as-paths__more">… and {links.length - shown.length} more</li> : null}
        </ul>
      ) : (
        <p className="as-paths__empty">{empty}</p>
      )}
    </section>
  );
}
