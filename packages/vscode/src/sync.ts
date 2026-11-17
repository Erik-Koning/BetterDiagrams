/**
 * sync.ts — one document's text and the webview showing it, kept in step.
 *
 * Independent of VS Code's API (the editor provider adapts it), so the rules
 * are tested on their own:
 *
 *   - The webview is told every text it doesn't already show. Its own edits
 *     come back as their echo, which it already shows, so they aren't sent.
 *   - An edit is formatted the way the file's repo formats JSON and written
 *     as one edit of the text: one undo step in VS Code.
 *   - Edits arriving while one is being written collapse to the newest.
 *   - An edit is of the text the webview was last shown. If that text moved
 *     on before the edit could be written — ⌘Z, a keystroke in the JSON, an
 *     agent — the newer text wins: the edit is dropped and the webview is
 *     shown the text, rather than the edit undoing the undo.
 *   - Text that isn't a diagram is never written over. An edit made while
 *     it's broken is refused, and the webview is told the text again.
 *   - Nothing is dropped without asking: the first edit that would drop
 *     something the editor doesn't keep asks first, as the web app does
 *     before such a save. Declined, the webview gets the text back.
 *   - An edit that can't be written says so, and the webview gets the text
 *     back: it never shows an edit the file doesn't have.
 */
import { isDiagram } from "@mosphere/better-diagrams/disk";
import type { HostMessage, TextRead } from "./protocol";

/** Past this, a JSON file isn't read just to see whether it's a diagram. */
export const SNIFF_LIMIT = 5_000_000;

/** What a document's text holds, the way the disk store judges a file. */
export function readText(text: string): TextRead {
  if (!text.trim()) return { state: "empty" };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { state: "invalid", reason: `It isn't valid JSON (${(error as Error).message}).` };
  }
  if (!isDiagram(doc)) return { state: "invalid", reason: "It's JSON, but not a diagram." };
  return { state: "diagram" };
}

/**
 * The same text, whatever its line endings: VS Code writes an edit with the
 * document's own, so a CRLF file reads back with CRLF what was written as LF.
 */
const sameText = (a: string | null, b: string) => a !== null && (a === b || a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n"));

/** Whether offset `at` of `text` falls inside a pair of UTF-16 code units, or inside a CRLF. */
const splitsPair = (text: string, at: number) => {
  if (at <= 0 || at >= text.length) return false;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) || (before === 13 && after === 10);
};

/**
 * The one span of `before` to replace, and what with, to make it `after`:
 * everything between what the two start and end with in common. Written as
 * that, an edit leaves the rest of the text alone, so a JSON editor beside the
 * diagram keeps its scroll, folds and cursor, and its undo lands where the
 * change was. Never cut through a surrogate pair or a CRLF, where VS Code
 * would move the cut and not the text.
 */
export function changedSpan(before: string, after: string): { start: number; end: number; text: string } {
  const most = Math.min(before.length, after.length);
  let start = 0;
  while (start < most && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < most - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  while (splitsPair(before, start) || splitsPair(after, start)) start--;
  while (tail > 0 && (splitsPair(before, before.length - tail) || splitsPair(after, after.length - tail))) tail--;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

export interface SyncHost {
  getText(): string;
  /** Make the text `text`. Resolves false when VS Code refused the edit. */
  replaceText(text: string): Promise<boolean>;
  /** The text to write for `doc`. */
  format(doc: unknown): Promise<string>;
  post(message: HostMessage): void;
  /** Ask before an edit that drops `lines`. Resolves true to go ahead. */
  confirmLoss(lines: string[]): Promise<boolean>;
  /** An edit couldn't be written, for `reason` (a sentence): tell the person. */
  writeFailed(reason: string): void;
}

export class DocumentSync {
  /** The text whose document the webview shows. */
  private shown: string | null = null;
  private loss: string[] = [];
  private lossAccepted = false;
  /** The newest edit not yet written; `undefined` for none. */
  private pending: unknown = undefined;
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  /** The text changed while an edit was being written: looked at once it's done. */
  private changedWhileDraining = false;

  constructor(private readonly host: SyncHost) {}

  /** The text to start the webview with, and what it holds. */
  start(): { text: string; read: TextRead } {
    const text = this.host.getText();
    this.shown = text;
    return { text, read: readText(text) };
  }

  /** The document's text changed. Tells the webview, unless it already shows this text. */
  textChanged(): void {
    // Mid-write, `shown` is already the text on its way in: compared now, the
    // webview would be sent the text from before its own edit. The write
    // looks again before it writes, and once it's done.
    if (this.draining) {
      this.changedWhileDraining = true;
      return;
    }
    if (sameText(this.shown, this.host.getText())) return;
    this.resend();
  }

  /** Once every edit sent so far is written (or refused): an undo then steps back the newest. */
  settled(): Promise<void> {
    return this.drained.catch(() => undefined);
  }

  /** What editing the text the webview last loaded would drop. */
  lossReported(lines: string[]): void {
    this.loss = lines;
    this.lossAccepted = false;
  }

  /** A person's edit in the webview. Resolves once it (or a newer one) is written. */
  edit(doc: unknown): Promise<void> {
    this.pending = doc;
    // Flagged before the call: a drain with nothing to wait on finishes inside it.
    if (!this.draining) {
      this.draining = true;
      this.drained = this.drain();
    }
    return this.drained;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending !== undefined) {
        const doc = this.pending;
        this.pending = undefined;
        if (readText(this.host.getText()).state === "invalid") {
          this.resend();
          return;
        }
        if (this.loss.length && !this.lossAccepted) {
          if (!(await this.host.confirmLoss(this.loss))) {
            // Edits made while the question stood go with the one it was about.
            this.pending = undefined;
            this.resend();
            return;
          }
          this.lossAccepted = true;
        }
        const text = await this.host.format(doc);
        // The text moved on under this edit — an undo, a keystroke in the
        // JSON, an agent — while it was asked about or formatted, or before
        // the webview heard. That wins: the edit was made to a document that
        // is no longer there, and written it would undo the change. (Before
        // the webview was shown any text, there's nothing to tell.)
        if (this.shown !== null && !sameText(this.shown, this.host.getText())) {
          this.pending = undefined;
          this.resend();
          return;
        }
        this.shown = text;
        if (sameText(text, this.host.getText())) continue;
        if (!(await this.host.replaceText(text))) {
          // Edits made since were made to this one: they go with it.
          this.pending = undefined;
          this.resend();
          this.host.writeFailed("VS Code refused it.");
          return;
        }
      }
    } catch (error) {
      // Whatever failed, the webview isn't left showing an edit the text doesn't have.
      this.pending = undefined;
      this.resend();
      this.host.writeFailed((error as Error)?.message ?? String(error));
    } finally {
      this.draining = false;
      if (this.changedWhileDraining) {
        this.changedWhileDraining = false;
        this.textChanged();
      }
    }
  }

  private resend(): void {
    const text = this.host.getText();
    this.shown = text;
    this.host.post({ type: "text", text, read: readText(text) });
  }
}
