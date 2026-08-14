/**
 * schema-lint.ts — warning-level lint for everything the diagram validators
 * repair SILENTLY: keys the schema doesn't define, enum values it doesn't
 * know, references to ids the document never declares, and dates it can't
 * read.
 *
 * The validators deliberately coerce or drop rather than reject, so a
 * document that carries any of these still loads — but the user only finds
 * out by noticing something missing. This surfaces each case in the JSON
 * editor as a yellow warning whose message states the validator's TRUE
 * consequence ("the whole edge will be dropped on insert") — never an error:
 * Insert stays available.
 *
 * Positions come from the Lezer JSON syntax tree, so a warning underlines
 * exactly the offending property name or value. Reference pools come from a
 * JSON.parse of the document — when it doesn't parse, reference checks are
 * skipped wholesale (fewer warnings, never wrong ones) while key/value/date
 * checks still run off the partial tree.
 *
 * Accepted under-reporting, by design: non-string values under checked keys
 * (the validator repairs them, a different error class); ordering-only
 * violations (an activation `to` before its `from`); and compound failures
 * on one element, which may draw two overlapping-but-individually-true
 * warnings.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  EDGE_COLORS,
  EDGE_DIRECTIONS,
  EDGE_KEYS,
  EDGE_ROUTINGS,
  EDGE_STYLES,
  FIELD_KEYS,
  ICON_NAMES,
  NODE_FIELD_KEYS,
  NODE_KEYS,
  NODE_KINDS,
  NODE_STATUSES,
  PROVIDER_IDS,
  TEMPLATE_KEYS,
  validateTemplate,
} from "../contract/schema";
import { ZONE_KEYS, ZONE_OUTLINES, ZONE_SHAPES } from "../contract/zones";
import {
  ACTIVATION_KEYS,
  FRAGMENT_ELSE_KEYS,
  FRAGMENT_KEYS,
  FRAGMENT_KINDS,
  MESSAGE_KEYS,
  MESSAGE_STYLES,
  NOTE_KEYS,
  NOTE_SIDES,
  PARTICIPANT_KEYS,
  PARTICIPANT_KINDS,
  SEQUENCE_KEYS,
  validateSequence,
} from "../contract/sequence";
import { ALL_CLOUD_KIND_IDS } from "../contract/cloud";
import { normalizeDate } from "../contract/timeline";

/**
 * Allowed keys for the object at `path` (array indices normalised to "*"),
 * or null for "anything goes" — unknown structures and `meta`, whose index
 * signature admits arbitrary keys.
 */
export type KeyLookup = (path: readonly string[]) => readonly string[] | null;

/** An enum-ish string field checked against a vocabulary. */
interface ValueRule {
  path: string;
  key: string;
  allowed: ReadonlySet<string>;
  /** "kind" — names the field class in the message. */
  noun: string;
  /** "a node kind" — the phrase after "not …". */
  describe: string;
  /** Full trailing sentence stating the validator's handling. */
  consequence: string;
  /** The value is an array of strings — check each entry (providers). */
  each?: boolean;
}

/** A field whose string value must name an id declared elsewhere in the doc. */
interface RefRule {
  path: string;
  key: string;
  pool: "node" | "zone" | "field" | "participant" | "message";
  /** null / "" / absent are legal (lost/found messages, unparented nodes). */
  optional?: boolean;
  noun: string;
  consequence: string;
}

interface DateRule {
  path: string;
  key: string;
}

export interface JsonDocLint {
  /** Names the schema in messages — "architecture" | "sequence". */
  name: string;
  keys: KeyLookup;
  values: ValueRule[];
  refs: RefRule[];
  dates: DateRule[];
  /** zones.*.provider must be a member of the SAME zone's `providers` array. */
  sibling?: { path: string; key: string; arrayKey: string };
  /** Id pools for RefRules, from the JSON.parse'd document. */
  refPools?: (parsed: unknown) => Record<string, ReadonlySet<string>>;
}

// ─── Key lookups ─────────────────────────────────────────────────────────────

