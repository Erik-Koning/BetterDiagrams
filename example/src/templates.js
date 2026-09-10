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

/** The one folder the route lets the app write to; the other is read-only. */
export const SCRATCH = "scratch";

/**
 * Is the disk store reachable? Probed once at mount, and the answer is what
 * decides whether the UI mentions templates at all — an editor that offers to
 * save somewhere it cannot write is worse than one that stays quiet.
 * Resolves to `{ dirs, templates }`, each template carrying its `folder`.
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

/** Auto-save's write. Scratch only — the route refuses anything else. */
export async function writeTemplate(file, doc) {
  try {
    const res = await fetch(pathOf(SCRATCH, file), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    return res.ok;
  } catch {
    return false;
  }
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
