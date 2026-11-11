/**
 * The parts of the gallery's command line that only decide things: which
 * pictures to pair, what a reviewer's file says, what a flag means. Kept apart
 * from cli.mjs, which starts servers and writes files, so they can be tested.
 */

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A flag's value, or `fallback` when the flag isn't there. A flag given with nothing after it is a mistake, not a default. */
export function flagValue(args, name, fallback) {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} wants a value`);
  return value;
}

/** A whole number of one or more, or an error that says which flag was wrong. */
export function countFlag(args, name, fallback) {
  const raw = flagValue(args, name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} wants a whole number of 1 or more, not "${raw}"`);
  return value;
}

/** A run is a folder straight under gallery/out: a name, never a path out of it. */
export function runName(value) {
  if (typeof value !== "string" || !/^[\w.-]+$/.test(value) || /^\.+$/.test(value)) {
    throw new Error(`a run is a plain name (letters, digits, "-", "_", "."), not "${value}"`);
  }
  return value;
}

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Where a document's boxes are, to the pixel: two pictures with the same answer are one picture. */
const placement = (text) =>
  JSON.parse(text)
    .nodes.map((n) => `${n.id}:${Math.round(n.x)},${Math.round(n.y)}`)
    .join("|");

/**
 * The pairs to show reviewers: up to `per` from each document, of two
 * arrangements that really differ, in a random order and with A and B the
 * random way round, all from `seed`. Past `max` the cut takes a pair from
 * every document before a second from any, so no document goes unjudged
 * because it came last in the list. Nothing is stored here: the caller stores
 * what comes back, and only that.
 *
 * `rows` are a run's rows, each cell carrying its document as `text`.
 */
export function choosePairs(rows, { per = 3, max = 80, seed = 1 } = {}) {
  const random = rng(seed);
  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const byDoc = rows.map((row) => {
    const placed = row.cells.map((c) => placement(c.text));
    const options = [];
    for (let i = 0; i < row.cells.length; i += 1) {
      for (let j = i + 1; j < row.cells.length; j += 1) {
        if (placed[i] !== placed[j]) options.push([row.cells[i], row.cells[j]]);
      }
    }
    return shuffle(options)
      .slice(0, per)
      .map(([x, y]) => {
        const [a, b] = random() < 0.5 ? [x, y] : [y, x];
        return { doc: row.name, a, b };
      });
  });
  const total = byDoc.reduce((sum, list) => sum + list.length, 0);
  if (total > max) {
    // Round by round, the documents in a random order, until what's left fits.
    const allowed = byDoc.map(() => 0);
    let room = max;
    for (let round = 0; room > 0 && round < per; round += 1) {
      for (const i of shuffle(byDoc.map((_, index) => index))) {
        if (room > 0 && byDoc[i].length > round) {
          allowed[i] += 1;
          room -= 1;
        }
      }
    }
    byDoc.forEach((list, i) => list.splice(allowed[i]));
  }
  return byDoc.flat().map((p, i) => ({ id: `p${String(i + 1).padStart(3, "0")}`, ...p }));
}

/** One reviewer's verdict on one pair of pictures, whichever was shown as A. */
export const pickKey = (p) => `${p.by}|${[p.a, p.b].sort().join("|")}`;

/**
 * A reviewer's file ("<pair> A|B|tie reason,reason" a line, # for a comment)
 * as picks, or an error naming every line that can't be read. All of it is
 * read before anything is recorded, so a slip on line 40 doesn't leave the
 * first 39 in the record to be added again on the next try.
 */
export function parsePicks(text, key, { run, by, at }) {
  const picks = [];
  const bad = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    const [id, choice, ...rest] = line.split(/\s+/);
    const p = key.get(id);
    const verdict = choice?.toLowerCase();
    if (!p || !["a", "b", "tie"].includes(verdict)) {
      bad.push(`line ${index + 1}: "${raw.trim()}"${p ? "" : ` (no pair called ${id})`}`);
      return;
    }
    // Reasons may be spaced after their commas, or wrapped in the brackets the usage shows.
    const reasons = rest.join("").replace(/^\[|\]$/g, "").split(",").filter(Boolean);
    picks.push({ pair: id, run, doc: p.doc, a: p.a.hash, b: p.b.hash, aVariant: p.a.variant, bVariant: p.b.variant, pick: verdict, reasons, by, at });
  });
  if (bad.length) throw new Error(`nothing recorded, can't read:\n  ${bad.join("\n  ")}`);
  return picks;
}

/**
 * The picks worth adding to a record: one per reviewer and pair, the last one
 * said, and none the record already has. Recording a file twice adds nothing.
 */
export function newPicks(picks, recorded) {
  const have = new Set(recorded.filter((p) => p.by).map(pickKey));
  const last = new Map();
  for (const p of picks) if (!have.has(pickKey(p))) last.set(pickKey(p), p);
  return [...last.values()];
}
