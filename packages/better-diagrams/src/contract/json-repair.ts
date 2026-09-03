/**
 * json-repair.ts — gentle self-healing for JSON that has been through a chat
 * window, a terminal, or a word processor on its way here.
 *
 * Pasted "JSON" is rarely damaged creatively. It is almost always one of:
 * a model reply wearing markdown fences, a chat UI's typographic rewrite
 * (smart quotes, non-breaking spaces, zero-width joiners), a terminal copy
 * that hard-wrapped a long line mid-string, a reply cut off by max_tokens,
 * or a hand edit with the classic human slips (trailing comma, missing
 * comma, // comment, Python's True/None).
 *
 * The healer is a single-pass scanner that tracks real JSON structure — what
 * is expected next at every character — so each fix is applied only where it
 * is unambiguous. Damage it cannot repair with confidence (the terminal ate a
 * chunk of characters, say) is reported precisely instead: line, column, a
 * snippet, and the likely cause. Guessing there would produce a *valid but
 * wrong* document, which is worse than an error.
 *
 * Strictly-valid JSON short-circuits before the scanner runs, so this sits
 * safely in front of every parse.
 */

export interface JsonRepairResult {
  /** Parseable JSON text — byte-identical to the input when `repairs` is empty. */
  text: string;
  /** Human-readable notes, one per kind of fix applied. */
  repairs: string[];
  /** Lossy guesses, one per damage site — only ever non-empty in approximate mode. */
  approximations: JsonApproximation[];
  /**
   * The text ran out mid-document: a bracket or a string was still open at
   * the end. Structural rather than a string to match against, because this
   * is the one repair a caller MUST surface — a reply cut off by max_tokens
   * parses cleanly once the brackets are closed, and the elements that never
   * arrived are indistinguishable from elements the model chose to delete.
   */
  truncated: boolean;
}

/**
 * One lossy guess made in approximate mode: the damaged range in the scanned
 * source (for highlighting) and what was put in its place.
 */
export interface JsonApproximation {
  from: number;
  to: number;
  note: string;
}

export interface JsonRepairOptions {
  /**
   * Recover from real content loss instead of refusing. Where safe mode
   * throws — a bare run of text where a value belongs, an unreadable number —
   * approximate mode substitutes a reasonable guess (the run as a string,
   * 0 for the number) and records it, so the rest of the document survives.
   * Every guess is a `JsonApproximation`; callers own showing them to the
   * user, because a silent wrong guess is worse than an error.
   */
  approximate?: boolean;
}

const DOUBLE_OPENERS = new Set(['"', "“", "”", "„"]); // straight, left/right/low smart
const SINGLE_OPENERS = new Set(["'", "‘", "’"]); // straight, left/right smart
/** Zero-width space/joiners and the BOM — pure paste artifacts, dropped anywhere. */
const ZERO_WIDTH = new Set(["​", "‌", "‍", "⁠", "﻿"]);
/** Unicode spaces JSON.parse rejects as whitespace (NBSP, en/em spaces, …). */
const UNICODE_SPACE = /^[  -  　]$/;

/** What the innermost container is waiting for. */
type Expect = "key" | "colon" | "value" | "after";
interface Frame {
  close: "}" | "]";
  expect: Expect;
}

const CUT_OFF = "closed unclosed brackets (the text looks cut off)";
const UNCLOSED_BRACKET = "closed an unclosed bracket";
const UNTERMINATED = "closed an unterminated string (the text looks cut off)";

