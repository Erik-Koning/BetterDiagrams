/**
 * keys.ts — the rules both editors' keyboard handlers share.
 *
 * Split out because the two studios had drifting copies of `isTypingTarget`,
 * and a guard that differs between them is exactly the kind of bug nobody
 * notices until a single-letter shortcut fires while someone is naming a node.
 */

/**
 * `<input>` types that are NOT text entry.
 *
 * Focus stays on a control after it is clicked, so treating every `<input>` as
 * "someone is typing" leaves undo, delete and the arrows dead until the user
 * remembers to click the canvas — after changing a status, ticking a checkbox,
 * or scrubbing the timeline. None of these consume a plain letter or ⌘Z, so
 * standing down for them buys nothing and costs the shortcut.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "button",
  "submit",
  "reset",
  "file",
  "image",
]);

/**
 * True when focus is in a text field, so global key handlers should stand down.
 *
 * Pass the event when there is one: a `<select>` stands down for the keys it
 * uses, not for a ⌘ chord, and only the event can tell the two apart.
 */
export function isTypingTarget(target: EventTarget | null, event?: KeyboardEvent): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  // A <select> takes single letters for type-ahead and the arrows to change
  // value, so it genuinely owns those — but only while it has focus for that
  // purpose, which is the same rule as a text field. It has no use for ⌘Z or
  // ⌘D, though, and focus stays on it after a pick: standing down for those
  // left undo dead straight after changing a kind, until something else was
  // clicked.
  if (tag === "SELECT") return !(event && isCommandChord(event));
  // CodeMirror renders a contenteditable div, and the event target can be a
  // node INSIDE it rather than the editable element itself — `closest` catches
  // both, where a bare `isContentEditable` check only catches the outer one.
  return el.isContentEditable || !!el.closest?.('[contenteditable="true"]');
}

/**
 * Shortcuts that belong to the APPLICATION rather than to whatever has focus.
 *
 * Save is the one that matters: "rename the node, hit ⌘S" is the most natural
 * sequence in the product, and standing down for the field the user is typing
 * in hands the key to the browser's Save-Page dialog. A text field has no
 * meaning for these chords, so there is nothing to yield to.
 */
export function isGlobalChord(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  const key = event.key.toLowerCase();
  if (key === "s" || key === "k") return true;
  // ⌘⇧E exports a PNG; ⌘⇧K opens the link field.
  if (event.shiftKey && (key === "e" || key === "k")) return true;
  return false;
}

/** ⌘ or Ctrl with a character key — ⌘Z, ⌘D, ⌘0 — rather than with an arrow or Enter. */
function isCommandChord(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.length === 1;
}

/**
 * `<input>` types that are pressed like a button, so Enter or Space on one
 * belongs to it: a checkbox toggles, a colour well opens its picker.
 */
const PRESSABLE_INPUT_TYPES = new Set(["checkbox", "radio", "range", "color", "button", "submit", "reset", "file", "image"]);

/**
 * True when the focused control answers this key itself, so an editor's
 * window handler must leave it alone.
 *
 * Not the same question as `isTypingTarget`: a slider or a menu row takes no
 * letters, so N and ⌘Z still belong to the canvas while one has focus. But
 * the arrows step a slider and walk a menu, and Enter presses a button. On
 * window, the same keys nudged the selected node from under the zone's
 * opacity slider and started renaming it when Enter was meant for a toolbar
 * button.
 *
 * Arrows stay with the canvas on a plain button and a checkbox, which do
 * nothing with them: focus stays on a control after it is clicked, and the
 * arrows should not go dead because a swatch or a tick box was the last
 * thing pressed.
 */
export function controlOwnsKey(target: EventTarget | null, event: KeyboardEvent): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  const tag = el.tagName;
  const type = tag === "INPUT" ? ((el as HTMLInputElement).type?.toLowerCase() ?? "text") : "";
  // A menu's rows are walked with the arrows and chosen with Enter, whatever
  // kind of element each one is.
  const inMenu = !!el.closest?.('[role="menu"], [role="menubar"], [role="listbox"], [role^="menuitem"]');
  if (event.key.startsWith("Arrow")) {
    return inMenu || tag === "SELECT" || type === "range" || type === "radio";
  }
  if (event.key === "Enter" || event.key === " ") {
    if (inMenu || tag === "BUTTON" || tag === "SELECT" || tag === "SUMMARY") return true;
    if (tag === "A" && (el as HTMLAnchorElement).hasAttribute("href")) return true;
    if (el.getAttribute("role") === "button") return true;
    return PRESSABLE_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * The editor the keyboard belongs to while nothing has DOM focus.
 *
 * Clicking a canvas leaves focus on <body>, so focus alone cannot tell two
 * mounted studios apart — or tell either of them from the host's own page.
 * The most recently pointed-at editor holds the claim; the first to mount
 * takes it so a lone editor works before anyone has touched it. Shared by
 * both editors, so an architecture and a sequence diagram on one page don't
 * both answer every key.
 */
let keyboardOwner: symbol | null = null;

/** Take the keyboard claim — on a pointer down, or on mount when `ifFree` and nobody holds it. */
export function claimKeyboard(id: symbol, { ifFree = false }: { ifFree?: boolean } = {}): void {
  if (ifFree && keyboardOwner !== null) return;
  keyboardOwner = id;
}

/** Give the claim up, if this editor still holds it — on unmount. */
export function releaseKeyboard(id: symbol): void {
  if (keyboardOwner === id) keyboardOwner = null;
}

/**
 * Whether a keystroke on `window` was meant for the editor rooted at `root`.
 *
 * The handler has to be on `window` — the canvas is not focusable and the
 * user is usually pointing at it rather than tabbed into it — but "on
 * window" is not the same as "for us". Embedded in a panel, the editor was
 * answering Delete, N and the arrows while the user worked in the host's own
 * UI, and two mounted studios both answered every key.
 *
 * Three signals, in order of how sure each one is:
 *   focus inside us            → certainly ours
 *   focus on something else    → certainly not ours
 *   focus nowhere (the usual
 *   state after a canvas click) → whichever editor was touched last
 */
export function ownsKeyboard(root: HTMLElement | null, id: symbol): boolean {
  if (!root) return false;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active && active !== document.body) return root.contains(active);
  return keyboardOwner === id;
}

/** ⌘ on Apple platforms, Ctrl everywhere else. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // `platform` is deprecated but still the only synchronous signal that works
  // in every browser this ships to; userAgent is the fallback.
  return /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || "");
}
