/**
 * text.ts — approximate text metrics, shared by everything that has to agree
 * about how much room a label needs.
 *
 * Deliberately an approximation by character count rather than a real
 * measurement: `canvas.measureText` doesn't exist in Node or in jsdom, and an
 * SVG export has no DOM to measure against either. A single cheap formula that
 * is *identical* everywhere beats an accurate one that only some backends can
 * run — validation grows a node's height, the canvas lays the text out, and
 * the PNG/SVG export draws it, and all three must reach the same answer or the
 * export disagrees with what the user arranged on screen.
 *
 * Lives in `contract/` rather than next to the renderer because
 * `validateTemplate` needs it and the contract may not import from `react/`.
 */

export type TextFont = "mono" | "sans";

/** Mean glyph width as a fraction of the font size, per family. */
const CHAR_FACTOR: Record<TextFont, number> = { mono: 0.602, sans: 0.52 };

export function approxTextWidth(text: string, size: number, font: TextFont): number {
  return text.length * size * CHAR_FACTOR[font];
}

/**
 * Greedy word wrap, ellipsising the last line when it runs out of `maxLines`.
 *
 * A word longer than `maxWidth` is not broken — it overhangs. Breaking mid-word
 * would be worse for the identifiers these labels are usually made of.
 */
export function wrapText(
  text: string,
  size: number,
  font: TextFont,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (approxTextWidth(candidate, size, font) > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && line && lines[maxLines - 1] !== line) {
    // Out of room — ellipsise what we kept.
    let last = lines[maxLines - 1];
    while (last.length > 1 && approxTextWidth(`${last}…`, size, font) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

export function ellipsise(text: string, size: number, font: TextFont, maxWidth: number): string {
  let s = text;
  while (s.length > 1 && approxTextWidth(`${s}…`, size, font) > maxWidth) s = s.slice(0, -1);
  return s === text ? text : `${s}…`;
}

/**
 * How many lines a wrapped label needs, with no line cap.
 *
 * This is the measurement `validateTemplate` grows a node's height by, so it
 * must not impose a maximum of its own — the whole point of `wrap` is that
 * nothing is hidden.
 */
export function wrappedLineCount(text: string, size: number, font: TextFont, maxWidth: number): number {
  if (maxWidth <= 0) return 1;
  return Math.max(1, wrapText(text, size, font, maxWidth, Number.MAX_SAFE_INTEGER).length);
}
