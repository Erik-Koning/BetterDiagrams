/**
 * A real diagram with its words taken out, for the gallery.
 *
 * Only what is listed here is copied, so a key nobody thought of is left
 * behind rather than let through:
 *
 * - Ids are renumbered: nodes n1…, zones z1…, edges e1…, a node's fields f1…,
 *   providers p1…. Everything that names one (parentId, zoneId, source, target,
 *   startField, endField, providers) follows.
 * - Words become pseudo-words of the same shape: labels, descriptions, a line's
 *   tech and end labels, field names, types and descriptions. Every letter and
 *   digit of any script is replaced; spaces, punctuation and case stay, so boxes
 *   and labels keep their sizes. A cardinality at a line's end ("1", "*",
 *   "0..n") stays as it is. A relation becomes one pseudo-word per relation,
 *   except "dependency", which changes how a line is drawn.
 * - Geometry and the choices that decide the drawing are kept as they are:
 *   positions and sizes, kind and icon (the registry's vocabulary, not the
 *   author's), text alignment, frame styling, line style, heads, routing,
 *   anchors and waypoints, a task's points, stage and priority.
 * - From `settings`, only how the document is arranged and drawn: `arrange`
 *   (not "roadmap", whose dates are gone), `layout`, `notation`,
 *   `groupContents`. From `meta`, only `routing`.
 * - Everything else is dropped: tags, links, teams, assignees, statuses, dates,
 *   host data, saved paths and analyses, lineage, people's capacity, titles.
 *
 *   node scripts/gallery/anonymise.mjs <in.json> <out.json> [--seed 7]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VOWELS = "aeiou";
const CONSONANTS = "bcdfghklmnprstvz";
/** The one relation the drawing treats differently (`DEPENDENCY_RELATION`). */
const DEPENDENCY = "dependency";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Same shape, other letters: case, spaces and punctuation are kept. A letter of
 * any alphabet becomes a Latin one, and a digit of any kind a digit, so a name
 * in Cyrillic or kanji is gone as surely as one in English.
 */
export function pseudo(text, random) {
  let vowel = random() < 0.5;
  let out = "";
  for (const ch of String(text)) {
    if (/\p{L}/u.test(ch)) {
      const pool = vowel ? VOWELS : CONSONANTS;
      const letter = pool[Math.floor(random() * pool.length)];
      // A script with no case reads as lower case.
      out += ch !== ch.toLowerCase() ? letter.toUpperCase() : letter;
      vowel = !vowel;
    } else if (/\p{N}/u.test(ch)) {
      out += String(Math.floor(random() * 10));
    } else {
      out += ch;
      vowel = random() < 0.5;
    }
  }
  return out;
}

/** A cardinality at a line's end: "1", "*", "0..1", "1..n". Nothing else is short enough to be safe. */
const isMark = (value) => /^([01nm*+?]|[01nm]\.\.[1nm*])$/i.test(value);

/** A value from a fixed vocabulary ("dashed", "#38bdf8", "aws-s3"): no spaces, so no sentence. */
const isToken = (value) => typeof value === "string" && /^[#\w.:-]{1,48}$/.test(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

const NODE_NUMBERS = ["x", "y", "w", "h", "fontSize", "opacity", "storyPoints", "capacity"];
const NODE_FLAGS = ["wrap", "fill", "locked", "plain", "collapsed", "done"];
const NODE_TOKENS = ["kind", "icon", "textAlign", "textVAlign", "outline", "color", "stage", "priority"];
const FIELD_FLAGS = ["required", "unique", "derived"];
const EDGE_NUMBERS = ["labelT", "seq"];
const EDGE_FLAGS = ["secondary"];
const EDGE_TOKENS = ["style", "color", "direction", "startHead", "endHead", "routing"];
const ZONE_NUMBERS = ["x", "y", "w", "h", "opacity", "z"];
const ZONE_FLAGS = ["fill", "locked"];
const ZONE_TOKENS = ["shape", "color", "outline"];
const SETTINGS_TOKENS = ["arrange", "notation", "groupContents"];
const LAYOUT_TOKENS = ["algorithm", "direction", "inner", "shape", "spacing", "ends"];
const LAYOUT_NUMBERS = ["rankGap", "nodeGap"];

/** Copy the listed keys whose values are what they should be. */
function keep(from, out, keys, ok) {
  for (const key of keys) if (ok(from[key])) out[key] = from[key];
}

const pointsOf = (value) =>
  Array.isArray(value) && value.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNumber)) ? value : null;

function anchorOf(value) {
  if (!value || typeof value !== "object" || !isToken(value.side)) return null;
  const out = { side: value.side };
  if (isNumber(value.t)) out.t = value.t;
  if (value.auto === true) out.auto = true;
  return out;
}

