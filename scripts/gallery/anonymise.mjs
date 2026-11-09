/**
 * A real diagram with its words taken out, for the gallery: every id is
 * renumbered, every free-text value becomes pseudo-words of the same length
 * (so boxes, labels and line words keep their sizes), and anything personal or
 * incidental — tags, links, teams, dates, data, saved paths, meta — is dropped.
 * Geometry, kinds, icons, styles and anchors stay, since they are the layout.
 *
 *   node scripts/gallery/anonymise.mjs <in.json> <out.json> [--seed 7]
 */
import { readFileSync, writeFileSync } from "node:fs";

const DROP = new Set(["tags", "url", "data", "team", "status", "date", "startDate", "owner", "owners", "assignees", "links", "notes", "versionTag", "paths"]);
const VOWELS = "aeiou";
const CONSONANTS = "bcdfghklmnprstvz";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Same shape, other letters: case, digits, spaces and punctuation are kept. */
export function pseudo(text, random) {
  let vowel = random() < 0.5;
  let out = "";
  for (const ch of String(text)) {
    if (/[a-z]/i.test(ch)) {
      const pool = vowel ? VOWELS : CONSONANTS;
      const letter = pool[Math.floor(random() * pool.length)];
      out += ch === ch.toUpperCase() ? letter.toUpperCase() : letter;
      vowel = !vowel;
    } else if (/[0-9]/.test(ch)) {
      out += String(Math.floor(random() * 10));
    } else {
      out += ch;
      vowel = random() < 0.5;
    }
  }
  return out;
}

/** Short marks such as cardinalities ("1", "*", "0..n") carry no content. */
const isMark = (value) => typeof value === "string" && /^[\d*.n?+-]{0,4}$/i.test(value);

export function anonymise(doc, seed = 7) {
  const random = rng(seed);
  const word = (value) => (typeof value === "string" && value && !isMark(value) ? pseudo(value, random) : value);
  const nodeIds = new Map((doc.nodes ?? []).map((n, i) => [n.id, `n${i + 1}`]));
  const zoneIds = new Map((doc.zones ?? []).map((z, i) => [z.id, `z${i + 1}`]));
  const fieldNames = new Map();

  const nodes = (doc.nodes ?? []).map((n) => {
    const out = {};
    for (const [key, value] of Object.entries(n)) {
      if (DROP.has(key)) continue;
      if (key === "id") out.id = nodeIds.get(value);
      else if (key === "parentId") out.parentId = value == null ? value : (nodeIds.get(value) ?? null);
      else if (key === "zoneId") out.zoneId = value == null ? value : (zoneIds.get(value) ?? null);
      else if (key === "label" || key === "description") out[key] = word(value);
      else if (key === "fields" && Array.isArray(value)) {
        const names = new Map();
        out.fields = value.map((f, i) => {
          if (typeof f === "string") {
            const name = word(f);
            names.set(f, name);
            return name;
          }
          const name = word(f.name ?? `field${i}`);
          names.set(f.name, name);
          if (f.id != null) names.set(f.id, name);
          const field = { ...f, name };
          if (f.id != null) field.id = `f${i + 1}`;
          if (typeof f.type === "string") field.type = word(f.type);
          for (const k of ["description", "notes", "example", "default"]) if (typeof f[k] === "string") field[k] = word(f[k]);
          return field;
        });
        fieldNames.set(n.id, names);
      } else out[key] = value;
    }
    return out;
  });

  const edges = (doc.edges ?? []).map((e, i) => {
    const out = {};
    for (const [key, value] of Object.entries(e)) {
      if (DROP.has(key)) continue;
      if (key === "id") out.id = `e${i + 1}`;
      else if (key === "source" || key === "target") out[key] = nodeIds.get(value) ?? value;
      else if (key === "startField") out.startField = fieldNames.get(e.source)?.get(value) ?? word(value);
      else if (key === "endField") out.endField = fieldNames.get(e.target)?.get(value) ?? word(value);
      else if (["label", "tech", "startLabel", "endLabel", "description"].includes(key)) out[key] = word(value);
      else out[key] = value;
    }
    return out;
  });

  const zones = (doc.zones ?? []).map((z) => {
    const out = {};
    for (const [key, value] of Object.entries(z)) {
      if (DROP.has(key)) continue;
      if (key === "id") out.id = zoneIds.get(value);
      else if (key === "parentId") out.parentId = value == null ? value : (zoneIds.get(value) ?? null);
      else if (key === "label") out.label = word(value);
      else out[key] = value;
    }
    return out;
  });

  const result = { version: doc.version ?? 1, nodes, edges };
  if (zones.length) result.zones = zones;
  if (doc.settings) result.settings = doc.settings;
  if (doc.meta?.routing) result.meta = { routing: doc.meta.routing };
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  const seedAt = process.argv.indexOf("--seed");
  const seed = seedAt > 0 ? Number(process.argv[seedAt + 1]) : 7;
  if (!input || !output) {
    console.error("usage: node scripts/gallery/anonymise.mjs <in.json> <out.json> [--seed 7]");
    process.exit(2);
  }
  writeFileSync(output, `${JSON.stringify(anonymise(JSON.parse(readFileSync(input, "utf8")), seed), null, 2)}\n`);
}