const architectureKeyLookup: KeyLookup = (path) => {
  switch (path.join(".")) {
    case "":
      return TEMPLATE_KEYS;
    case "nodes.*":
      return NODE_KEYS;
    case "nodes.*.fields.*":
      return NODE_FIELD_KEYS;
    case "edges.*":
      return EDGE_KEYS;
    case "zones.*":
      return ZONE_KEYS;
    default:
      return null;
  }
};

const sequenceKeyLookup: KeyLookup = (path) => {
  switch (path.join(".")) {
    case "":
      return SEQUENCE_KEYS;
    case "participants.*":
      return PARTICIPANT_KEYS;
    case "messages.*":
      return MESSAGE_KEYS;
    case "activations.*":
      return ACTIVATION_KEYS;
    case "fragments.*":
      return FRAGMENT_KEYS;
    case "fragments.*.elses.*":
      return FRAGMENT_ELSE_KEYS;
    case "notes.*":
      return NOTE_KEYS;
    default:
      return null;
  }
};

// ─── Ref pools ───────────────────────────────────────────────────────────────

/** String `id`s from a raw array of objects — tolerant of any malformed entry. */
function rawIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((el) => (el && typeof el === "object" ? (el as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

/**
 * Pools are RAW ids ∪ VALIDATED-doc ids. Raw keeps references to duplicated
 * ids resolving (the validator suffixes the second occurrence, not the
 * first); validated adds the ids the validator INVENTS — sequence documents
 * may omit ids entirely and get "p1"/"m1" generated, where a raw-only pool
 * would emit a wrong "will be dropped" warning. Dropped-but-declared ids stay
 * in via the raw side, which keeps cascades single-reported: an activation
 * naming a doomed message's id stays quiet; only the root cause warns.
 */
function architecturePools(parsed: unknown): Record<string, ReadonlySet<string>> {
  const doc = parsed as { nodes?: unknown; zones?: unknown };
  const node = new Set(rawIds(doc?.nodes));
  const zone = new Set(rawIds(doc?.zones));
  // Every field id in the document, not just the ones on this edge's own
  // endpoints. A pool is global by construction, so this catches the typo it
  // can catch and stays quiet about the rest — a warning that fires on a valid
  // reference would be worse than one that misses an invalid one.
  const field = new Set<string>();
  for (const n of Array.isArray(doc?.nodes) ? doc.nodes : []) {
    for (const f of Array.isArray((n as { fields?: unknown })?.fields)
      ? ((n as { fields: unknown[] }).fields)
      : []) {
      const id = (f as { id?: unknown })?.id;
      if (typeof id === "string" && id) field.add(id);
    }
  }
  try {
    const validated = validateTemplate(parsed);
    for (const n of validated.nodes) {
      node.add(n.id);
      for (const f of n.fields ?? []) field.add(f.id);
    }
    for (const z of validated.zones ?? []) zone.add(z.id);
  } catch {
    // Unvalidatable doc — the raw pools still serve.
  }
  return { node, zone, field };
}

function sequencePools(parsed: unknown): Record<string, ReadonlySet<string>> {
  const doc = parsed as { participants?: unknown; messages?: unknown };
  const participant = new Set(rawIds(doc?.participants));
  const message = new Set(rawIds(doc?.messages));
  try {
    const validated = validateSequence(parsed);
    for (const p of validated.participants) participant.add(p.id);
    for (const m of validated.messages) message.add(m.id);
  } catch {
    // Unvalidatable doc — the raw pools still serve.
  }
  return { participant, message };
}

// ─── Specs ───────────────────────────────────────────────────────────────────

const setOf = (...lists: (readonly string[] | undefined)[]): ReadonlySet<string> =>
  new Set(lists.flatMap((list) => [...(list ?? [])]));

const PROVIDER_CONSEQUENCE =
  "It is kept on insert, but the element will be hidden while its zone shows a known provider.";

/**
 * The architecture spec. Vocabularies union the builtins with the live
 * registry's — mirroring how validateTemplate builds its kind/icon sets — so
 * a custom kind lints clean exactly where it inserts clean.
 */
export function buildArchitectureLint(
  vocab: {
    kinds?: readonly string[];
    icons?: readonly string[];
    providers?: readonly string[];
  } = {},
): JsonDocLint {
  // Cloud pack ids are base vocabulary, exactly as validateTemplate treats them.
  const kinds = setOf(NODE_KINDS, ALL_CLOUD_KIND_IDS, vocab.kinds);
  const icons = setOf(ICON_NAMES, vocab.icons);
  const providers = setOf(PROVIDER_IDS, vocab.providers);
  const providersRule = (path: string): ValueRule => ({
    path,
    key: "providers",
    allowed: providers,
    noun: "provider",
    describe: "a provider",
    consequence: PROVIDER_CONSEQUENCE,
    each: true,
  });
  return {
    name: "architecture",
    keys: architectureKeyLookup,
    values: [
      { path: "nodes.*", key: "kind", allowed: kinds, noun: "kind", describe: "a node kind", consequence: 'It will be inserted as "service".' },
      { path: "nodes.*", key: "icon", allowed: icons, noun: "icon", describe: "an icon", consequence: 'It will be inserted as "none".' },
      { path: "nodes.*", key: "status", allowed: setOf(NODE_STATUSES), noun: "status", describe: "a status", consequence: "It will be ignored." },
      { path: "nodes.*.fields.*", key: "key", allowed: setOf(FIELD_KEYS), noun: "field key", describe: "a key role", consequence: "It will be ignored (the row renders without a key badge)." },
      { path: "edges.*", key: "style", allowed: setOf(EDGE_STYLES), noun: "edge style", describe: "an edge style", consequence: 'It will be inserted as "solid".' },
      { path: "edges.*", key: "color", allowed: setOf(EDGE_COLORS), noun: "edge color", describe: "an edge color", consequence: 'It will be inserted as "slate".' },
      { path: "edges.*", key: "direction", allowed: setOf(EDGE_DIRECTIONS), noun: "direction", describe: "a direction", consequence: "It will be ignored (the edge defaults to forward)." },
      { path: "edges.*", key: "routing", allowed: setOf(EDGE_ROUTINGS), noun: "routing", describe: "a routing", consequence: "It will be ignored (the edge inherits the diagram default)." },
      { path: "zones.*", key: "shape", allowed: setOf(ZONE_SHAPES), noun: "zone shape", describe: "a zone shape", consequence: 'It will be inserted as "rounded".' },
      { path: "zones.*", key: "outline", allowed: setOf(ZONE_OUTLINES), noun: "zone outline", describe: "a zone outline", consequence: "It will be ignored (the outline stays solid)." },
      providersRule("nodes.*"),
      providersRule("edges.*"),
      providersRule("zones.*"),
    ],
    refs: [
      { path: "edges.*", key: "source", pool: "node", noun: "node id", consequence: "The whole edge will be dropped on insert." },
      { path: "edges.*", key: "target", pool: "node", noun: "node id", consequence: "The whole edge will be dropped on insert." },
      { path: "nodes.*", key: "parentId", pool: "node", optional: true, noun: "node id", consequence: "It will be cleared on insert." },
      { path: "nodes.*", key: "zoneId", pool: "zone", optional: true, noun: "zone id", consequence: "It will be cleared on insert." },
      { path: "edges.*", key: "startField", pool: "field", optional: true, noun: "field id", consequence: "It will be cleared on insert (the line attaches to the box)." },
      { path: "edges.*", key: "endField", pool: "field", optional: true, noun: "field id", consequence: "It will be cleared on insert (the line attaches to the box)." },
    ],
    dates: [
      { path: "nodes.*", key: "date" },
      { path: "edges.*", key: "date" },
      { path: "zones.*", key: "date" },
    ],
    sibling: { path: "zones.*", key: "provider", arrayKey: "providers" },
    refPools: architecturePools,
  };
}

/** The sequence spec — nothing in it is registry-extensible, so a constant. */
export const SEQUENCE_LINT: JsonDocLint = {
  name: "sequence",
  keys: sequenceKeyLookup,
  values: [
    { path: "participants.*", key: "kind", allowed: setOf(PARTICIPANT_KINDS), noun: "kind", describe: "a participant kind", consequence: 'It will be inserted as "service".' },
    { path: "participants.*", key: "status", allowed: setOf(NODE_STATUSES), noun: "status", describe: "a status", consequence: "It will be ignored." },
    { path: "messages.*", key: "style", allowed: setOf(MESSAGE_STYLES), noun: "message style", describe: "a message style", consequence: 'It will be inserted as "sync".' },
    { path: "fragments.*", key: "kind", allowed: setOf(FRAGMENT_KINDS), noun: "fragment kind", describe: "a fragment kind", consequence: 'It will be inserted as "opt".' },
    { path: "notes.*", key: "side", allowed: setOf(NOTE_SIDES), noun: "note side", describe: "a note side", consequence: 'It will be inserted as "right".' },
  ],
  refs: [
    { path: "messages.*", key: "from", pool: "participant", optional: true, noun: "participant id", consequence: "The whole message will be dropped on insert." },
    { path: "messages.*", key: "to", pool: "participant", optional: true, noun: "participant id", consequence: "The whole message will be dropped on insert." },
    { path: "activations.*", key: "participant", pool: "participant", noun: "participant id", consequence: "The activation bar will be dropped on insert." },
    { path: "activations.*", key: "from", pool: "message", noun: "message id", consequence: "The activation bar will be dropped on insert." },
    { path: "activations.*", key: "to", pool: "message", optional: true, noun: "message id", consequence: "It will be ignored on insert (the bar runs to the end of the lifeline)." },
    { path: "fragments.*", key: "from", pool: "message", noun: "message id", consequence: "The whole fragment will be dropped on insert." },
    { path: "fragments.*", key: "to", pool: "message", noun: "message id", consequence: "The whole fragment will be dropped on insert." },
    { path: "fragments.*.elses.*", key: "at", pool: "message", noun: "message id", consequence: "The branch divider will be dropped on insert." },
    { path: "notes.*", key: "participant", pool: "participant", noun: "participant id", consequence: "The whole note will be dropped on insert." },
    { path: "notes.*", key: "across", pool: "participant", optional: true, noun: "participant id", consequence: "It will be ignored on insert." },
    { path: "notes.*", key: "at", pool: "message", optional: true, noun: "message id", consequence: "It will be ignored on insert." },
  ],
  dates: [
    { path: "participants.*", key: "date" },
    { path: "messages.*", key: "date" },
  ],
  refPools: sequencePools,
};

// ─── Suggestions ─────────────────────────────────────────────────────────────

/** Small-edit distance, for "did you mean" on obvious typos. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

function nearest(value: string, known: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of known) {
    const distance = editDistance(value.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

const suggest = (value: string, known: Iterable<string>): string => {
  const hit = nearest(value, known);
  return hit ? ` (did you mean "${hit}"?)` : "";
};

// ─── The walk ────────────────────────────────────────────────────────────────

const ruleKey = (path: string, key: string) => `${path}\0${key}`;

/**
 * All diagnostics for the document under `lint`: unknown keys, unknown
 * values, dangling references, sibling-membership, unreadable dates. Always
 * severity "warning" — this lint informs, it never blocks.
 */
export function docDiagnostics(state: EditorState, lint: JsonDocLint): Diagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const diagnostics: Diagnostic[] = [];

  let pools: Record<string, ReadonlySet<string>> | null = null;
  if (lint.refPools) {
    try {
      pools = lint.refPools(JSON.parse(state.doc.toString()));
    } catch {
      pools = null; // half-typed doc: skip refs rather than mis-warn
    }
  }

  const valueRules = new Map(lint.values.map((r) => [ruleKey(r.path, r.key), r]));
  const refRules = new Map(lint.refs.map((r) => [ruleKey(r.path, r.key), r]));
  const dateRules = new Set(lint.dates.map((r) => ruleKey(r.path, r.key)));

  const stringAt = (from: number, to: number): string => {
    const raw = state.doc.sliceString(from, to);
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.replace(/^"|"$/g, "");
    }
  };

  const warn = (node: SyntaxNode, message: string) =>
    diagnostics.push({ from: node.from, to: node.to, severity: "warning", message });

  const checkValue = (node: SyntaxNode, rule: ValueRule) => {
    const value = stringAt(node.from, node.to);
    if (rule.allowed.has(value)) return;
    warn(
      node,
      `Unknown ${rule.noun} "${value}" — not ${rule.describe} this editor knows` +
        `${suggest(value, rule.allowed)}. ${rule.consequence}`,
    );
  };

  const checkRef = (node: SyntaxNode, rule: RefRule) => {
    const pool = pools?.[rule.pool];
    if (!pool) return;
    const value = stringAt(node.from, node.to);
    if (rule.optional && value === "") return;
    if (pool.has(value) || pool.has(value.trim())) return;
    warn(
      node,
      `Unknown ${rule.noun} "${value}" — nothing in this document declares it` +
        `${suggest(value, pool)}. ${rule.consequence}`,
    );
  };

  const walkValue = (node: SyntaxNode, path: string[]): void => {
    if (node.name === "Object") {
      const pathId = path.join(".");
      const allowed = lint.keys(path);

      // The zone-local provider list, gathered before judging `provider`.
      let siblingList: string[] | null = null;
      if (lint.sibling && pathId === lint.sibling.path) {
        for (let prop = node.firstChild; prop; prop = prop.nextSibling) {
          if (prop.name !== "Property") continue;
          const nameNode = prop.getChild("PropertyName");
          const value = prop.lastChild;
          if (!nameNode || !value) continue;
          if (stringAt(nameNode.from, nameNode.to) !== lint.sibling.arrayKey) continue;
          if (value.name !== "Array") continue;
          siblingList = [];
          for (let entry = value.firstChild; entry; entry = entry.nextSibling) {
            if (entry.name === "String") siblingList.push(stringAt(entry.from, entry.to));
          }
        }
      }

      for (let prop = node.firstChild; prop; prop = prop.nextSibling) {
        if (prop.name !== "Property") continue;
        const nameNode = prop.getChild("PropertyName");
        if (!nameNode) continue;
        const key = stringAt(nameNode.from, nameNode.to);
        if (allowed && !allowed.includes(key)) {
          warn(
            nameNode,
            `Unknown key "${key}" — not part of the ${lint.name} schema` +
              `${suggest(key, allowed)}. It will be ignored on insert.`,
          );
        }
        const value = prop.lastChild;
        if (!value || value.from < nameNode.to) continue;

        const id = ruleKey(pathId, key);
        const valueRule = valueRules.get(id);
        if (valueRule) {
          if (valueRule.each && value.name === "Array") {
            for (let entry = value.firstChild; entry; entry = entry.nextSibling) {
              if (entry.name === "String") checkValue(entry, valueRule);
            }
          } else if (value.name === "String") {
            checkValue(value, valueRule);
          }
        }

        const refRule = refRules.get(id);
        if (refRule && value.name === "String") checkRef(value, refRule);

        if (dateRules.has(id) && value.name === "String") {
          const date = stringAt(value.from, value.to);
          if (date !== "" && normalizeDate(date) === undefined) {
            warn(
              value,
              `Unrecognisable date "${date}" — expected something like "2026-03-14". ` +
                "It will be ignored on insert.",
            );
          }
        }

        if (
          lint.sibling &&
          pathId === lint.sibling.path &&
          key === lint.sibling.key &&
          siblingList?.length &&
          value.name === "String"
        ) {
          const provider = stringAt(value.from, value.to);
          if (!siblingList.includes(provider)) {
            warn(
              value,
              `"${provider}" is not one of this zone's providers` +
                `${suggest(provider, siblingList)}. It will fall back to "${siblingList[0]}", ` +
                "the first provider the zone lists.",
            );
          }
        }

        walkValue(value, [...path, key]);
      }
    } else if (node.name === "Array") {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "Object" || child.name === "Array") {
          walkValue(child, [...path, "*"]);
        }
      }
    }
  };

  const top = tree.topNode.firstChild;
  if (top) walkValue(top, []);
  return diagnostics;
}