function scan(src: string, approximate: boolean): JsonRepairResult {
  const out: string[] = [];
  const repairs = new Set<string>();
  const approximations: JsonApproximation[] = [];
  const stack: Frame[] = [];
  let i = 0;
  /** A source comma seen but not yet emitted — dropped if a closer follows. */
  let pendingComma = false;
  /** A complete top-level value has been consumed. */
  let topDone = false;

  const fail = (why: string, at = i): never => {
    let line = 1;
    let column = 1;
    for (let k = 0; k < at && k < src.length; k++) {
      if (src[k] === "\n") {
        line++;
        column = 1;
      } else column++;
    }
    const from = Math.max(0, at - 26);
    const to = Math.min(src.length, at + 26);
    const snippet =
      (from > 0 ? "…" : "") + src.slice(from, to).replace(/\s+/g, " ") + (to < src.length ? "…" : "");
    throw new Error(
      `Unreadable JSON at line ${line}, column ${column} (${why}), near: ${snippet} — ` +
        "if this was pasted, part of the text may have been lost in the copy; " +
        "re-copy the original JSON and paste it again.",
    );
  };

  const top = (): Frame | undefined => stack[stack.length - 1];
  const expecting = (): Expect | "end" => top()?.expect ?? (topDone ? "end" : "value");
  const setExpect = (e: Expect) => {
    const f = top();
    if (f) f.expect = e;
  };
  const valueDone = () => {
    const f = top();
    if (f) f.expect = "after";
    else topDone = true;
  };
  const emitPending = () => {
    if (pendingComma) {
      out.push(",");
      pendingComma = false;
    }
  };
  const dropPending = () => {
    if (pendingComma) {
      pendingComma = false;
      repairs.add("removed a trailing comma");
    }
  };

  const guess = (from: number, to: number, note: string) => {
    approximations.push({ from, to, note });
  };

  const preview = (text: string) =>
    text.length > 40 ? `${text.slice(0, 40)}…` : text;

  /**
   * Approximate-mode recovery where a value should be: swallow the damaged
   * run up to the next structural boundary and guess it was a string. Lost
   * text often fuses adjacent members (`"icon":y React 18+ app…","x":40`), so
   * consuming to the boundary re-synchronizes the scan at the next member.
   */
  const recoverValueRun = (runStart: number) => {
    while (i < src.length && !",}]".includes(src[i]!)) i++;
    const run = src
      .slice(runStart, i)
      .trim()
      .replace(/^["'“”‘’„]+|["'“”‘’„]+$/g, "");
    out.push(run ? JSON.stringify(run) : "null");
    guess(
      runStart,
      i,
      run
        ? `guessed a string value from the damaged text “${preview(run)}”`
        : "filled the damaged spot with null",
    );
    valueDone();
  };

  /**
   * Pop the innermost frame, filling a half-written `"key":` or `"key": ` with
   * null first so the closer lands on a complete member.
   */
  const finishFrame = () => {
    const f = stack.pop()!;
    // A trailing "," here is always dangling: a comma (source or inserted)
    // was emitted for a token that approximate mode then dropped as garbage.
    if (out[out.length - 1] === ",") out.pop();
    if (f.close === "}" && (f.expect === "colon" || f.expect === "value")) {
      if (f.expect === "colon") out.push(":");
      out.push("null");
      repairs.add("filled in a missing value as null");
    }
    out.push(f.close);
    valueDone();
  };

  const handleCloser = (ch: "}" | "]") => {
    dropPending();
    let idx = -1;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k]!.close === ch) {
        idx = k;
        break;
      }
    }
    if (idx === -1) {
      repairs.add("removed a stray closing bracket");
      return;
    }
    while (stack.length - 1 > idx) {
      finishFrame();
      repairs.add(UNCLOSED_BRACKET);
    }
    finishFrame();
  };

  /**
   * Read a string opened by any quote variant; `i` is on the opener. Returns
   * the body ready to sit between straight double quotes — escape pairs are
   * copied verbatim, so the body is emitted raw, never re-escaped.
   */
  const readString = (opener: string): string => {
    const single = SINGLE_OPENERS.has(opener);
    if (opener !== '"') {
      repairs.add(single ? "converted single-quoted strings" : "straightened smart quotes");
    }
    // A straight-quoted string closes only at a straight quote, so smart
    // quotes inside it stay content; a smart-quoted one closes at either.
    const closers = single ? SINGLE_OPENERS : opener === '"' ? new Set(['"']) : DOUBLE_OPENERS;
    i++;
    let s = "";
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "\\") {
        const next = src[i + 1];
        if (next === undefined) {
          i++;
          break; // dangling backslash at EOF — the cut-off note below covers it
        }
        // \' is not a JSON escape — unwrap it when converting quote styles.
        s += single && next === "'" ? "'" : ch + next;
        i += 2;
        continue;
      }
      if (closers.has(ch)) {
        i++;
        return s;
      }
      if (ch === "\n" || ch === "\r") {
        // A raw newline inside a string is a terminal's hard wrap of one long
        // line — rejoin the pieces rather than escaping an artifact into data.
        repairs.add("rejoined a line-wrapped string");
        i++;
        continue;
      }
      if (ZERO_WIDTH.has(ch)) {
        repairs.add("removed invisible characters");
        i++;
        continue;
      }
      if (ch === "\t") {
        repairs.add("escaped a raw tab character");
        s += "\\t";
        i++;
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        repairs.add("removed a control character");
        i++;
        continue;
      }
      s += ch === '"' ? '\\"' : ch; // bare " is reachable only via other quote styles
      i++;
    }
    repairs.add(UNTERMINATED);
    return s;
  };

  const readWord = (): string => {
    const from = i;
    while (i < src.length && /[A-Za-z0-9_$-]/.test(src[i]!)) i++;
    return src.slice(from, i);
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ZERO_WIDTH.has(ch) || UNICODE_SPACE.test(ch)) {
      repairs.add("removed invisible characters");
      i++;
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      repairs.add("removed comments");
      if (src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else {
        const end = src.indexOf("*/", i + 2);
        i = end === -1 ? src.length : end + 2;
      }
      continue;
    }

    const exp = expecting();

    if (exp === "end") {
      // Stray trailing punctuation (an extra brace, a comma from a copied
      // array context) is dropped; anything with content is real damage.
      if (ch === "," || ch === "}" || ch === "]") {
        repairs.add(ch === "," ? "removed a stray comma" : "removed a stray closing bracket");
        i++;
        continue;
      }
      if (approximate) {
        guess(i, src.length, "dropped damaged text after the end of the document");
        i = src.length;
        continue;
      }
      fail("unexpected text after the end of the JSON document");
    }

    if (ch === "}" || ch === "]") {
      handleCloser(ch);
      i++;
      continue;
    }
    if (ch === ",") {
      if (exp === "after") {
        pendingComma = true;
        setExpect(top()!.close === "}" ? "key" : "value");
      } else {
        repairs.add("removed a stray comma");
      }
      i++;
      continue;
    }
    if (ch === ":") {
      if (exp !== "colon") {
        if (!approximate) fail("unexpected ':'");
        guess(i, i + 1, "dropped a stray colon");
        i++;
        continue;
      }
      out.push(":");
      setExpect("value");
      i++;
      continue;
    }

    // A value-ish token begins. Two structural slips are unambiguous here:
    // a sibling with no comma before it, and a key with no colon after it.
    if (exp === "after") {
      repairs.add("inserted a missing comma");
      out.push(",");
      setExpect(top()!.close === "}" ? "key" : "value");
    } else if (exp === "colon") {
      repairs.add("inserted a missing colon");
      out.push(":");
      setExpect("value");
    }
    const now = expecting() as Expect;
    emitPending();

    if (DOUBLE_OPENERS.has(ch) || SINGLE_OPENERS.has(ch)) {
      const s = readString(ch);
      out.push('"' + s + '"');
      if (now === "key") setExpect("colon");
      else valueDone();
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (now === "key") {
        if (!approximate) fail("expected a property name");
        guess(i, i + 1, "dropped a stray bracket");
        i++;
        continue;
      }
      out.push(ch);
      stack.push(ch === "{" ? { close: "}", expect: "key" } : { close: "]", expect: "value" });
      i++;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const word = readWord();
      if (now === "key") {
        repairs.add("quoted a bare key");
        out.push('"' + word + '"');
        setExpect("colon");
        continue;
      }
      if (word === "true" || word === "false" || word === "null") {
        out.push(word);
      } else if (/^(true|false)$/i.test(word)) {
        repairs.add("normalized a True/False/None literal");
        out.push(word.toLowerCase());
      } else if (/^(none|null|nil)$/i.test(word)) {
        repairs.add("normalized a True/False/None literal");
        out.push("null");
      } else if (/^(nan|infinity|undefined)$/i.test(word)) {
        repairs.add("replaced NaN/Infinity/undefined with null");
        out.push("null");
      } else if (approximate) {
        recoverValueRun(i - word.length);
        continue;
      } else {
        fail(`the word "${word}" is not a JSON value`, i - word.length);
      }
      valueDone();
      continue;
    }

    if (/[0-9+\-.]/.test(ch)) {
      if (now === "key") {
        if (!approximate) fail("expected a property name");
        guess(i, i + 1, "dropped a damaged character");
        i++;
        continue;
      }
      if (/^[+-]Infinity/.test(src.slice(i, i + 9))) {
        repairs.add("replaced NaN/Infinity/undefined with null");
        out.push("null");
        i += 9;
        valueDone();
        continue;
      }
      const from = i;
      while (i < src.length && /[0-9+\-.eE]/.test(src[i]!)) i++;
      const tok = src.slice(from, i);
      if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) {
        out.push(tok);
      } else if (Number.isFinite(Number(tok))) {
        repairs.add("normalized a number");
        out.push(String(Number(tok)));
      } else if (approximate) {
        out.push("0");
        guess(from, i, `replaced the unreadable number “${preview(tok)}” with 0`);
      } else {
        fail(`"${tok}" is not a JSON number`, from);
      }
      valueDone();
      continue;
    }

    if (approximate) {
      // Unrecognizable content. Where a value belongs, carve out the run and
      // guess; anywhere else, drop the one character and re-synchronize.
      if (now === "value") {
        recoverValueRun(i);
      } else {
        guess(i, i + 1, "dropped a damaged character");
        i++;
      }
      continue;
    }
    fail(`unexpected character "${ch}"`);
  }

  dropPending();
  if (stack.length) {
    while (stack.length) finishFrame();
    repairs.add(CUT_OFF);
  }
  if (!topDone) fail("no JSON value found", 0);

  // The two repairs that mean "the text stopped early" rather than "the text
  // was malformed": an open bracket or an open string at the end of input.
  const truncated = repairs.has(CUT_OFF) || repairs.has(UNTERMINATED) || repairs.has(UNCLOSED_BRACKET);
  return { text: out.join(""), repairs: [...repairs], approximations, truncated };
}