export function anonymise(doc, seed = 7) {
  const random = rng(seed);
  const word = (value) => (typeof value === "string" && value ? pseudo(value, random) : "");
  const nodeIds = new Map((doc.nodes ?? []).map((n, i) => [n.id, `n${i + 1}`]));
  const zoneIds = new Map((doc.zones ?? []).map((z, i) => [z.id, `z${i + 1}`]));
  const providerIds = new Map();
  const provider = (id) => {
    if (!providerIds.has(id)) providerIds.set(id, `p${providerIds.size + 1}`);
    return providerIds.get(id);
  };
  const providersOf = (value) => (Array.isArray(value) ? value.filter((p) => typeof p === "string").map(provider) : null);
  const relations = new Map();
  const relation = (name) => {
    if (name === DEPENDENCY) return name;
    if (!relations.has(name)) relations.set(name, pseudo(name, random).toLowerCase());
    return relations.get(name);
  };
  /** Per node: what a line may call one of its fields (its id, else its name), and the id it has now. */
  const fieldIds = new Map();

  // Zones first, so a provider met on a zone and on a node gets one number.
  const zones = (doc.zones ?? []).map((z) => {
    const out = { id: zoneIds.get(z.id), label: word(z.label) };
    keep(z, out, ZONE_TOKENS, isToken);
    keep(z, out, ZONE_NUMBERS, isNumber);
    keep(z, out, ZONE_FLAGS, (v) => typeof v === "boolean");
    const points = pointsOf(z.points);
    if (points) out.points = points;
    const providers = providersOf(z.providers);
    if (providers) out.providers = providers;
    if (typeof z.provider === "string") out.provider = provider(z.provider);
    return out;
  });

  const nodes = (doc.nodes ?? []).map((n) => {
    const out = { id: nodeIds.get(n.id), label: word(n.label) };
    keep(n, out, NODE_TOKENS, isToken);
    if (typeof n.description === "string") out.description = word(n.description);
    if (Array.isArray(n.fields)) {
      const ids = new Map();
      out.fields = n.fields
        .filter((f) => f && typeof f === "object")
        .map((f, i) => {
          const id = `f${i + 1}`;
          // A line names a field by its id; a name stands in where a field has none.
          if (typeof f.name === "string" && !ids.has(f.name)) ids.set(f.name, id);
          return { f, id };
        })
        .map(({ f, id }) => {
          if (f.id != null) ids.set(f.id, id);
          const field = { id, name: word(f.name ?? "field") };
          if (typeof f.type === "string") field.type = word(f.type);
          if (isToken(f.key)) field.key = f.key;
          keep(f, field, FIELD_FLAGS, (v) => typeof v === "boolean");
          if (typeof f.description === "string" && f.description) field.description = word(f.description);
          return field;
        });
      fieldIds.set(n.id, ids);
    }
    if ("parentId" in n) out.parentId = n.parentId == null ? null : (nodeIds.get(n.parentId) ?? null);
    if ("zoneId" in n) out.zoneId = n.zoneId == null ? null : (zoneIds.get(n.zoneId) ?? null);
    keep(n, out, NODE_NUMBERS, isNumber);
    keep(n, out, NODE_FLAGS, (v) => typeof v === "boolean");
    const providers = providersOf(n.providers);
    if (providers) out.providers = providers;
    return out;
  });

  const edges = (doc.edges ?? []).map((e, i) => {
    // A line to a box that isn't there is dropped on validation anyway, and its end would be an id nobody renumbered.
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) return null;
    const out = { id: `e${i + 1}`, source: nodeIds.get(e.source), target: nodeIds.get(e.target), label: word(e.label) };
    keep(e, out, EDGE_NUMBERS, isNumber);
    keep(e, out, EDGE_TOKENS, isToken);
    keep(e, out, EDGE_FLAGS, (v) => typeof v === "boolean");
    if (typeof e.tech === "string" && e.tech) out.tech = word(e.tech);
    if (typeof e.relation === "string" && e.relation) out.relation = relation(e.relation);
    for (const key of ["startLabel", "endLabel"]) {
      if (typeof e[key] === "string" && e[key]) out[key] = isMark(e[key]) ? e[key] : word(e[key]);
    }
    // A line tied to a row stays tied to it. One that names no row of its box
    // was tied to nothing, and its name is a word like any other: dropped.
    const startField = fieldIds.get(e.source)?.get(e.startField);
    const endField = fieldIds.get(e.target)?.get(e.endField);
    if (startField) out.startField = startField;
    if (endField) out.endField = endField;
    for (const key of ["start", "end"]) {
      const anchor = anchorOf(e[key]);
      if (anchor) out[key] = anchor;
    }
    const points = pointsOf(e.points);
    if (points) out.points = points;
    const providers = providersOf(e.providers);
    if (providers) out.providers = providers;
    return out;
  }).filter(Boolean);

  const result = { version: isNumber(doc.version) ? doc.version : 1, nodes, edges };
  if (zones.length) result.zones = zones;

  const from = doc.settings && typeof doc.settings === "object" ? doc.settings : {};
  const settings = {};
  keep(from, settings, SETTINGS_TOKENS, isToken);
  // A roadmap is placed by its dates, and those are gone.
  if (settings.arrange === "roadmap") delete settings.arrange;
  if (from.layout && typeof from.layout === "object") {
    const layout = {};
    keep(from.layout, layout, LAYOUT_TOKENS, isToken);
    keep(from.layout, layout, LAYOUT_NUMBERS, isNumber);
    if (Object.keys(layout).length) settings.layout = layout;
  }
  if (Object.keys(settings).length) result.settings = settings;
  if (isToken(doc.meta?.routing)) result.meta = { routing: doc.meta.routing };
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--seed");
  const seedAt = process.argv.indexOf("--seed");
  const seed = seedAt > 0 ? Number(process.argv[seedAt + 1]) : 7;
  if (!input || !output || !Number.isFinite(seed)) {
    console.error("usage: node scripts/gallery/anonymise.mjs <in.json> <out.json> [--seed 7]");
    process.exit(2);
  }
  writeFileSync(output, `${JSON.stringify(anonymise(JSON.parse(readFileSync(input, "utf8")), seed), null, 2)}\n`);
}
