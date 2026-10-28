/**
 * editor.ts — the Better Diagrams custom editor: a diagram's JSON, shown and
 * edited in the same studio the web app uses (see src/webview), with the
 * document's text in VS Code as its only state. DocumentSync keeps the two in
 * step; this file adapts it to VS Code and answers the webview's requests.
 */
import { realpathSync } from "node:fs";
import * as vscode from "vscode";
import { formatDiagram, plainJson } from "@mosphere/better-diagrams/disk";
import { templateFile } from "@app/documents.js";
import { webviewHtml } from "./html";
import type { HostMessage, ThemeSetting, WebviewMessage } from "./protocol";
import { DocumentSync, SNIFF_LIMIT, readText } from "./sync";

export const VIEW_TYPE = "betterDiagrams.editor";

/** How long typing in the JSON pauses before the picture follows it. */
const TYPING_PAUSE_MS = 120;

export const themeSetting = (): ThemeSetting =>
  vscode.workspace.getConfiguration("betterDiagrams").get<ThemeSetting>("theme", "auto");

const fileName = (uri: vscode.Uri) => uri.path.split("/").pop() ?? uri.path;

/** `3 things`, counted the way a person reads it. */
const thingsOf = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/** Bytes posted from the webview, whichever shape the transport delivered them in. */
function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Uint8Array.from(Object.values(data as Record<string, number>));
}

/**
 * A link out of a diagram, opened the way VS Code opens any link — its own
 * trusted-domains prompt included. Only the schemes a document may store a
 * link in (`safeUrl`): the webview is the diagram's, and the diagram is text
 * anyone can write, so a `command:` or `file:` URI goes nowhere.
 */
async function openLink(url: string): Promise<void> {
  const uri = vscode.Uri.parse(url, true);
  if (!["http", "https", "mailto", "tel", "ftp"].includes(uri.scheme)) return;
  await vscode.env.openExternal(uri);
}

/**
 * For the extension's own tests, which run in VS Code (ExtensionMode.Test):
 * what each editor's webview has said, and a way to say something for it.
 */
export class EditorProbe {
  private readonly heard = new Map<string, WebviewMessage[]>();
  private readonly receivers = new Map<string, (message: WebviewMessage) => void>();

  attach(uri: vscode.Uri, receive: (message: WebviewMessage) => void): (message: WebviewMessage) => void {
    const key = uri.toString();
    this.receivers.set(key, receive);
    return (message) => {
      this.heard.set(key, [...(this.heard.get(key) ?? []), message]);
      receive(message);
    };
  }

  messages(uri: string): WebviewMessage[] {
    return this.heard.get(uri) ?? [];
  }

  say(uri: string, message: WebviewMessage): void {
    this.receivers.get(uri)?.(message);
  }
}

