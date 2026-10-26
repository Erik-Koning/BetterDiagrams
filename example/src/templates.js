/**
 * templates.js — the client half of auto-save.
 *
 * Talks to the disk store (`@mosphere/better-diagrams/disk`), which the Vite
 * dev server mounts (vite-plugin-templates.js) and `better-diagrams` serves on
 * its own. Every call is best-effort: in a production build (or with the
 * server restarting) the route simply isn't there, and the app has to carry on
 * without it — saving to disk is a convenience while developing, never the
 * source of truth. That is why nothing here throws; callers get `null`/`false`
 * and move on.
 *
 * A disk file is named by a BINDING, `{ folder, file, target? }`: the folder
 * id the store lists it under, its path there, and — for a link in symlinks/ —
 * the file the link pointed at when the binding was made. The store refuses a
 * binding whose link points somewhere else now (`{ moved }`), so a link
 * removed and remade under the same name for another file is never read or
 * written as the file this one was.
 */
const ROUTE = "/__templates";

/** Auto-save's own folder: where a file with no other home is written. */
export const SCRATCH = "scratch";
/** Symlinks to single files elsewhere on disk, made by Link a file… and Save as…. */
export const SYMLINKS = "symlinks";
/** Folders a file opened from them is saved back to (see the store). */
export const SAVABLE = new Set([SCRATCH, "examples", SYMLINKS]);
/** A folder outside the repo, linked from the menu, BD_LINKED_DIRS or the command line — its id starts with this. */
export const LINKED_PREFIX = "linked-";
/** Is a file opened from this folder saved back to it? The server still has the last word. */
export const isSavable = (folder) => SAVABLE.has(folder) || folder.startsWith(LINKED_PREFIX);

const CHANGE_EVENT = "better-diagrams:template";
const LINKS_EVENT = "better-diagrams:links";

/**
 * Is the disk store reachable? Probed once at mount, and the answer is what
 * decides whether the UI mentions templates at all — an editor that offers to
 * save somewhere it cannot write is worse than one that stays quiet.
 * Resolves to `{ dirs, linked, picker, filePicker, savePicker, events,
 * templates }`, each template carrying its `folder`; `linked` is `[{ folder,
 * name, dir, display, source, missing, skipped }]`, one per linked folder —
 * `skipped` counts the JSON files in it that aren't diagrams; `picker`,
 * `filePicker` and `savePicker` say whether the server can show a folder,
 * file or save dialog. A template in symlinks/ also carries `target`, the
 * file its link points at.
 */
export async function probeTemplates() {
  try {
    const res = await fetch(ROUTE, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body?.templates)) return null;
    if (body.events) connectEvents();
    return body;
  } catch {
    return null;
  }
}

const pathOf = ({ folder, file, target }) =>
  `${ROUTE}/${encodeURIComponent(folder)}/${encodeURIComponent(file)}${target ? `?target=${encodeURIComponent(target)}` : ""}`;

/** A refusal that says the binding's link points at another file now. */
async function movedOf(res) {
  if (res.status !== 409) return null;
  const body = await res.json().catch(() => null);
  return body?.moved ? { target: body.target } : null;
}

/**
 * The document at a binding — what the dropdown loads back into the editor.
 * Resolves to `{ doc }`, to `{ moved: { target } }` when the binding's link
 * points at another file now, or to null.
 */