/**
 * Heal `raw` into parseable JSON. Valid input is returned untouched; damaged
 * input comes back repaired, with notes on what was fixed. Throws a
 * user-facing message (line, column, snippet, likely cause) when the damage
 * cannot be repaired without guessing — unless `approximate` is set, in which
 * case it guesses and reports each guess (see JsonRepairOptions).
 */
export function repairJsonText(raw: string, opts: JsonRepairOptions = {}): JsonRepairResult {
  try {
    JSON.parse(raw);
    return { text: raw, repairs: [], approximations: [], truncated: false };
  } catch {
    // Fall through to the scanner.
  }
  const result = scan(raw, opts.approximate ?? false);
  try {
    JSON.parse(result.text);
  } catch (err) {
    // The scanner accepted something JSON.parse still rejects (a bad escape
    // sequence, say) — surface the real parser's complaint rather than hiding it.
    throw new Error(`The JSON could not be repaired: ${(err as Error).message}`);
  }
  return result;
}

/**
 * The "Approximate a fix" behind the editor's damage highlight and the
 * Welcome modal's rescue button.
 *
 * When `text` is JSON the safe healer refuses (real content loss), work out
 * the lossy recovery: the damaged sites, each in offsets into `text` so the
 * editor can highlight them, and the pretty-printed document with a
 * reasonable guess at each site — so one click salvages the rest of the data.
 *
 * Returns null when there is nothing for it to do: text that isn't
 * JSON-shaped, heals safely anyway (Insert already fixes it silently), or is
 * damaged beyond even approximation.
 */
