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
 * would be worse for the identifiers these labels are usually made of. With
 * `breakWords` it is broken, at the character that would overrun, as the
 * canvas's `overflow-wrap: anywhere` does: for text inside an outline it must
 * not cross, where an overhang is worse than a split.
 *
 * An explicit newline is a HARD break, not whitespace to collapse: the canvas
 * renders annotations with `white-space: pre-wrap`, so a note typed as three
 * lines is three lines on screen, and flattening it here would reflow it into
 * one paragraph in every image export — the one place the export is supposed
 * to be indistinguishable from the screen.
 */
export function wrapText(
  text: string,
  size: number,
  font: TextFont,
  maxWidth: number,
  maxLines: number,
  breakWords = false,
): string[] {
  const paragraphs = String(text).split(/\r\n|\r|\n/);
  const lines: string[] = [];
  let line = "";
  let full = false;

  for (const [p, paragraph] of paragraphs.entries()) {
    if (full) break;
    // A newline ends the current line even mid-paragraph-fill.
    if (p > 0) {
      if (line) {
        lines.push(line);
        line = "";
        if (lines.length === maxLines) {
          full = true;
          break;
        }
      } else if (paragraph.trim() === "") {
        // A deliberate blank line between paragraphs.
        lines.push("");
        if (lines.length === maxLines) {
          full = true;
          break;
        }
        continue;
      }
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    for (const word of breakWords ? words.flatMap((w) => breakWord(w, size, font, maxWidth)) : words) {
      // A broken word's pieces each fill a line, so no two of them ever
      // share one — the space this join would put between them never shows.
      const candidate = line ? `${line} ${word}` : word;
      if (approxTextWidth(candidate, size, font) > maxWidth && line) {
        lines.push(line);
        line = word;
        if (lines.length === maxLines) {
          full = true;
          break;
        }
      } else {
        line = candidate;
      }
    }
  }
  if (!lines.length && !line) return [];
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && line && lines[maxLines - 1] !== line) {
    // Out of room — ellipsise what we kept.
    let last = lines[maxLines - 1];
    while (last.length > 1 && approxTextWidth(`${last}…`, size, font) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

/** A word cut into pieces no wider than `maxWidth`, at least a character each. */
function breakWord(word: string, size: number, font: TextFont, maxWidth: number): string[] {
  const pieces: string[] = [];
  let rest = word;
  while (approxTextWidth(rest, size, font) > maxWidth) {
    const fit = Math.max(1, Math.floor(maxWidth / approxTextWidth("m", size, font)));
    pieces.push(rest.slice(0, fit));
    rest = rest.slice(fit);
  }
  if (rest) pieces.push(rest);
  return pieces;
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
export function wrappedLineCount(
  text: string,
  size: number,
  font: TextFont,
  maxWidth: number,
  breakWords = false,
): number {
  if (maxWidth <= 0) return 1;
  return Math.max(1, countWrappedLines(text, size, font, maxWidth, breakWords));
}

/**
 * `wrapText(…).length` with no line cap, counted in characters rather than
 * built as strings — every width is length × size × factor, so the count
 * needs nothing else. A wrapped diamond tries dozens of column widths for its
 * fit on every keystroke, and building each line it only wanted to count
 * made typing lag.
 */
function countWrappedLines(text: string, size: number, font: TextFont, maxWidth: number, breakWords: boolean): number {
  const unit = size * CHAR_FACTOR[font];
  const perPiece = Math.max(1, Math.floor(maxWidth / unit));
  let lines = 0;
  let line = 0;
  for (const [p, paragraph] of String(text).split(/\r\n|\r|\n/).entries()) {
    if (p > 0) {
      if (line) {
        lines++;
        line = 0;
      } else if (paragraph.trim() === "") {
        lines++;
        continue;
      }
    }
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      // A broken word's pieces, as `breakWord` cuts them.
      let rest = word.length;
      while (breakWords && rest * unit > maxWidth) {
        if (line) lines++;
        lines++;
        line = 0;
        rest -= perPiece;
      }
      // The last piece is the line's start only if the word was broken.
      if (breakWords && rest !== word.length) {
        line = rest;
        continue;
      }
      const candidate = line ? line + 1 + rest : rest;
      if (candidate * unit > maxWidth && line) {
        lines++;
        line = rest;
      } else {
        line = candidate;
      }
    }
  }
  return lines + (line ? 1 : 0);
}
