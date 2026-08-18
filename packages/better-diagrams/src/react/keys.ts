/**
 * keys.ts — the rules both editors' keyboard handlers share.
 *
 * Split out because the two studios had drifting copies of `isTypingTarget`,
 * and a guard that differs between them is exactly the kind of bug nobody
 * notices until a single-letter shortcut fires while someone is naming a node.
 */

/** True when focus is in a text field, so global key handlers should stand down. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // CodeMirror renders a contenteditable div, and the event target can be a
  // node INSIDE it rather than the editable element itself — `closest` catches
  // both, where a bare `isContentEditable` check only catches the outer one.
  return el.isContentEditable || !!el.closest?.('[contenteditable="true"]');
}

/** ⌘ on Apple platforms, Ctrl everywhere else. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // `platform` is deprecated but still the only synchronous signal that works
  // in every browser this ships to; userAgent is the fallback.
  return /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || "");
}
