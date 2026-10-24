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

/**
 * ⌘Z, ⇧⌘Z and ⌘Y belong to VS Code: it undoes the document's text, the one
 * history every view of the file shares, and the webview hears of the result
 * like any other change. VS Code's listener sees the key first (it's
 * registered before this page loads); this stops it there, before the
 * studio would ask for the same step a second time (its toolbar buttons ask
 * the extension: `hostHistory` in main.tsx).
 */
export function leaveHistoryToVsCode(): void {
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
 * Whether the person has done anything here yet. The studio can report a
 * change on its own as it opens a document (laying out one that has no
 * positions, say); opening a file must not change it, so only changes that
 * follow a person's input are written.
 */
export function watchForInput(): () => boolean {
  let touched = false;
  const mark = () => {
    touched = true;
  };
  for (const type of ["pointerdown", "keydown", "paste", "drop", "input"]) window.addEventListener(type, mark, true);
  return () => touched;
}
