/**
 * WelcomeModal — the branded on-ramp shown over a brand-new document or an
 * empty workspace. Three ways in: dismiss and build by hand, copy the schema
 * + system prompt for an LLM, or paste template JSON and insert it.
 *
 * The modal owns no document logic: the studio hands it a `parse` function
 * (which throws user-facing messages) and receives the validated doc back
 * through `onInsert`. Escape and the backdrop behave like "Insert Node
 * Manually" — this can never trap the user.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BrandMark, Modal } from "./chrome";
import { JsonCodeEditor } from "./JsonCodeEditor";
import { SEQUENCE_LINT, buildArchitectureLint, type JsonDocLint } from "./schema-lint";
import { approximateJsonFix } from "../contract/json-repair";

export interface WelcomeModalProps {
  kind: "architecture" | "sequence";
  /** Wordmark next to the brand mark. */
  brandLabel?: string;
  /** Prefills the name field — the active file's name, or "Untitled N". */
  defaultName: string;
  /** Hidden when neither rename nor create is wired up by the host. */
  showNameField: boolean;
  /** What "Copy Schema & System Prompt" puts on the clipboard. */
  systemPrompt: string;
  /**
   * Prefill for the JSON editor. The modal's usual job is greeting a blank
   * document, but with this a host can reopen it over an existing diagram as
   * a JSON editor — same parsing, healing, and insert flow.
   */
  initialText?: string;
  /** Parse + validate pasted text; throws with a user-facing message. */
  parse: (text: string) => unknown;
  onInsert: (doc: unknown, name: string) => void;
  onDismiss: (name: string) => void;
  /**
   * Schema lint for the JSON editor. Absent, a builtin-vocabulary spec for
   * `kind` is used; the architecture studio passes a registry-aware one.
   */
  lint?: JsonDocLint;
  /**
   * Cloud providers offered as a multi-select toggle under the title —
   * selecting some makes the copy button append their component sections.
   * Absent (the sequence editor) ⇒ no toggle row.
   */
  cloudProviders?: { id: string; label: string; color: string }[];
  /** Builds the prompt for the selected clouds; copy prefers it when present. */
  promptForClouds?: (clouds: string[]) => string;
}

/** Clipboard write with the legacy fallback for insecure contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand("copy");
      helper.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const ARCH_PLACEHOLDER = JSON.stringify({ version: 1, nodes: [], edges: [] }, null, 2);
const SEQ_PLACEHOLDER = JSON.stringify({ version: 1, participants: [], messages: [] }, null, 2);

/** Builtin-vocabulary fallback when the studio doesn't pass a registry-aware spec. */
const DEFAULT_ARCH_LINT = buildArchitectureLint();

/**
 * Hand-off latch for the zero-files dismissal. "Insert Node Manually" over an
 * empty workspace creates a blank file to land in — which remounts the studio
 * on a brand-new blank document, the exact trigger for this modal. Without
 * the latch the user dismisses one modal and is greeted by its twin.
 *
 * Time-boxed rather than consumed-on-read so a host that doesn't remount per
 * file can't strand it, and cleared on every studio mount after the open
 * decision so it never outlives the hand-off it was set for.
 */
let suppressUntil = 0;

export function suppressNextWelcome(): void {
  suppressUntil = Date.now() + 1000;
}

export function welcomeSuppressed(): boolean {
  return Date.now() < suppressUntil;
}

export function clearWelcomeSuppression(): void {
  suppressUntil = 0;
}

/** A likely paste-into-the-wrong-editor gets a pointer, not just an error. */
function kindHint(kind: WelcomeModalProps["kind"], text: string): string {
  if (kind === "architecture" && /"participants"\s*:/.test(text)) {
    return " This looks like a sequence document — create a sequence file for it.";
  }
  if (kind === "sequence" && /"nodes"\s*:/.test(text)) {
    return " This looks like an architecture document — create an architecture file for it.";
  }
  return "";
}

