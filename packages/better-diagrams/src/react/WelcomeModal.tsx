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
import { useEffect, useRef, useState } from "react";
import { BrandMark, Modal } from "./chrome";
import { JsonCodeEditor } from "./JsonCodeEditor";
import { CloudScopePicker, scopeFor, type CloudScope } from "./CloudScopePicker";
import { copyText } from "./copy-text";
import { SEQUENCE_LINT, buildArchitectureLint, type JsonDocLint } from "./schema-lint";
import { approximateJsonFix } from "../contract/json-repair";
import type { CloudResourceOption } from "./template-prompt";

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
   * The CONTENT-form prompt for `kind` — elements only, no geometry.
   * Providing it puts a hover menu on the copy button offering both forms:
   * elements-only for documents whose layout the editor manages, and the
   * full schema when the AI should place everything itself.
   */
  systemPromptContent?: string;
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
   * Applies only while the picker sits on the host studio's own kind — it is
   * registry-aware *for that studio*.
   */
  lint?: JsonDocLint;
  /**
   * Cloud providers offered as a multi-select toggle under the title —
   * selecting some makes the copy button append their component sections.
   * Absent (the sequence editor) ⇒ no toggle row.
   */
  cloudProviders?: { id: string; label: string; color: string }[];
  /** Builds the prompt for the selected clouds; copy prefers it when present.
   *  `geometry: false` asks for the content form (see `systemPromptContent`);
   *  `components` narrows to chosen services (see `cloudResources`). */
  promptForClouds?: (
    clouds: string[],
    opts?: { geometry?: boolean; components?: readonly string[] },
  ) => string;
  /**
   * The services each cloud offers. Supplying them turns the cloud toggles
   * into a two-level scope — cloud, then which of its resources the schema
   * should teach — so a copy can carry Azure's Blob and Postgres without its
   * other fourteen kinds. Absent ⇒ chips only, whole packs.
   */
  cloudResources?: CloudResourceOption[];
  /** The open document's own cloud kinds, offered as a per-cloud preset. */
  usedResources?: readonly string[];
  /**
   * Clouds pre-toggled at mount — the studio passes the ones the open
   * document already references, so an immediate copy describes the diagram
   * on screen rather than a cloudless base.
   */
  initialClouds?: string[];
  /**
   * Parse + validate for the OTHER kind. Together with `onInsertOther` this
   * enables the type picker's other option; without both, the option renders
   * disabled with a hint.
   */
  parseOther?: (text: string) => unknown;
  /** Insert routed cross-kind — the host creates a file of the picked kind. */
  onInsertOther?: (doc: unknown, name: string) => void;
  /** What "Copy Schema & System Prompt" copies while the other kind is picked. */
  systemPromptOther?: string;
  /** Content-form prompt for the other kind — same menu, other side of the picker. */
  systemPromptOtherContent?: string;
  /**
   * Pin the picker to `kind`, rendered but disabled — for reopening the
   * modal as a JSON editor over an existing file, whose type must not be
   * silently rewritten by a paste.
   */
  lockKind?: boolean;
}

const ARCH_PLACEHOLDER = JSON.stringify({ version: 1, nodes: [], edges: [] }, null, 2);
/** How many lint notices the modal lists before summarising the rest. */
const MAX_NOTICES = 6;

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

// The two schemas overlap only on `version` and `meta`; every other top-level
// key names exactly one of them. A raw React Flow export (nodes with
// `position`) lands in the architecture bucket via its `nodes` key.
const SEQUENCE_ONLY_KEYS = ["participants", "messages", "activations", "fragments", "notes"];
const ARCHITECTURE_ONLY_KEYS = ["nodes", "edges", "zones"];

/**
 * Which kind pasted text looks like — null when it doesn't clearly say
 * (ambiguous, empty, or not JSON-shaped enough for the regex fallback).
 */
export function sniffKind(text: string): WelcomeModalProps["kind"] | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const seq = SEQUENCE_ONLY_KEYS.some((key) => key in raw);
    const arch = ARCHITECTURE_ONLY_KEYS.some((key) => key in raw);
    if (seq === arch) return null;
    return seq ? "sequence" : "architecture";
  } catch {
    // Mid-typing or slightly broken JSON — the keys still tell the story.
    const seq = /"(participants|messages)"\s*:/.test(text);
    const arch = /"(nodes|edges|zones)"\s*:/.test(text);
    if (seq === arch) return null;
    return seq ? "sequence" : "architecture";
  }
}

