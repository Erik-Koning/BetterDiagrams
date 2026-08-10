/**
 * JsonCodeEditor — a controlled CodeMirror 6 JSON editor: line numbers, a
 * VS Code-style fold gutter, live syntax linting with squiggles, and gentle
 * self-healing of full-document pastes (see transformPastedJson).
 *
 * Everything visual resolves through the `--as-*` custom properties, so the
 * editor follows the host theme for free — it always renders inside
 * `.as-root`, where those properties are defined.
 */
import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
} from "@codemirror/language";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { docDiagnostics, type JsonDocLint } from "./schema-lint";
import { approximateJsonFix, repairJsonText } from "../contract/json-repair";

export interface JsonCodeEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** Ghost text while empty — may be multi-line pretty-printed JSON. */
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /**
   * Warn (yellow, never an error) about keys, values, references, and dates
   * the schema doesn't know — see schema-lint.ts. Fixed at mount, like the
   * other extensions.
   */
  lint?: JsonDocLint;
}

const jsonHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--as-accent)" },
  { tag: tags.string, color: "var(--as-text)" },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: "color-mix(in srgb, var(--as-accent) 55%, var(--as-text))",
  },
  { tag: [tags.punctuation, tags.brace, tags.squareBracket], color: "var(--as-text-dim)" },
]);

// The surface/border/text vars carry dark fallbacks: this editor renders
// inside modals that hosts can mount outside .as-root, where the tokens are
// undefined — without the fallbacks the pane goes transparent over the canvas.
const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--as-surface-2, #1e293b)",
    color: "var(--as-text, #e2e8f0)",
    border: "1px solid var(--as-border, #334155)",
    borderRadius: "8px",
    fontSize: "12px",
  },
  "&.cm-focused": {
    outline: "2px solid var(--as-accent)",
    outlineOffset: "1px",
  },
  ".cm-scroller": { fontFamily: "var(--as-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--as-accent)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--as-accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--as-accent) 25%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--as-surface, #0b1220)",
    color: "var(--as-text-dim, #94a3b8)",
    border: "none",
    borderRight: "1px solid var(--as-border, #334155)",
    borderRadius: "8px 0 0 8px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--as-text)" },
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer" },
  // `pre` keeps the multi-line JSON placeholder's indentation readable.
  ".cm-placeholder": { color: "var(--as-text-dim)", whiteSpace: "pre" },
  ".cm-tooltip": {
    backgroundColor: "var(--as-surface-2, #1e293b)",
    border: "1px solid var(--as-border, #334155)",
    color: "var(--as-text, #e2e8f0)",
    fontFamily: "var(--as-font)",
  },
  ".cm-diagnostic": { fontFamily: "var(--as-font)" },
  // Unknown-key warnings read as "heads up", not "broken": a yellow wash
  // under the key on top of the default squiggle. Amber holds up on both the
  // dark and light surfaces.
  ".cm-lintRange-warning": {
    backgroundColor: "color-mix(in srgb, #eab308 22%, transparent)",
  },
});

/**
 * Syntax linting in three tiers. An empty box shouldn't squiggle. Broken JSON
 * the safe healer can fix keeps the plain parse squiggle — Insert heals it
 * silently, so it's a note, not a wall. Broken JSON with real content loss
 * (the safe healer refuses) gets each damage site highlighted with an
 * "Approximate a fix" action that swaps in the lossy recovery — a reasonable
 * guess at every damaged spot — so the rest of the document survives.
 */
const jsonLinter = linter(
  (view) => {
    const text = view.state.doc.toString();
    if (!text.trim()) return [];
    const base = jsonParseLinter()(view);
    if (!base.length) return [];
    const fix = approximateJsonFix(text);
    if (!fix) return base;
    const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
    return fix.sites.map((site) => ({
      from: clamp(site.from),
      to: Math.max(clamp(site.to), clamp(site.from) + 1),
      severity: "error" as const,
      message:
        `${site.note} — text may have been lost in a copy/paste. ` +
        `Re-copy the original for a faithful document, or approximate to keep the rest.`,
      actions: [
        {
          name: "Approximate a fix",
          apply(v: EditorView) {
            v.dispatch({
              changes: { from: 0, to: v.state.doc.length, insert: fix.text },
              selection: { anchor: fix.text.length },
            });
          },
        },
      ],
    }));
  },
  { delay: 250 },
);

/**
 * Gentle self-healing for a paste that becomes the whole document.
 *
 * Pasted JSON has usually been through a chat window or a terminal: markdown
 * fences, surrounding prose, smart quotes, trailing commas — and it arrives
 * as one enormous line. This strips the wrapping, heals what json-repair can
 * heal, and pretty-prints, so the editor shows a readable document instead of
 * a single-line wall the user has to debug by squiggle.
 *
 * Returns null to fall back to a verbatim paste: when the text isn't
 * JSON-shaped, when it can't be healed (the syntax linter then points at the
 * damage), or when it's already valid multi-line JSON — someone's deliberate
 * formatting is not ours to rewrite.
 */
export function transformPastedJson(raw: string): string | null {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.search(/[{[]/);
  if (start === -1) return null;
  const closer = cleaned[start] === "{" ? "}" : "]";
  const end = cleaned.lastIndexOf(closer);
  const slice = end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
  let healed: { text: string; repairs: string[] };
  try {
    healed = repairJsonText(slice);
  } catch {
    return null;
  }
  const lines = slice.split("\n");
  const squashed = lines.length < 3 || lines.some((line) => line.length > 160);
  if (!healed.repairs.length && !squashed && slice === raw.trim()) return null;
  return JSON.stringify(JSON.parse(healed.text), null, 2);
}

const healingPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const raw = event.clipboardData?.getData("text/plain") ?? "";
    if (!raw.trim()) return false;
    const { doc, selection } = view.state;
    const sel = selection.main;
    // Only a paste that becomes the whole document is healed — a fragment
    // pasted mid-edit has surrounding context this transform can't see.
    const replacesWholeDoc = !doc.toString().trim() || (sel.from === 0 && sel.to === doc.length);
    if (!replacesWholeDoc) return false;
    const transformed = transformPastedJson(raw);
    if (transformed === null) return false;
    event.preventDefault();
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: transformed },
      selection: { anchor: transformed.length },
    });
    return true;
  },
});

export function JsonCodeEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  autoFocus,
  lint,
}: JsonCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        json(),
        healingPaste,
        jsonLinter,
        lint
          ? linter(
              (view) =>
                view.state.doc.toString().trim() ? docDiagnostics(view.state, lint) : [],
              { delay: 250 },
            )
          : [],
        lintGutter(),
        syntaxHighlighting(jsonHighlight),
        editorTheme,
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
        placeholder ? cmPlaceholder(placeholder) : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        ariaLabel ? EditorView.contentAttributes.of({ "aria-label": ariaLabel }) : [],
      ],
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; `value` afterwards syncs via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="as-jsoneditor" />;
}
