/**
 * protocol.ts — the messages between the extension and its editor's webview.
 *
 * The document's text in VS Code is the one source of truth. The extension
 * sends the webview the text, and what it found in it. The webview answers
 * with whole documents, which the extension formats and writes back as a
 * single edit, so VS Code's own undo, dirty marker, save and hot exit all
 * work as they do for any file. Imports nothing: both sides bundle it.
 */

/** `betterDiagrams.theme`: follow VS Code's light or dark, or pin one. */
export type ThemeSetting = "auto" | "light" | "dark";

/** What the document's text holds right now, as the extension read it. */
export type TextRead =
  /** JSON that the disk store would list as a diagram. */
  | { state: "diagram" }
  /** Nothing yet: a new diagram starts here. */
  | { state: "empty" }
  /** Not JSON, or JSON that isn't a diagram. Never written over. */
  | { state: "invalid"; reason: string };

export type HostMessage =
  | {
      type: "init";
      text: string;
      read: TextRead;
      readOnly: boolean;
      theme: ThemeSetting;
      /** Base name for exported files: the document's file name without `.json`. */
      filename: string;
    }
  /** The text changed outside the webview: typed, undone, pulled, or a refused edit put back. */
  | { type: "text"; text: string; read: TextRead }
  | { type: "theme"; theme: ThemeSetting };

export type WebviewMessage =
  | { type: "ready" }
  /** The whole document after a person's edit. */
  | { type: "edit"; doc: unknown }
  /** What editing the text just loaded would drop from it (`lossOf`), one sentence each; empty for nothing. */
  | { type: "loss"; lines: string[] }
  /** An export the studio would have downloaded in a browser. */
  | { type: "export"; filename: string; data: Uint8Array }
  /** A node's `file:` link was followed. */
  | { type: "navigate"; ref: string }
  /** The studio's Undo and Redo buttons: VS Code's own, on the text. */
  | { type: "undo" }
  | { type: "redo" };
