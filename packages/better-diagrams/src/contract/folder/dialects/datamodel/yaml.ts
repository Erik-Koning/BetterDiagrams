/**
 * yaml.ts — the flat `key: scalar` subset of YAML an `entity.yaml` uses.
 *
 * Deliberately not a YAML parser: no dependency, no nesting, no lists. A
 * file that turns out not to be flat is refused rather than half-read, and
 * a patch touches only the lines it names — every other byte survives.
 */

/** Whether a line is content this reader can't represent (a list item, an indented mapping). */
function isNested(line: string): boolean {
  return /^\s+\S/.test(line) || /^-\s/.test(line);
}

const LINE = /^([A-Za-z0-9_.$-]+):(?:\s+(.*))?$/;

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return v;
}

function quote(value: string): string {
  // Bare scalars YAML would misread — a colon-space, a leading symbol, a
  // number-ish that is meant as text — are double-quoted.
  if (
    value === "" ||
    /[:#]/.test(value) ||
    /^[\s'"[\]{}&*!|>%@`-]/.test(value) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(value) ||
    /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value) ||
    /\s$/.test(value)
  ) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * `key: value` lines to a record, values as strings (unquoted). Returns
 * null when the file has structure this reader doesn't handle.
 */
export function parseFlatYaml(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#") || line.trim() === "---") continue;
    if (isNested(line)) return null;
    const m = LINE.exec(line);
    if (!m) return null;
    out[m[1]] = unquote(m[2] ?? "");
  }
  return out;
}

/**
 * Replace the values of existing keys in place and append missing ones at
 * the end. Untouched lines — comments, blank lines, other keys — come back
 * byte-identical. Returns null (write nothing) when the file isn't flat.
 */
export function patchFlatYaml(text: string, patch: Record<string, string>): string | null {
  if (parseFlatYaml(text) === null) return null;
  const pending = new Map(Object.entries(patch));
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const m = LINE.exec(line);
    if (!m || !pending.has(m[1])) return line;
    const value = pending.get(m[1])!;
    pending.delete(m[1]);
    return `${m[1]}: ${quote(value)}`;
  });
  // Keep the file's trailing newline where it had one.
  const trailing = out.length && out[out.length - 1] === "" ? out.pop() : undefined;
  for (const [key, value] of pending) out.push(`${key}: ${quote(value)}`);
  if (trailing !== undefined) out.push(trailing);
  return out.join(eol);
}