export async function readTemplate(path) {
  try {
    const res = await fetch(pathOf(path));
    if (res.ok) return { doc: await res.json() };
    const moved = await movedOf(res);
    return moved ? { moved } : null;
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

/**
 * Auto-save's write — to scratch, or back to the file a document was opened
 * from. Resolves to `{ ok, status, error, moved? }`: `status` 0 is no server
 * at all (a restart, a built app), anything else is the server refusing — a
 * linked folder gone missing (404), a file there that isn't a diagram (409),
 * a link that points at another file now (409, with `moved`).
 */
export async function writeTemplate(path, doc) {
  try {
    const res = await fetch(pathOf(path), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    const moved = await movedOf(res);
    return { ok: false, status: res.status, error: body?.error ?? res.statusText, ...(moved ? { moved } : {}) };
  } catch {
    return { ok: false, status: 0, error: "the dev server isn't answering" };
  }
}

/** POST JSON to the route; the server's answer, or `{ error }`. */
async function postJson(path, body) {
  try {
    const res = await fetch(`${ROUTE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = await res.json().catch(() => null);
    return res.ok && answer ? answer : { ...(answer ?? {}), error: answer?.error ?? res.statusText };
  } catch {
    return { error: "the dev server isn't answering" };
  }
}

/**
 * Link a folder outside the repo. `{ dir }` links a typed path; `{ pick: true,
 * near }` has the server show the system's folder dialog (opening near
 * `near`); `replaces` names the link a re-link takes over from. Resolves to
 * the server's answer — `{ link, linked, templates, … }` once linked,
 * `{ cancelled }` or `{ unsupported }` from the dialog — or `{ error }`.
 */
export const linkFolder = (body) => postJson("links", body);

/**
 * Link one diagram file from another folder: `{ path }` typed, or `{ pick:
 * true, near? }` through the system's file dialog; `replaces` names a link
 * to re-point instead (its file moved). Resolves to `{ entry, templates, … }`
 * — `entry` is the listing row — or `{ cancelled }`, `{ unsupported }` from
 * the dialog, or `{ error }`. A template in symlinks/ whose file has moved is
 * listed `missing: true`.
 */
export const linkFile = (body) => postJson(SYMLINKS, body);

/**
 * Save a document to a file of the person's choosing and link it as if it
 * had been opened from there: `{ doc, pick: true, name?, near? }` through the
 * system's save dialog (which asks before replacing a file), or `{ doc, path,
 * overwrite? }` typed. Resolves to `{ entry, templates, … }` — `entry` is the
 * listing row to bind to — or `{ cancelled }`, `{ unsupported }`, or `{ error,
 * exists? }`.
 */
export const saveFileAs = (body) => postJson("save-as", body);

/** Remove a file's link — never the file. Resolves to the new listing, or `{ error }`. */
export async function unlinkFile(file) {
  try {
    const res = await fetch(pathOf({ folder: SYMLINKS, file }), { method: "DELETE" });
    const answer = await res.json().catch(() => null);
    return res.ok && answer ? answer : { error: answer?.error ?? res.statusText };
  } catch {
    return { error: "the dev server isn't answering" };
  }
}

/** Unlink a folder linked from the app. Resolves to the new listing, or `{ error }`. */
export async function unlinkFolder(folder) {
  try {
    const res = await fetch(`${ROUTE}/links/${encodeURIComponent(folder)}`, { method: "DELETE" });
    const answer = await res.json().catch(() => null);
    return res.ok && answer ? answer : { error: answer?.error ?? res.statusText };
  } catch {
    return { error: "the dev server isn't answering" };
  }
}

/**
 * The last write as the page goes away — `keepalive`, so it outlives the tab.
 * Best effort by nature: browsers cap a keepalive body at 64 KB, so a very
 * large diagram closed inside the debounce can still miss its final second.
 */
export function flushTemplate(path, doc) {
  try {
    void fetch(pathOf(path), {
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
 * Hear about a template another program changed on disk. Under `vite dev`
 * the server announces it over Vite's HMR socket; served by `better-diagrams`
 * (a built app, no socket) it streams the same events, which the probe
 * connects to when the listing says so. Returns the unsubscribe.
 */
const changeListeners = new Set();
const linksListeners = new Set();
const dispatch = (listeners, data) => {
  for (const listener of listeners) listener(data);
};
if (import.meta.hot) {
  import.meta.hot.on(CHANGE_EVENT, (data) => dispatch(changeListeners, data));
  import.meta.hot.on(LINKS_EVENT, (data) => dispatch(linksListeners, data));
}
let events = null;
function connectEvents() {
  if (import.meta.hot || events || typeof EventSource === "undefined") return;
  // EventSource reconnects by itself, so a restarted server picks up where it left off.
  events = new EventSource(`${ROUTE}/events`);
  const on = (name, listeners) =>
    events.addEventListener(name, (event) => {
      try {
        dispatch(listeners, JSON.parse(event.data));
      } catch {
        // A frame that isn't JSON: nothing to tell anyone.
      }
    });
  on(CHANGE_EVENT, changeListeners);
  on(LINKS_EVENT, linksListeners);
}
export function onTemplateChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Hear about a linked folder (or a symlinked file) vanishing under the server — moved, renamed, deleted. */
export function onLinksChange(listener) {
  linksListeners.add(listener);
  return () => linksListeners.delete(listener);
}

/** Auto-save's delete, for a renamed or removed workspace file. Scratch only. */
export async function removeTemplate(file) {
  try {
    await fetch(pathOf({ folder: SCRATCH, file }), { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}
