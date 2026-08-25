/**
 * NestingModal — confirming a move between C4 levels.
 *
 * Nesting is not a styling change: it moves real content off the level the
 * reader is looking at, and re-aims every arrow that pointed into it. That is
 * worth a beat, so the dialog says what will happen in the document's own
 * terms — how many nodes move, what the arrows will land on — rather than
 * asking "are you sure".
 *
 * The kind picker is part of the question, not a follow-up: a frame becoming
 * a card has to become SOME card, and answering that here saves a trip to the
 * inspector afterwards. Container kinds are omitted because choosing one
 * would leave the contents inline and nothing would appear to happen.
 */
import { useState } from "react";
import { Modal } from "./chrome";
import { KindSelect } from "./KindSelect";
import { kindDef } from "./registry";
import type { ResolvedRegistry } from "./registry-types";

export interface NestingSubject {
  id: string;
  label: string;
  /** Direct children — what actually moves. */
  count: number;
}

export interface NestingModalProps {
  subject: NestingSubject;
  /** `nest` pushes the contents a level deeper; `inline` brings them back. */
  mode: "nest" | "inline";
  registry: ResolvedRegistry;
  /** Providers the document references — the kind picker demotes the rest. */
  relevantProviders: ReadonlySet<string>;
  onCancel: () => void;
  /** The chosen kind is meaningful for `nest` only. */
  onConfirm: (kind: string) => void;
}

export function NestingModal({
  subject,
  mode,
  registry,
  relevantProviders,
  onCancel,
  onConfirm,
}: NestingModalProps) {
  const [kind, setKind] = useState("service");
  const one = subject.count === 1;

  const title =
    mode === "nest"
      ? `Nest “${subject.label}” one level deeper?`
      : `Show “${subject.label}” contents inline?`;

  return (
    <Modal title={title} onClose={onCancel}>
      <p className="as-modal__body">
        {mode === "nest" ? (
          one ? (
            <>
              Its one node moves to a level of its own inside it. Anything that connects to it
              will connect to <strong>{subject.label}</strong> here instead; its own wiring
              stays, visible when you drill in.
            </>
          ) : (
            <>
              Its {subject.count} nodes move to a level of their own inside it. Anything that
              connects to them will connect to <strong>{subject.label}</strong> here instead;
              their own wiring stays, visible when you drill in.
            </>
          )
        ) : one ? (
          <>
            Its one node comes back onto this level, inside a frame. Arrows that reach the card
            will reach the node itself again.
          </>
        ) : (
          <>
            Its {subject.count} nodes come back onto this level, inside a frame. Arrows that
            reach the card will reach the nodes themselves again.
          </>
        )}
      </p>

      {mode === "nest" ? (
        <label className="as-nesting__kind">
          <span className="as-nesting__kind-label">It becomes a</span>
          <KindSelect
            registry={registry}
            value={kind}
            onChange={setKind}
            relevantProviders={relevantProviders}
            // A container would keep the contents inline — the one answer
            // that would make this dialog a no-op. Annotations and bare dots
            // cannot hold anything at all.
            omit={(k) => {
              const def = kindDef(registry, k);
              return !!def.container || !!def.annotation || !!def.point;
            }}
          />
        </label>
      ) : null}

      <div className="as-modal__actions">
        <button type="button" className="as-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="as-btn as-btn--primary" onClick={() => onConfirm(kind)}>
          {mode === "nest" ? "Nest contents" : "Show inline"}
        </button>
      </div>
    </Modal>
  );
}
