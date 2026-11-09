/**
 * json-ranges.ts — where each element of a diagram sits in its JSON text:
 * the objects in the document's top-level arrays (`nodes`, `edges`, `zones`,
 * `participants`, `messages`…), by section and id, as character offsets. The
 * editor lights what's selected on the canvas in the JSON beside it, as the
 * web app's template panel does. Pure: a scanner over the text, not a parse
 * that throws its positions away.
 */

export interface TextSpan {
  start: number;
  end: number;
}

/** Each section's elements, by id, where they sit in `text`; empty when it isn't a JSON object. */
export function elementSpans(text: string): Map<string, Map<string, TextSpan>> {
  const out = new Map<string, Map<string, TextSpan>>();
  let i = 0;

  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  /** A string at `i`, returned unescaped; `i` ends past its closing quote. */
  const string = (): string => {
    let value = "";
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        value += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i += 2;
        continue;
      }
      value += text[i++];
    }
    i++;
    return value;
  };
  /** Past whatever value is at `i`; for an object, its members' string values by key. */
  const value = (): Map<string, string> | null => {
    space();
    const c = text[i];
    if (c === '"') {
      string();
      return null;
    }
    if (c === "{" || c === "[") {
      const object = c === "{";
      const strings = new Map<string, string>();
      i++;
      for (;;) {
        space();
        if (text[i] === (object ? "}" : "]")) {
          i++;
          break;
        }
        if (i >= text.length) throw new Error("unterminated");
        if (object) {
          const key = string();
          space();
          i++; // :
          space();
          if (text[i] === '"') strings.set(key, string());
          else value();
        } else value();
        space();
        if (text[i] === ",") i++;
      }
      return object ? strings : null;
    }
    // A number, true, false or null.
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    return null;
  };

  try {
    space();
    if (text[i] !== "{") return out;
    i++;
    for (;;) {
      space();
      if (text[i] === "}" || i >= text.length) break;
      const section = string();
      space();
      i++; // :
      space();
      if (text[i] === "[") {
        const found = new Map<string, TextSpan>();
        i++;
        for (;;) {
          space();
          if (text[i] === "]") {
            i++;
            break;
          }
          if (i >= text.length) throw new Error("unterminated");
          const start = i;
          const strings = value();
          const id = strings?.get("id");
          if (id) found.set(id, { start, end: i });
          space();
          if (text[i] === ",") i++;
        }
        if (found.size) out.set(section, found);
      } else value();
      space();
      if (text[i] === ",") i++;
    }
  } catch {
    // Text that isn't whole JSON: what was found before it stopped.
  }
  return out;
}

/** Where the selected elements sit: `selection` is section → ids, as the editors report it. */
export function selectedSpans(text: string, selection: unknown): TextSpan[] {
  if (!selection || typeof selection !== "object") return [];
  const spans = elementSpans(text);
  const out: TextSpan[] = [];
  for (const [section, ids] of Object.entries(selection as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      const span = typeof id === "string" ? spans.get(section)?.get(id) : undefined;
      if (span) out.push(span);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
