/**
 * SchemaCopyModal — the "✦ Copy schema" dialog for a diagram that already
 * exists.
 *
 * Copying the schema from an open document used to be a single blind click:
 * whatever clouds the document happened to reference went into the prompt,
 * and nothing else could. But the copy is aimed at the diagram someone is
 * ABOUT to ask for, not the one on screen — a cloudless sketch that is about
 * to become an Azure landing zone needs Azure in the prompt, and an AWS
 * diagram borrowing one GCP service does not need all fifteen GCP kinds. So
 * the click asks first, seeded with what the document references.
 *
 * Nothing is assumed on the user's behalf: no cloud is pre-ticked that the
 * document doesn't already use, and an empty selection is a valid answer that
 * yields the provider-neutral schema.
 */
import { useMemo, useRef, useState, useEffect } from "react";
import { Modal } from "./chrome";
import { CloudScopePicker, scopeFor, type CloudScope } from "./CloudScopePicker";
import { copyText } from "./copy-text";
import type { CloudOption, CloudResourceOption } from "./template-prompt";

/** Which form of the schema the copy carries. */
export type SchemaForm = "full" | "content";

export interface SchemaCopyModalProps {
  /** Dialog heading. */
  title?: string;
  /** One line under it — typically what the scope was seeded from. */
  subtitle?: string;
  /** Cloud chips to offer, in registry order. */
  clouds: CloudOption[];
  /** Every selectable service; omit for cloud-granularity only. */
  resources?: CloudResourceOption[];
  /** Ticked at open — pass the document's referenced clouds. */
  initialClouds?: readonly string[];
  /** The document's own cloud kinds, offered as a per-cloud preset. */
  usedResources?: readonly string[];
  /** The prompt for a scope. `geometry: false` asks for the elements-only form. */
  buildPrompt: (scope: CloudScope, opts: { geometry: boolean }) => string;
  /**
   * Offer the elements-only form. False for a document whose layout the model
   * is expected to author (or a kind with no content form at all).
   */
  forms?: boolean;
  onClose: () => void;
  /** Fired after the text reaches the clipboard — for the host's own toast. */
  onCopied?: (text: string, scope: CloudScope, form: SchemaForm) => void;
}

const FORM_HINT: Record<SchemaForm, string> = {
  full: "Elements and positioning — the AI lays out the whole diagram",
  content: "No positions — the editor keeps the layout; best for complex diagrams",
};

export function SchemaCopyModal({
  title = "Copy schema & system prompt",
  subtitle,
  clouds,
  resources,
  initialClouds,
  usedResources,
  buildPrompt,
  forms = true,
  onClose,
  onCopied,
}: SchemaCopyModalProps) {
  const [scope, setScope] = useState<CloudScope>(() => scopeFor(initialClouds ?? [], resources ?? []));
  const [form, setForm] = useState<SchemaForm>("full");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  // Cheap enough to keep live: it is what makes the size of a selection — 40
  // kinds versus 4 — visible before the paste rather than after it.
  const prompt = useMemo(
    () => buildPrompt(scope, { geometry: form !== "content" }),
    [buildPrompt, scope, form],
  );

  const handleCopy = async () => {
    const ok = await copyText(prompt);
    if (!ok) {
      setError("Clipboard is blocked in this context — copy from the docs instead.");
      return;
    }
    setError(null);
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
    onCopied?.(prompt, scope, form);
  };

  const cloudCount = scope.clouds.filter((cloud) =>
    scope.components.some((id) => resources?.find((r) => r.id === id)?.cloud === cloud),
  ).length;

  return (
    <Modal title={title} onClose={onClose} cardClassName="as-modal__card--wide">
      <div className="as-schema-copy">
        {subtitle ? <p className="as-schema-copy__subtitle">{subtitle}</p> : null}

        <CloudScopePicker
          clouds={clouds}
          resources={resources}
          value={scope}
          onChange={setScope}
          usedResources={usedResources}
        />

        {scope.clouds.length ? null : (
          <p className="as-schema-copy__note">
            No cloud selected — the copied schema stays provider-neutral and teaches the generic
            kinds only. Name your cloud in your own prompt if the diagram needs one.
          </p>
        )}

        {forms ? (
          <div className="as-schema-copy__forms" role="group" aria-label="Schema form">
            {(["full", "content"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="as-kind-chip"
                aria-pressed={form === option}
                onClick={() => setForm(option)}
                title={FORM_HINT[option]}
              >
                {option === "full" ? "Full schema" : "Elements only"}
              </button>
            ))}
            <span className="as-schema-copy__form-hint">{FORM_HINT[form]}</span>
          </div>
        ) : null}

        {error ? (
          <div className="as-schema-copy__error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="as-schema-copy__footer">
          <span className="as-schema-copy__summary">
            {cloudCount ? `${cloudCount} cloud${cloudCount === 1 ? "" : "s"}` : "No cloud"} ·{" "}
            {scope.components.length} resource{scope.components.length === 1 ? "" : "s"} ·{" "}
            {prompt.length.toLocaleString()} characters
          </span>
          <div className="as-schema-copy__actions">
            <button type="button" className="as-btn" onClick={onClose}>
              Done
            </button>
            <button type="button" className="as-btn as-btn--primary" onClick={handleCopy}>
              {copied ? "Copied ✓" : "Copy schema"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