export class DiagramEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    private readonly probe?: EditorProbe,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = webviewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css")).toString(),
      nonce: nonce(),
      title: fileName(document.uri),
    });

    // A file VS Code can't write (an old revision from git, a read-only
    // file system) is shown, never edited.
    const readOnly = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false;
    const post = (message: HostMessage) => void webview.postMessage(message);
    const sync = new DocumentSync({
      getText: () => document.getText(),
      replaceText: (text) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), text);
        return Promise.resolve(vscode.workspace.applyEdit(edit));
      },
      format: (doc) => this.format(document, doc),
      post,
      confirmLoss: (lines) => this.confirmLoss(document, lines),
    });

    const name = fileName(document.uri);
    const report = (what: string) => (error: unknown) => this.log.error(`${what} (${name}): ${(error as Error)?.message ?? error}`);
    const receive = (message: WebviewMessage) => {
      switch (message.type) {
        case "ready": {
          // Again whenever the webview reloads: it starts over from the text.
          const { text, read } = sync.start();
          const filename = name.replace(/\.json$/i, "") || "diagram";
          post({ type: "init", text, read, readOnly, theme: themeSetting(), filename });
          return;
        }
        case "edit":
          if (!readOnly) sync.edit(message.doc).catch(report("Couldn't write an edit"));
          return;
        case "loss":
          sync.lossReported(message.lines);
          return;
        case "export":
          this.saveExport(document, message.filename, bytesOf(message.data)).catch(report("Couldn't save an export"));
          return;
        case "navigate":
          this.navigate(document, message.ref).catch(report(`Couldn't follow file:${message.ref}`));
          return;
        case "open":
          openLink(message.url).catch(report(`Couldn't open ${message.url}`));
          return;
        case "undo":
        case "redo":
          // VS Code steps whatever editor is in front, so only while this one is.
          if (panel.active) Promise.resolve(vscode.commands.executeCommand(message.type)).catch(report(`Couldn't ${message.type}`));
          return;
      }
    };

    let typing: ReturnType<typeof setTimeout> | undefined;
    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document !== document || !event.contentChanges.length) return;
        clearTimeout(typing);
        typing = setTimeout(() => sync.textChanged(), TYPING_PAUSE_MS);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("betterDiagrams.theme")) post({ type: "theme", theme: themeSetting() });
      }),
      webview.onDidReceiveMessage(this.probe ? this.probe.attach(document.uri, receive) : receive),
    ];
    panel.onDidDispose(() => {
      clearTimeout(typing);
      for (const subscription of subscriptions) subscription.dispose();
    });
  }

  /**
   * The text to write for `doc`: formatted the way the file's repo formats
   * JSON, as the `better-diagrams` command writes it. That runs the repo's
   * own Prettier and its config, so an untrusted workspace gets plain JSON.
   */
  private format(document: vscode.TextDocument, doc: unknown): Promise<string> {
    if (document.uri.scheme !== "file" || !vscode.workspace.isTrusted) return Promise.resolve(plainJson(doc));
    let path = document.uri.fsPath;
    try {
      path = realpathSync(path);
    } catch {
      // Not on disk yet: format it for where it will be.
    }
    return formatDiagram(path, doc, { warn: (message) => this.log.warn(message) });
  }

  private async confirmLoss(document: vscode.TextDocument, lines: string[]): Promise<boolean> {
    const name = fileName(document.uri);
    this.log.warn(`Editing ${name} drops ${thingsOf(lines.length)} this editor doesn't keep:`);
    for (const line of lines) this.log.warn(`  ${line}`);
    const shown = lines.slice(0, 5).join("\n");
    const more = lines.length > 5 ? `\n…and ${lines.length - 5} more (see the Better Diagrams output).` : "";
    const choice = await vscode.window.showWarningMessage(
      `Editing ${name} here drops ${thingsOf(lines.length)} this editor doesn't keep.`,
      { modal: true, detail: `${shown}${more}\n\nUndo brings them back.` },
      "Edit Anyway",
    );
    return choice === "Edit Anyway";
  }

  /** An export the studio made: saved where the person picks, beside the diagram to begin with. */
  private async saveExport(document: vscode.TextDocument, filename: string, data: Uint8Array): Promise<void> {
    const near =
      document.uri.scheme === "file"
        ? vscode.Uri.joinPath(document.uri, "..", filename)
        : vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filename)
          : undefined;
    const target = await vscode.window.showSaveDialog({ defaultUri: near, saveLabel: "Export" });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, data);
    } catch (error) {
      void vscode.window.showErrorMessage(`Couldn't export ${fileName(target)}: ${(error as Error).message}`);
      return;
    }
    const choice = await vscode.window.showInformationMessage(`Exported ${fileName(target)}`, "Open");
    if (choice === "Open") void vscode.commands.executeCommand("vscode.open", target);
  }

  /**
   * A node's `file:Name` link, followed from a file on disk: the diagram
   * named that beside it — `Name` as a path, `Name.json`, the file the web
   * app would save it as, or one whose title is `Name`.
   */
  private async navigate(document: vscode.TextDocument, ref: string): Promise<void> {
    const dir = vscode.Uri.joinPath(document.uri, "..");
    const exists = async (uri: vscode.Uri) => {
      try {
        return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
      } catch {
        return false;
      }
    };
    let found: vscode.Uri | undefined;
    for (const name of [ref, `${ref}.json`, templateFile(ref, ref)]) {
      const uri = vscode.Uri.joinPath(dir, name);
      if (name.toLowerCase().endsWith(".json") && (await exists(uri))) {
        found = uri;
        break;
      }
    }
    if (!found) {
      const entries = await Promise.resolve(vscode.workspace.fs.readDirectory(dir)).catch(() => []);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.toLowerCase().endsWith(".json")) continue;
        const uri = vscode.Uri.joinPath(dir, name);
        try {
          if ((await vscode.workspace.fs.stat(uri)).size > SNIFF_LIMIT) continue;
          const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
          if (readText(text).state === "diagram" && JSON.parse(text)?.meta?.title === ref) {
            found = uri;
            break;
          }
        } catch {
          // Unreadable: not the one.
        }
      }
    }
    if (!found) {
      void vscode.window.showWarningMessage(`There's no diagram called "${ref}" beside ${fileName(document.uri)}.`);
      return;
    }
    await vscode.commands.executeCommand("vscode.openWith", found, VIEW_TYPE);
  }
}