export function approximateJsonFix(
  text: string,
): { text: string; sites: JsonApproximation[] } | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  // Leading prose/fences are skipped; trailing ones are left for the scanner,
  // which drops them as damage — the highlight then covers them honestly.
  const slice = text.slice(start);
  try {
    repairJsonText(slice);
    return null;
  } catch {
    // Safe healing refused — this is what approximation is for.
  }
  try {
    const result = repairJsonText(slice, { approximate: true });
    if (!result.approximations.length) return null;
    return {
      text: JSON.stringify(JSON.parse(result.text), null, 2),
      sites: result.approximations.map((a) => ({ ...a, from: a.from + start, to: a.to + start })),
    };
  } catch {
    return null;
  }
}

/**
 * Strip markdown fences and surrounding prose, then parse the first JSON
 * object — healing gently when strict parsing fails. The shared front door
 * for model replies and pasted documents.
 */
export function parseLlmJson(llmText: string): unknown {
  return parseLlmJsonReport(llmText).value;
}

/**
 * `parseLlmJson`, plus what the healer had to do to get there.
 *
 * The notes matter most when they say the text was CUT OFF: that document
 * parses cleanly once its brackets are closed, and the elements that never
 * arrived look exactly like elements the author meant to delete. A caller
 * that merges the result into a live document has to be able to say so.
 */
export function parseLlmJsonReport(
  llmText: string,
): { value: unknown; repairs: string[]; truncated: boolean } {
  const cleaned = llmText.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found in the text");
  }
  const end = cleaned.lastIndexOf("}");
  // No closing brace at all means the text was cut off — hand the healer
  // everything and let it close the document.
  const closed = end > start;
  const slice = closed ? cleaned.slice(start, end + 1) : cleaned.slice(start);
  const repaired = repairJsonText(slice);
  return {
    value: JSON.parse(repaired.text),
    repairs: repaired.repairs,
    // A reply with no closing brace at all was cut off however cleanly the
    // healer then closed it.
    truncated: repaired.truncated || !closed,
  };
}