export function WelcomeModal({
  kind,
  brandLabel = "BetterDiagrams",
  defaultName,
  showNameField,
  systemPrompt,
  initialText,
  parse,
  onInsert,
  onDismiss,
  lint,
  cloudProviders,
  promptForClouds,
}: WelcomeModalProps) {
  const [name, setName] = useState(defaultName);
  const [selectedClouds, setSelectedClouds] = useState<string[]>([]);
  const [text, setText] = useState(initialText ?? "");
  const [error, setError] = useState<string | null>(null);
  /** Lossy rescue for a failed Insert — offered, never applied on its own. */
  const [approxFix, setApproxFix] = useState<{ text: string; sites: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const finalName = () => name.trim() || defaultName;

  const toggleCloud = (id: string) =>
    setSelectedClouds((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );

  const handleCopy = async () => {
    const ok = await copyText(promptForClouds?.(selectedClouds) ?? systemPrompt);
    if (!ok) {
      setError("Clipboard is blocked in this context — copy from the docs instead.");
      return;
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const handleInsert = () => {
    try {
      onInsert(parse(text), finalName());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message + kindHint(kind, text));
      // Real content loss? Offer the lossy rescue next to the error — applying
      // it stays the user's call, so the guesses can be reviewed before Insert.
      const fix = approximateJsonFix(text);
      setApproxFix(fix ? { text: fix.text, sites: fix.sites.length } : null);
    }
  };

  const handleApproximate = () => {
    if (!approxFix) return;
    setText(approxFix.text);
    setApproxFix(null);
    setError(null);
  };

  return (
    <Modal
      title="Get started"
      onClose={() => onDismiss(finalName())}
      cardClassName="as-modal__card--wide"
      hideTitle
    >
      <div className="as-welcome">
        <div className="as-welcome__brand">
          <BrandMark className="as-brand__mark as-welcome__mark" />
          <span className="as-welcome__wordmark">{brandLabel}</span>
        </div>

        {showNameField ? (
          <input
            className="as-input as-welcome__name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="File name"
            aria-label="File name"
          />
        ) : null}

        {cloudProviders?.length ? (
          <div className="as-welcome__clouds" role="group" aria-label="Cloud providers">
            <span className="as-welcome__clouds-label">Clouds</span>
            {cloudProviders.map((cloud) => (
              <button
                key={cloud.id}
                type="button"
                className="as-cloud-chip"
                style={{ "--chip-color": cloud.color } as CSSProperties}
                aria-pressed={selectedClouds.includes(cloud.id)}
                onClick={() => toggleCloud(cloud.id)}
                title={`Include ${cloud.label} components in the copied schema & prompt`}
              >
                <span className="as-cloud-chip__dot" aria-hidden="true" />
                {cloud.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="as-welcome__ctas">
          <button
            type="button"
            className="as-btn as-welcome__cta"
            onClick={() => onDismiss(finalName())}
          >
            <span>Insert Node Manually</span>
            <span className="as-welcome__arrow" aria-hidden="true">
              →
            </span>
          </button>
          <button type="button" className="as-btn as-welcome__cta" onClick={handleCopy}>
            <span>{copied ? "Copied ✓" : "Copy Schema & System Prompt"}</span>
            <span className="as-welcome__arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>

        <div className="as-welcome__editor">
          <JsonCodeEditor
            value={text}
            onChange={(next) => {
              setText(next);
              setError(null);
              setApproxFix(null);
            }}
            placeholder={kind === "sequence" ? SEQ_PLACEHOLDER : ARCH_PLACEHOLDER}
            ariaLabel="Diagram JSON"
            lint={lint ?? (kind === "sequence" ? SEQUENCE_LINT : DEFAULT_ARCH_LINT)}
          />
        </div>

        {error ? (
          <div className="as-welcome__error" role="alert">
            {error}
            {approxFix ? (
              <button type="button" className="as-btn as-welcome__approx" onClick={handleApproximate}>
                Approximate a fix ({approxFix.sites} {approxFix.sites === 1 ? "guess" : "guesses"})
              </button>
            ) : null}
          </div>
        ) : null}

        {text.trim() ? (
          <div className="as-welcome__insert-row">
            <button type="button" className="as-btn as-btn--primary" onClick={handleInsert}>
              Insert
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
