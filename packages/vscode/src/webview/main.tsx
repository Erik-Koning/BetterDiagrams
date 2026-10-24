/**
 * The webview: one file's diagram in the studio the web app shows — the same
 * components, registry, validation and default view (example/src/documents.js)
 * — with VS Code holding the text. Edits go to the extension as whole
 * documents; the text comes back whenever it changes anywhere else.
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArchitectureStudio,
  EMPTY_TEMPLATE,
  SequenceStudio,
  themeToStyle,
  type DiagramTemplate,
  type HostHistory,
  type SequenceTemplate,
} from "@mosphere/better-diagrams";
import "@mosphere/better-diagrams/styles.css";
import {
  DEFAULT_VIEW,
  completeTheme,
  kindOf,
  lossOf,
  registry,
  studioTheme,
  validateDoc,
  type DocumentKind,
  type ViewMode,
} from "@app/documents.js";
import type { HostMessage, TextRead, ThemeSetting, WebviewMessage } from "../protocol";
import { leaveHistoryToVsCode, removeVsCodeDefaultStyles, sendDownloadsToHost, watchForInput } from "./shims";
import "./webview.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const send = (message: WebviewMessage) => vscode.postMessage(message);

removeVsCodeDefaultStyles();
leaveHistoryToVsCode();
sendDownloadsToHost((filename, data) => send({ type: "export", filename, data }));
const touched = watchForInput();

/**
 * The toolbar's Undo and Redo, as ⌘Z and ⇧⌘Z already are: VS Code's history
 * of the text, so there is the one, and the change comes back as text. VS
 * Code can't say whether there's anything to step, so the buttons stay on.
 */
const VS_CODE_HISTORY: HostHistory = {
  undo: () => send({ type: "undo" }),
  redo: () => send({ type: "redo" }),
};

type Shown = { kind: "architecture"; doc: DiagramTemplate } | { kind: "sequence"; doc: SequenceTemplate };

/**
 * A text from the extension, read the way the web app reads a file from
 * disk; the extension hears what editing it would drop.
 */
function read(text: string, state: TextRead): { shown: Shown } | { problem: string } {
  if (state.state === "invalid") {
    send({ type: "loss", lines: [] });
    return { problem: state.reason };
  }
  if (state.state === "empty") {
    send({ type: "loss", lines: [] });
    return { shown: { kind: "architecture", doc: EMPTY_TEMPLATE } };
  }
  try {
    const raw: unknown = JSON.parse(text);
    const kind: DocumentKind = kindOf(raw);
    const doc = validateDoc(kind, raw);
    send({ type: "loss", lines: lossOf(kind, raw, doc) });
    return { shown: { kind, doc } as Shown };
  } catch (error) {
    send({ type: "loss", lines: [] });
    return { problem: `It couldn't be read as a diagram (${(error as Error).message}).` };
  }
}

/** Light or dark, from the class VS Code puts on the body for its colour theme. */
function vsCodeMode(): ViewMode {
  const classes = document.body.classList;
  if (classes.contains("vscode-light") || classes.contains("vscode-high-contrast-light")) return "light";
  if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) return "dark";
  return DEFAULT_VIEW.mode;
}

function useVsCodeMode(): ViewMode {
  const [mode, setMode] = useState(vsCodeMode);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(vsCodeMode()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

function Editor() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [filename, setFilename] = useState("diagram");
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>("auto");
  const vsCode = useVsCodeMode();
  const mode = themeSetting === "auto" ? vsCode : themeSetting;

  useEffect(() => {
    const show = (text: string, state: TextRead) => {
      const next = read(text, state);
      if ("problem" in next) {
        // The last good picture stays up, read-only, under the reason.
        setProblem(next.problem);
        return;
      }
      setProblem(null);
      setShown(next.shown);
    };
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "init":
          setReadOnly(message.readOnly);
          setFilename(message.filename);
          setThemeSetting(message.theme);
          show(message.text, message.read);
          return;
        case "text":
          show(message.text, message.read);
          return;
        case "theme":
          setThemeSetting(message.theme);
          return;
      }
    };
    window.addEventListener("message", onMessage);
    send({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const onChange = useCallback((doc: DiagramTemplate | SequenceTemplate) => {
    if (!touched()) return;
    setShown((current) => (current ? ({ ...current, doc } as Shown) : current));
    send({ type: "edit", doc });
  }, []);
  const onNavigateFile = useCallback((ref: string) => send({ type: "navigate", ref }), []);

  // Memoised, as App.jsx does: the studio derives its export palette and more from it.
  const theme = useMemo(() => studioTheme(mode), [mode]);
  // A complete token set for our own two lines, which sit outside the studio. Not
  // on an ancestor of the studio: there it would reach into the studio's own tokens.
  const chrome = useMemo(() => themeToStyle(completeTheme(mode)), [mode]);
  const view = {
    readOnly: readOnly || problem !== null,
    theme,
    mode: DEFAULT_VIEW.studioMode,
    gradients: DEFAULT_VIEW.gradients,
    filename,
    hostHistory: VS_CODE_HISTORY,
  };

  return (
    <div className="bd-vscode" data-theme={mode}>
      {problem ? (
        <div className="bd-vscode__problem" role="status" style={chrome}>
          <strong>This file isn't a diagram right now.</strong> {problem}{" "}
          <span>{shown ? "The picture is from before, and can't be edited until the JSON is fixed." : ""}</span>
        </div>
      ) : null}
      {!shown ? (
        problem ? (
          <div className="bd-vscode__nothing" style={chrome}>
            Fix the JSON (Better Diagrams: Show JSON) and the diagram appears here.
          </div>
        ) : null
      ) : (
        <div className="bd-vscode__editor">
          {shown.kind === "sequence" ? (
            <SequenceStudio key="sequence" value={shown.doc} onChange={onChange} {...view} />
          ) : (
            <ArchitectureStudio
              key="architecture"
              value={shown.doc}
              onChange={onChange}
              registry={registry}
              minimap={DEFAULT_VIEW.minimap}
              edgesOnHover={DEFAULT_VIEW.edgesOnHover}
              onNavigateFile={onNavigateFile}
              {...view}
            />
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Editor />
  </StrictMode>,
);
