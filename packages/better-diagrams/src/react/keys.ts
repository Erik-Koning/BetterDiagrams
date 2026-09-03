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

/** True when focus is in a text field, so global key handlers should stand down. */
export function isTypingTarget(target: EventTarget | null): boolean {
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
  // purpose, which is the same rule as a text field.
  if (tag === "SELECT") return true;
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

/** ⌘ on Apple platforms, Ctrl everywhere else. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // `platform` is deprecated but still the only synchronous signal that works
  // in every browser this ships to; userAgent is the fallback.
  return /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || "");
}
