/**
 * documents.js — what a host does with a diagram file, shared by every place
 * Better Diagrams shows one: this app (which the `better-diagrams` command
 * serves) and the VS Code extension's editor (packages/vscode). Both read a
 * file through these, render it with the same registry and the same view
 * settings, and warn about the same losses, so a diagram looks and behaves
 * the same wherever it is opened.
 */
import {
  DARK_THEME,
  LIGHT_THEME,
  validateSequence,
  validateTemplate,
  validateTemplateReport,
} from "@mosphere/better-diagrams";
import { registry } from "./extensions.js";

export { registry };

/**
 * Registry-aware, like the folder import in App.jsx: a plain
 * `validateTemplate` knows only the built-in kinds and rewrites every other
 * one to "service", so a data model read back from localStorage or a
 * template file would lose its entities before the studio ever saw it.
 */
export const VALIDATE = { knownKinds: Object.keys(registry.nodeKinds) };

/** Which editor a document read from a file belongs in — as the disk store's listing says. */
export const kindOf = (doc) => (Array.isArray(doc?.participants) ? "sequence" : "architecture");

export const validateDoc = (kind, doc) =>
  kind === "sequence" ? validateSequence(doc) : validateTemplate(doc, VALIDATE);

/**
 * What saving `doc` — validated from `raw`, a file read from disk — would
 * drop from that file: one sentence each. Validation repairs rather than
 * rejects, so a key this editor doesn't know, a value outside its vocabulary
 * or an edge to nowhere loads fine and is simply gone from the next save.
 * Architecture files get the library's own report; a sequence, the keys that
 * didn't survive.
 */
export function lossOf(kind, raw, doc) {
  if (kind !== "sequence") return validateTemplateReport(raw, VALIDATE).issues.map((issue) => issue.message);
  const lost = [];
  const walk = (given, kept, at) => {
    if (Array.isArray(given)) {
      const keptById = new Map((Array.isArray(kept) ? kept : []).map((el) => [el?.id, el]));
      given.forEach((el, i) => {
        const match = el && typeof el === "object" && "id" in el ? keptById.get(el.id) : Array.isArray(kept) ? kept[i] : undefined;
        if (match === undefined) lost.push(`${at}/${i} isn't something a sequence keeps, so it was dropped.`);
        else walk(el, match, `${at}/${i}`);
      });
      return;
    }
    if (!given || typeof given !== "object") return;
    for (const [key, value] of Object.entries(given)) {
      if (value === undefined || value === null || value === "") continue;
      if (!kept || typeof kept !== "object" || !(key in kept)) lost.push(`"${key}" at ${at || "/"} isn't a sequence property, so it was dropped.`);
      else walk(value, kept[key], `${at}/${key}`);
    }
  };
  walk(raw, doc, "");
  return lost;
}

/**
 * `Payments flow` → `payments-flow.json`. The client owns naming: the disk
 * store only checks that what arrives is a plain slug (see `safePath`), so
 * this is the one place the rule lives — the VS Code editor finds a
 * `file:Payments flow` link's diagram by it too.
 */
export function templateFile(name, fallback) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${slug || fallback}.json`;
}

/**
 * How the editors are first shown. The app's Settings menu starts here; the
 * VS Code editor has no such menu and keeps them, taking only light or dark
 * from VS Code's own theme.
 */
export const DEFAULT_VIEW = {
  /** "light" | "dark" */
  mode: "light",
  /** The studio's presentation mode, independent of light/dark. */
  studioMode: "marketing",
  /** Marketing's one setting: its gradients, or one flat coat per card. */
  gradients: false,
  minimap: false,
  /** Draw a connection only while the pointer is over a node it touches. */
  edgesOnHover: false,
};

/**
 * The studio's `theme` for a mode. LIGHT_THEME is a complete token set; dark
 * is the stylesheet's default, so it needs no theme at all. Either way a
 * hand-picked accent wins.
 */
export const studioTheme = (mode, accent) => ({
  ...(mode === "light" ? LIGHT_THEME : {}),
  ...(accent ? { accent } : {}),
});

/**
 * A COMPLETE token set, for anything rendered OUTSIDE the studio roots (a
 * modal of the host's own): the empty-dark shorthand above would leave every
 * --as-* variable undefined out there.
 */
export const completeTheme = (mode, accent) => ({
  ...(mode === "light" ? LIGHT_THEME : DARK_THEME),
  ...(accent ? { accent } : {}),
});
