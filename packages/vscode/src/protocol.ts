/**
 * protocol.ts — the messages between the extension and its editor's webview.
 *
 * The document's text in VS Code is the one source of truth. The extension
 * sends the webview the text, and what it found in it. The webview answers
 * with whole documents, which the extension formats and writes back as a
 * single edit, so VS Code's own undo, dirty marker, save and hot exit all
 * work as they do for any file. Imports nothing: both sides bundle it.
 */

/** The diagram editor's view type, as package.json contributes it. */
export const VIEW_TYPE = "betterDiagrams.editor";

/** `betterDiagrams.theme`: follow VS Code's light or dark, or pin one. */
export type ThemeSetting = "auto" | "light" | "dark";

/**
 * How every diagram editor looks: the web app's Settings › View, kept in
 * VS Code's settings (`betterDiagrams.*`) so they hold for every file and
 * window, and change from the editor's Settings menu or the Settings UI alike.
 */
export interface ViewSettings {
  theme: ThemeSetting;
  /** The studio's presentation: marketing (bigger type, tucked-away labels) or technical. */
  presentation: "marketing" | "technical";
  /** Marketing's gradients, or one flat coat per card. */
  gradients: boolean;
  minimap: boolean;
  /** Draw a connection only while the pointer is over a node it touches. */
  linesOnHover: boolean;
  /** A hex colour that replaces the theme's accent; empty for the theme's own. */
  accent: string;
  /** Offer the AI panel (Generate, Adjust with AI) when VS Code has a language model. */
  ai: boolean;
}

export const VIEW_DEFAULTS: ViewSettings = {
  theme: "auto",
  presentation: "marketing",
  gradients: false,
  minimap: false,
  linesOnHover: false,
  accent: "",
  ai: true,
};

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
      view: ViewSettings;
      /** Base name for exported files: the document's file name without `.json`. */
      filename: string;
    }
  /** The text changed outside the webview: typed, undone, pulled, or a refused edit put back. */
  | { type: "text"; text: string; read: TextRead }
  /** A `betterDiagrams.*` setting changed, here or anywhere. */
  | { type: "view"; view: ViewSettings }
  /** The language model the AI panel would use, by name; null when VS Code has none to offer. */
  | { type: "ai"; label: string | null }
  /** A `generate` request's answer: the model's raw text, or why there is none. */
  | { type: "generated"; id: number; text?: string; error?: string }
  /**
   * The answer to Open file…: a file to read in as a copy, or nothing — the
   * person cancelled, or picked a diagram, which VS Code opened in its own tab.
   */
  | { type: "opened"; id: number; file?: { name: string; data: Uint8Array } };

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
  /** A link out of the diagram was followed: a node's ↗, or the inspector's. */
  | { type: "open"; url: string }
  /** The studio's Undo and Redo buttons: VS Code's own, on the text. */
  | { type: "undo" }
  | { type: "redo" }
  /** The editor's Settings menu changed some of the view settings. */
  | { type: "setView"; view: Partial<ViewSettings> }
  /** The AI panel asks the model; `request` is the studio's GenerateRequest. */
  | { type: "generate"; id: number; request: unknown }
  /** The AI panel gave up on a request (Stop, or closed). */
  | { type: "cancel"; id: number }
  /**
   * A diagram for a NEW file beside this one, as the web app opens a new
   * workspace file: an import, a derived sequence, the welcome modal's other kind.
   */
  | { type: "create"; doc: unknown; name?: string }
  /** Text for the clipboard, and what to tell the person once it's there. */
  | { type: "copy"; text: string; note: string }
  /** Import › Open file…: VS Code's open dialog, answered by `opened`. */
  | { type: "openFile"; id: number }
  /** Import › New file on disk…: the New Diagram File command. */
  | { type: "newFile" }
  /** What's selected on the canvas, as section → element ids, to light in the JSON beside it. */
  | { type: "selection"; selection: Record<string, string[]> };
