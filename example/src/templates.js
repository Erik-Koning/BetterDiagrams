/**
 * templates.js — the client half of auto-save.
 *
 * Talks to the dev-only route in vite-plugin-templates.js. Every call is
 * best-effort: in a production build (or with the dev server restarting) the
 * route simply isn't there, and the app has to carry on without it — saving to
 * disk is a convenience while developing, never the source of truth. That is
 * why nothing here throws; callers get `null`/`false` and move on.
 */
const ROUTE = "/__templates";

/** Auto-save's own folder: where a file with no other home is written. */
export const SCRATCH = "scratch";
/** Folders a file opened from them is saved back to (see the plugin). */
export const SAVABLE = new Set([SCRATCH, "examples"]);
/** A folder outside the repo, named in `BD_LINKED_DIRS` — its id starts with this. */
export const LINKED_PREFIX = "linked-";
/** Is a file opened from this folder saved back to it? The server still has the last word. */
export const isSavable = (folder) => SAVABLE.has(folder) || folder.startsWith(LINKED_PREFIX);

/**
 * Is the disk store reachable? Probed once at mount, and the answer is what
 * decides whether the UI mentions templates at all — an editor that offers to
 * save somewhere it cannot write is worse than one that stays quiet.
 * Resolves to `{ dirs, linked, templates }`, each template carrying its
 * `folder`; `linked` is `[{ folder, name, dir, display }]`, one per linked folder.
 */
export async function probeTemplates() {
  try {
    const res = await fetch(ROUTE, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.templates) ? body : null;
  } catch {
    return null;
  }
}

export async function listTemplates() {
  return (await probeTemplates())?.templates ?? [];
}

const pathOf = (folder, file) => `${ROUTE}/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;

/** The document itself — what the dropdown loads back into the editor. */
export async function readTemplate(folder, file) {
  try {
    const res = await fetch(pathOf(folder, file));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** A folder-format tree, as `{ name, files }` — `files` is path → text, ready for `importFolder`. */
export async function readFolderTree(name) {
  try {
    const res = await fetch(`${ROUTE}/folders/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.files === "object" ? body : null;
  } catch {
    return null;
  }
}

/** Auto-save's write — to scratch, or back to the file a document was opened from. */
export async function writeTemplate(folder, file, doc) {
  try {
    const res = await fetch(pathOf(folder, file), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The last write as the page goes away — `keepalive`, so it outlives the tab.
 * Best effort by nature: browsers cap a keepalive body at 64 KB, so a very
 * large diagram closed inside the debounce can still miss its final second.
 */
export function flushTemplate(folder, file, doc) {
  try {
    void fetch(pathOf(folder, file), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Nothing to do on the way out.
  }
}

/**
 * Hear about a template another program changed on disk — the dev server
 * announces it over Vite's HMR socket (see the plugin). Returns the
 * unsubscribe. A built app has no socket, so this quietly does nothing.
 */
const changeListeners = new Set();
if (import.meta.hot) {
  import.meta.hot.on("better-diagrams:template", (data) => {
    for (const listener of changeListeners) listener(data);
  });
}
export function onTemplateChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Auto-save's delete, for a renamed or removed workspace file. Scratch only. */
export async function removeTemplate(file) {
  try {
    await fetch(pathOf(SCRATCH, file), { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}

/**
 * `Payments flow` → `payments-flow.json`. The client owns naming: the server
 * only checks that what arrives is a plain slug (see `safePath`), so this is
 * the one place the rule lives.
 */
export function templateFile(name, fallback) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${slug || fallback}.json`;
}
