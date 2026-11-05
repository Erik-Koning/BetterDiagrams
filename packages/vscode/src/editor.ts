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
import { aiLabel, generate } from "./ai";
import { createDiagramFile, fileName } from "./files";
import { webviewHtml } from "./html";
import { VIEW_TYPE, type HostMessage, type ViewSettings, type WebviewMessage } from "./protocol";
import { selectedSpans } from "./json-ranges";
import { DocumentSync, SNIFF_LIMIT, readText } from "./sync";
import { VIEW_KEYS, viewChange, viewFrom } from "./view-settings";

/** What's selected on the canvas, lit in the JSON beside it. */
const SELECTED = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.selectionHighlightForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Center,
  isWholeLine: true,
});

export { VIEW_TYPE };

/** How long typing in the JSON pauses before the picture follows it. */
const TYPING_PAUSE_MS = 120;

/** The view settings, as every diagram editor shows them. */
export const readView = (): ViewSettings => {
  const config = vscode.workspace.getConfiguration("betterDiagrams");
  return viewFrom((key) => config.get(key));
};

/**
 * Change view settings where they're set: a workspace's own value stays the
 * workspace's, anything else is the person's (User settings) — and a value
 * back at its default leaves settings.json rather than sitting there.
 */
export async function writeView(change: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration("betterDiagrams");
  for (const [key, value] of Object.entries(viewChange(change)) as Array<[keyof ViewSettings, unknown]>) {
    const set = config.inspect(key);
    const target =
      set?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : set?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    const fallback = set?.defaultValue;
    await config.update(key, target === vscode.ConfigurationTarget.Global && value === fallback ? undefined : value, target);
  }
}

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
    /** The AI panel's requests in flight, to stop when it gives up or the editor closes. */
    const asking = new Map<number, vscode.CancellationTokenSource>();
    const postAi = () => void aiLabel().then((label) => post({ type: "ai", label }));
    /**
     * The canvas's selection in every editor showing this file's text (Show
     * JSON, ⌘L): lit, and the first of it scrolled into view when it's off
     * screen. Lit again when the text changes or another editor shows it.
     */
    let selection: Record<string, string[]> = {};
    const light = (reveal: boolean) => {
      const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document === document);
      if (!editors.length) return;
      const text = document.getText();
      const ranges = selectedSpans(text, selection).map(
        (span) => new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
      );
      for (const editor of editors) {
        editor.setDecorations(SELECTED, ranges);
        if (reveal && ranges.length) editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    };
    const receive = (message: WebviewMessage) => {
      switch (message.type) {
        case "ready": {
          // Again whenever the webview reloads: it starts over from the text.
          const { text, read } = sync.start();
          const filename = name.replace(/\.json$/i, "") || "diagram";
          post({ type: "init", text, read, readOnly, view: readView(), filename });
          postAi();
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
        case "setView":
          writeView(message.view).catch((error: unknown) => {
            report("Couldn't change a setting")(error);
            void vscode.window.showErrorMessage(`Couldn't change the setting: ${(error as Error).message}`);
          });
          return;
        case "generate": {
          const { id } = message;
          const stop = new vscode.CancellationTokenSource();
          asking.set(id, stop);
          generate(message.request, stop.token)
            .then((text) => post({ type: "generated", id, text }))
            .catch((error: unknown) => {
              if (!stop.token.isCancellationRequested) post({ type: "generated", id, error: (error as Error)?.message ?? String(error) });
            })
            .finally(() => {
              asking.delete(id);
              stop.dispose();
            });
          return;
        }
        case "cancel":
          asking.get(message.id)?.cancel();
          return;
        case "create":
          createDiagramFile(document.uri, message.doc, message.name).catch((error: unknown) => {
            report("Couldn't create a file")(error);
            void vscode.window.showErrorMessage(`Couldn't create the file: ${(error as Error).message}`);
          });
          return;
        case "copy":
          Promise.resolve(vscode.env.clipboard.writeText(message.text))
            .then(() => vscode.window.showInformationMessage(message.note))
            .catch(report("Couldn't copy"));
          return;
        case "openFile":
          this.openFile(document)
            .then((file) => post({ type: "opened", id: message.id, ...(file ? { file } : {}) }))
            .catch((error: unknown) => {
              report("Couldn't open a file")(error);
              post({ type: "opened", id: message.id });
            });
          return;
        case "newFile":
          Promise.resolve(vscode.commands.executeCommand("betterDiagrams.new")).catch(report("Couldn't make a new file"));
          return;
        case "selection":
          selection = message.selection && typeof message.selection === "object" ? message.selection : {};
          light(true);
          return;
      }
    };

    let typing: ReturnType<typeof setTimeout> | undefined;
    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document !== document || !event.contentChanges.length) return;
        clearTimeout(typing);
        typing = setTimeout(() => {
          sync.textChanged();
          light(false);
        }, TYPING_PAUSE_MS);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => light(false)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (VIEW_KEYS.some((key) => event.affectsConfiguration(`betterDiagrams.${key}`))) post({ type: "view", view: readView() });
        if (event.affectsConfiguration("betterDiagrams.aiModel")) postAi();
      }),
      ...(vscode.lm?.onDidChangeChatModels ? [vscode.lm.onDidChangeChatModels(postAi)] : []),
      webview.onDidReceiveMessage(this.probe ? this.probe.attach(document.uri, receive) : receive),
    ];
    panel.onDidDispose(() => {
      clearTimeout(typing);
      // Nothing is selected in a canvas that's gone.
      selection = {};
      light(false);
      for (const stop of asking.values()) stop.cancel();
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
   * Import › Open file…: VS Code's open dialog, beside the diagram. A diagram
   * picked there opens in its own editor, as the web app opens a linked
   * file, and the studio is told nothing; anything else — SQL, a CSV, a
   * draw.io file — comes back for the studio to read in, as a copy.
   */
  private async openFile(document: vscode.TextDocument): Promise<{ name: string; data: Uint8Array } | undefined> {
    const [picked] =
      (await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.joinPath(document.uri, ".."),
        canSelectMany: false,
        openLabel: "Open",
        title: "Open File",
      })) ?? [];
    if (!picked) return undefined;
    const data = await vscode.workspace.fs.readFile(picked);
    const name = fileName(picked);
    if (/\.json$/i.test(name) && data.byteLength <= SNIFF_LIMIT && readText(new TextDecoder().decode(data)).state === "diagram") {
      await vscode.commands.executeCommand("vscode.openWith", picked, VIEW_TYPE);
      return undefined;
    }
    return { name, data };
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
