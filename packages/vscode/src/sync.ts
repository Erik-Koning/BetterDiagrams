/**
 * sync.ts — one document's text and the webview showing it, kept in step.
 *
 * Independent of VS Code's API (the editor provider adapts it), so the rules
 * are tested on their own:
 *
 *   - The webview is told every text it doesn't already show. Its own edits
 *     come back as their echo, which it already shows, so they aren't sent.
 *   - An edit is formatted the way the file's repo formats JSON and written
 *     as one replacement of the whole text: one undo step in VS Code.
 *   - Edits arriving while one is being written collapse to the newest.
 *   - Text that isn't a diagram is never written over. An edit made while
 *     it's broken is refused, and the webview is told the text again.
 *   - Nothing is dropped without asking: the first edit that would drop
 *     something the editor doesn't keep asks first, as the web app does
 *     before such a save. Declined, the webview gets the text back.
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

export interface SyncHost {
  getText(): string;
  /** Replace the whole text. Resolves false when VS Code refused the edit. */
  replaceText(text: string): Promise<boolean>;
  /** The text to write for `doc`. */
  format(doc: unknown): Promise<string>;
  post(message: HostMessage): void;
  /** Ask before an edit that drops `lines`. Resolves true to go ahead. */
  confirmLoss(lines: string[]): Promise<boolean>;
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

  constructor(private readonly host: SyncHost) {}

  /** The text to start the webview with, and what it holds. */
  start(): { text: string; read: TextRead } {
    const text = this.host.getText();
    this.shown = text;
    return { text, read: readText(text) };
  }

  /** The document's text changed. Tells the webview, unless it already shows this text. */
  textChanged(): void {
    if (sameText(this.shown, this.host.getText())) return;
    this.resend();
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
        this.shown = text;
        if (sameText(text, this.host.getText())) continue;
        if (!(await this.host.replaceText(text))) this.resend();
      }
    } finally {
      this.draining = false;
    }
  }

  private resend(): void {
    const text = this.host.getText();
    this.shown = text;
    this.host.post({ type: "text", text, read: readText(text) });
  }
}
