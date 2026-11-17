/**
 * shims.ts — the few places a VS Code webview isn't the browser tab the
 * studio was built for. Each is installed once, before the studio mounts.
 */

/**
 * VS Code's own stylesheet for webviews (padding on the body, its colours on
 * links, code and kbd, thin scrollbars). Taken out, so the studio is styled
 * exactly as it is in the browser.
 */
export function removeVsCodeDefaultStyles(): void {
  document.getElementById("_defaultStyles")?.remove();
}

/** `<input>` types nobody types text into, as the studio counts them (`isTypingTarget`). */
const UNTYPED_INPUTS = new Set(["checkbox", "radio", "range", "color", "button", "submit", "reset", "file", "image", "hidden"]);

/**
 * Whether `target` is a place a person types text: a text box, a text area,
 * an editable region (the Edit JSON modal's editor is one). Not a slider, a
 * tick box or a select: ⌘Z on those is the diagram's.
 */
export function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  if (target instanceof HTMLInputElement) return !UNTYPED_INPUTS.has(target.type) && !target.readOnly && !target.disabled;
  return target instanceof HTMLElement && target.isContentEditable;
}

const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** ⌘ on a Mac, Ctrl elsewhere, and no other modifier but Shift. */
const commandKey = (event: KeyboardEvent) =>
  !event.altKey && (IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/**
 * Whether the key is the letter `char`: by what it types, or by its key
 * code, as VS Code's listener tells Z and Y — so a layout that types another
 * letter there is still caught before VS Code catches it.
 */
const isLetter = (event: KeyboardEvent, char: string) =>
  event.key.toLowerCase() === char || event.keyCode === char.toUpperCase().charCodeAt(0);

/** The step ⌘Z, ⇧⌘Z or ⌘Y asks for (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y off a Mac); null for any other key. */
function historyStep(event: KeyboardEvent): "undo" | "redo" | null {
  if (!commandKey(event)) return null;
  if (isLetter(event, "z")) return event.shiftKey ? "redo" : "undo";
  if (isLetter(event, "y") && !event.shiftKey) return "redo";
  return null;
}

/**
 * ⌘Z, ⇧⌘Z and ⌘Y on the diagram belong to VS Code: it undoes the document's
 * text, the one history every view of the file shares, and the webview
 * hears of the result like any other change. VS Code's listener on this
 * window hears the key first (it's registered before this page loads), and
 * the window listener here stops it there, before the studio would ask for
 * the same step a second time (its toolbar buttons ask the extension:
 * `hostHistory` in main.tsx).
 *
 * In a text field they're the field's: they undo the typing, not the
 * diagram. VS Code's listener would take them from a field too, and its
 * Undo steps the file in front, whatever has focus in it. So a key aimed at
 * a field is stopped on the document — after the field, and an editor with
 * a history of its own such as the Edit JSON modal's, have had it; before it
 * reaches the window — and the field's step is taken here, as VS Code takes
 * it for a webview of its own: macOS leaves ⌘Z in a field to the app's Edit
 * menu, which VS Code keeps from a focused webview. ⌘A, likewise, selects
 * the field's text: VS Code's Select All is the canvas's (package.json).
 *
 * `divert` is asked first about a step aimed at the diagram; true takes it
 * from VS Code (main.tsx sends it the extension's way, after an edit still
 * waiting to be sent).
 */
export function leaveHistoryToVsCode(divert: (step: "undo" | "redo") => boolean = () => false): void {
  document.addEventListener("keydown", (event) => {
    const step = historyStep(event);
    const selectAll = !step && commandKey(event) && !event.shiftKey && isLetter(event, "a");
    if (!step && !selectAll) return;
    if (isTextField(event.target)) {
      event.stopPropagation();
      // The field answered it itself (CodeMirror's history, its Select All).
      if (event.defaultPrevented) return;
      event.preventDefault();
      document.execCommand(step ?? "selectAll");
      return;
    }
    if (step && divert(step)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && (key === "z" || key === "y")) event.stopImmediatePropagation();
  });
}

/**
 * A webview can't download: VS Code takes every link click, a blob: one
 * included, and goes nowhere with it. The studio's exports download through
 * a link, so its file is read back here and handed to the extension, which
 * asks where to save it.
 */
export function sendDownloadsToHost(save: (filename: string, data: Uint8Array) => void): void {
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[download]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || !/^(blob|data):/.test(anchor.href)) return;
      event.preventDefault();
      event.stopPropagation();
      const filename = anchor.download || "export";
      void fetch(anchor.href)
        .then((response) => response.arrayBuffer())
        .then((buffer) => save(filename, new Uint8Array(buffer)))
        .catch((error) => console.error(`Better Diagrams: couldn't read the export ${filename} back`, error));
    },
    true,
  );
}

/**
 * A link out of the diagram — a node's ↗, the inspector's open-link button —
 * opens in a browser tab on the web. Here VS Code would open it, but only
 * from a click that reaches the window, and the ↗ stops its click at the
 * studio so the node underneath isn't selected; a new tab is refused by the
 * webview's sandbox either way. So a click on one is taken first, on the way
 * down, and handed to the extension to open as VS Code opens any link.
 */
export function sendLinksToHost(open: (url: string) => void): void {
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]:not([download])") : null;
      if (!(anchor instanceof HTMLAnchorElement) || !/^(https?|mailto|tel|ftp):/i.test(anchor.href)) return;
      event.preventDefault();
      event.stopPropagation();
      open(anchor.href);
    },
    true,
  );
}

/**
 * Whether the person has done anything here yet. The studio can report a
 * change on its own as it opens a document (laying out one that has no
 * positions, say); opening a file must not change it, so only changes that
 * follow a person's input are written. Heard on the way down, so a key
 * stopped on its way back up (leaveHistoryToVsCode) still counts.
 */
export function watchForInput(): () => boolean {
  let touched = false;
  const mark = () => {
    touched = true;
  };
  for (const type of ["pointerdown", "keydown", "paste", "drop", "input"]) window.addEventListener(type, mark, true);
  return () => touched;
}