export function WelcomeModal({
  kind,
  brandLabel = "BetterDiagrams",
  defaultName,
  showNameField,
  systemPrompt,
  systemPromptContent,
  initialText,
  parse,
  onInsert,
  onDismiss,
  lint,
  cloudProviders,
  promptForClouds,
  cloudResources,
  usedResources,
  initialClouds,
  parseOther,
  onInsertOther,
  systemPromptOther,
  systemPromptOtherContent,
  lockKind,
}: WelcomeModalProps) {
  const [name, setName] = useState(defaultName);
  // Clouds and their resources are one answer: ticking a cloud takes all of
  // its services, and narrowing is a second, deliberate act.
  const [scope, setScope] = useState<CloudScope>(() =>
    scopeFor(initialClouds ?? [], cloudResources ?? []),
  );
  const [text, setText] = useState(initialText ?? "");
  const [error, setError] = useState<string | null>(null);
  /** Lossy rescue for a failed Insert — offered, never applied on its own. */
  const [approxFix, setApproxFix] = useState<{ text: string; sites: number } | null>(null);
  /** What the schema lint currently finds, listed under the editor. */
  const [notices, setNotices] = useState<Array<{ severity: string; message: string }>>([]);
  /** Whether the copy button's form picker is open. See its comment below. */
  const [copyFormOpen, setCopyFormOpen] = useState(false);
  const [copied, setCopied] = useState<null | "full" | "content">(null);
  const [pickedKind, setPickedKind] = useState<WelcomeModalProps["kind"]>(kind);
  /** A manual pick wins over auto-detect for the rest of the session. */
  const [kindTouched, setKindTouched] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const otherEnabled = !!parseOther && !!onInsertOther;

  const finalName = () => name.trim() || defaultName;

  // The content form exists only when the host supplied it — that presence
  // is what turns the copy button into a two-option hover menu.
  const contentPromptAvailable = !!(pickedKind === kind ? systemPromptContent : systemPromptOtherContent);

  const handleCopy = async (form: "full" | "content" = "full") => {
    // Only pass options the caller asked for: a host that offers no resource
    // list gets the plain `(clouds)` call it has always been handed.
    const opts: { geometry?: boolean; components?: readonly string[] } = {};
    if (form === "content") opts.geometry = false;
    if (cloudResources?.length) opts.components = scope.components;
    const scoped = () =>
      Object.keys(opts).length
        ? promptForClouds?.(scope.clouds, opts)
        : promptForClouds?.(scope.clouds);
    const prompt =
      pickedKind === kind
        ? form === "content"
          ? (scoped() ?? systemPromptContent ?? systemPrompt)
          : (scoped() ?? systemPrompt)
        : form === "content"
          ? (systemPromptOtherContent ?? systemPromptOther ?? systemPrompt)
          : (systemPromptOther ?? systemPrompt);
    const ok = await copyText(prompt);
    if (!ok) {
      setError("Clipboard is blocked in this context — copy from the docs instead.");
      return;
    }
    setCopied(form);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };

  const handleInsert = () => {
    try {
      if (pickedKind === kind) onInsert(parse(text), finalName());
      else onInsertOther?.(parseOther?.(text), finalName());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The hint only nags when the picker COULDN'T solve it — otherwise
      // auto-detect has already switched and the error is about something else.
      const hint = lockKind || !otherEnabled ? kindHint(pickedKind, text) : "";
      setError(message + hint);
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

        <div className="as-welcome__kind" role="group" aria-label="Diagram type">
          {(["architecture", "sequence"] as const).map((option) => {
            const isOther = option !== kind;
            const disabled = !!lockKind || (isOther && !otherEnabled);
            const title = lockKind
              ? "This dialog edits the current file — its type is fixed"
              : isOther && !otherEnabled
                ? `This host can't create ${option} files`
                : undefined;
            return (
              <button
                key={option}
                type="button"
                className="as-kind-chip"
                aria-pressed={pickedKind === option}
                disabled={disabled}
                title={title}
                onClick={() => {
                  setPickedKind(option);
                  setKindTouched(true);
                }}
              >
                {option === "architecture" ? "Architecture" : "Sequence"}
              </button>
            );
          })}
        </div>

        {pickedKind === "architecture" && cloudProviders?.length ? (
          <CloudScopePicker
            clouds={cloudProviders}
            resources={cloudResources}
            value={scope}
            onChange={setScope}
            usedResources={usedResources}
          />
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
          {/* Hover (or keyboard focus) reveals the form picker; a plain click
              keeps the historical behaviour and copies the full schema. */}
          <div
            className={`as-welcome__copy${contentPromptAvailable ? " as-menu-wrap" : ""}${
              copyFormOpen ? " as-welcome__copy--open" : ""
            }`}
          >
            <button type="button" className="as-btn as-welcome__cta" onClick={() => handleCopy("full")}>
              <span>{copied === "full" ? "Copied ✓" : "Copy Schema & System Prompt"}</span>
              <span className="as-welcome__arrow" aria-hidden="true">
                →
              </span>
            </button>
            {contentPromptAvailable ? (
              // A real disclosure button, not hover alone. On a touch device
              // there is no hover, and the first tap already copied the full
              // schema — so the "elements only" form, which is the right
              // answer for a complex diagram, could not be reached at all.
              <button
                type="button"
                className="as-btn as-btn--icon as-welcome__copy-toggle"
                aria-expanded={copyFormOpen}
                aria-label="Choose which form of the schema to copy"
                title="Choose the form: elements only, or elements and positioning"
                onClick={() => setCopyFormOpen((open) => !open)}
              >
                ▾
              </button>
            ) : null}
            {contentPromptAvailable ? (
              <div className="as-menu as-menu--left as-welcome__copy-menu" role="menu">
                <button
                  type="button"
                  className="as-menu__item"
                  role="menuitem"
                  onClick={() => handleCopy("content")}
                >
                  <div className="as-menu__label">
                    {copied === "content" ? "Copied ✓" : "Elements only"}
                  </div>
                  <div className="as-menu__hint">
                    No positions — you or the editor keep the layout; best for complex diagrams
                  </div>
                </button>
                <button
                  type="button"
                  className="as-menu__item"
                  role="menuitem"
                  onClick={() => handleCopy("full")}
                >
                  <div className="as-menu__label">
                    {copied === "full" ? "Copied ✓" : "Full schema"}
                  </div>
                  <div className="as-menu__hint">
                    Elements and positioning — the AI lays out the whole diagram
                  </div>
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="as-welcome__editor">
          <JsonCodeEditor
            value={text}
            onChange={(next) => {
              setText(next);
              setError(null);
              setApproxFix(null);
              // Follow what the paste looks like until the user has picked by
              // hand. Only flip toward kinds the picker could actually serve.
              if (!kindTouched && !lockKind) {
                const sniffed = sniffKind(next);
                if (sniffed && (sniffed === kind || otherEnabled)) setPickedKind(sniffed);
              }
            }}
            placeholder={pickedKind === "sequence" ? SEQ_PLACEHOLDER : ARCH_PLACEHOLDER}
            ariaLabel="Diagram JSON"
            lint={
              pickedKind === kind
                ? (lint ?? (kind === "sequence" ? SEQUENCE_LINT : DEFAULT_ARCH_LINT))
                : pickedKind === "sequence"
                  ? SEQUENCE_LINT
                  : DEFAULT_ARCH_LINT
            }
            onDiagnostics={setNotices}
          />
        </div>

        {/* The warnings, in words, under the editor.
            The gutter marker and its hover tooltip are the whole story
            otherwise — and every one of these messages says what the document
            is about to LOSE on insert ("the whole edge will be dropped",
            "inserted as \"service\""), which is not something to leave behind
            a hover. Insert always proceeds; these are never errors. */}
        {notices.length ? (
          <ul className="as-welcome__notices">
            {notices.slice(0, MAX_NOTICES).map((notice, i) => (
              <li key={`${notice.message}-${i}`} className={`as-welcome__notice as-welcome__notice--${notice.severity}`}>
                {notice.message}
              </li>
            ))}
            {notices.length > MAX_NOTICES ? (
              <li className="as-welcome__notice as-welcome__notice--more">
                …and {notices.length - MAX_NOTICES} more
              </li>
            ) : null}
          </ul>
        ) : null}

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
