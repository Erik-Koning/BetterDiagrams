/**
 * The webview: one file's diagram in the studio the web app shows — the same
 * components, registry, validation and default view (example/src/documents.js)
 * — with VS Code holding the text. Edits go to the extension as whole
 * documents; the text comes back whenever it changes anywhere else. What the
 * web app keeps around the studio — its header's Copy schema, Edit JSON,
 * Derive sequence, examples and Settings › View — is in the extension's own
 * toolbar menu (host-tools.tsx); its AI and new files go through VS Code.
 */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArchitectureStudio,
  DARK_THEME,
  EMPTY_TEMPLATE,
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  LIGHT_THEME,
  SchemaCopyModal,
  SequenceStudio,
  WelcomeModal,
  buildSequencePrompt,
  parseLlmSequence,
  parseLlmTemplate,
  readsAsPlan,
  sequenceFromTemplate,
  templatePromptContext,
  themeToStyle,
  type DiagramGenerator,
  type DiagramTemplate,
  type HostHistory,
  type SequenceTemplate,
  type StudioFileInit,
} from "@mosphere/better-diagrams";
import "@mosphere/better-diagrams/styles.css";
import { completeTheme, kindOf, lossOf, registry, studioTheme, validateDoc, type DocumentKind, type ViewMode } from "@app/documents.js";
import { VIEW_DEFAULTS, type AiChoice, type HostMessage, type TextRead, type ViewSettings, type WebviewMessage } from "../protocol";
import { HostTools } from "./host-tools";
import { leaveHistoryToVsCode, removeVsCodeDefaultStyles, sendDownloadsToHost, sendLinksToHost, watchForInput } from "./shims";
import "./webview.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const send = (message: WebviewMessage) => vscode.postMessage(message);

removeVsCodeDefaultStyles();
leaveHistoryToVsCode();
sendDownloadsToHost((filename, data) => send({ type: "export", filename, data }));
sendLinksToHost((url) => send({ type: "open", url }));
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

/** Requests the extension answers later, by id: the AI panel's, and Open file…'s. */
let nextRequest = 1;
const generating = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
const opening = new Map<number, (file: File | null) => void>();

/**
 * The AI panel's generator: each request goes to the extension, which asks
 * one of VS Code's language models (the CSP keeps the webview off the
 * network). Stopping it in the panel stops the model.
 */
const generate: DiagramGenerator = (request, signal) =>
  new Promise<string>((resolve, reject) => {
    const id = nextRequest++;
    const stop = () => {
      generating.delete(id);
      send({ type: "cancel", id });
      reject(new DOMException("The request was stopped.", "AbortError"));
    };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    const done = () => signal.removeEventListener("abort", stop);
    generating.set(id, {
      resolve: (text) => (done(), resolve(text)),
      reject: (error) => (done(), reject(error)),
    });
    send({ type: "generate", id, request });
  });

/** Import › Open file…: VS Code's dialog, which opens a diagram in its own tab and hands anything else back. */
const openFile = () =>
  new Promise<File | null>((resolve) => {
    const id = nextRequest++;
    opening.set(id, resolve);
    send({ type: "openFile", id });
  });

/** Bytes from the extension, whichever shape the transport delivered them in, as a copy a File can hold. */
function bytesOf(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(Object.values(data as Record<string, number>));
}

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
  return "light";
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

/** How long the accent's colour well rests before the setting is written: it fires while dragging. */
const ACCENT_PAUSE_MS = 250;

function Editor() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fileReadOnly, setFileReadOnly] = useState(false);
  const [ownReadOnly, setOwnReadOnly] = useState(false);
  const [filename, setFilename] = useState("diagram");
  const [view, setView] = useState<ViewSettings>(VIEW_DEFAULTS);
  const [aiLabel, setAiLabel] = useState<string | null>(null);
  const [aiModels, setAiModels] = useState<AiChoice[]>([]);
  const [aiModel, setAiModel] = useState<string | undefined>(undefined);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const vsCode = useVsCodeMode();
  const mode = view.theme === "auto" ? vsCode : view.theme;
  const accentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
          setFileReadOnly(message.readOnly);
          setFilename(message.filename);
          setView(message.view);
          show(message.text, message.read);
          return;
        case "text":
          show(message.text, message.read);
          return;
        case "view":
          // An accent still being dragged here is newer than the setting coming back.
          setView((current) => (accentTimer.current ? { ...message.view, accent: current.accent } : message.view));
          return;
        case "ai":
          setAiLabel(message.label);
          setAiModels(message.models ?? []);
          setAiModel(message.model);
          return;
        case "generated": {
          const waiting = generating.get(message.id);
          generating.delete(message.id);
          if (message.text !== undefined) waiting?.resolve(message.text);
          else waiting?.reject(new Error(message.error ?? "The model didn't answer."));
          return;
        }
        case "opened": {
          const resolve = opening.get(message.id);
          opening.delete(message.id);
          resolve?.(message.file ? new File([bytesOf(message.file.data)], message.file.name) : null);
          return;
        }
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
  /** A whole new document from the menu — an example, an edited JSON — as one edit. */
  const replace = useCallback((next: Shown) => {
    setShown(next);
    send({ type: "edit", doc: next.doc });
  }, []);
  const onNavigateFile = useCallback((ref: string) => send({ type: "navigate", ref }), []);
  /**
   * A new file, as the web app opens one: with a document (an import, the
   * welcome modal's other kind) it's written beside this one where the
   * person picks; without one it's VS Code's New Diagram File.
   */
  const onFileCreate = useCallback((init?: StudioFileInit) => {
    if (init?.doc) send({ type: "create", doc: init.doc, name: init.name });
    else send({ type: "newFile" });
  }, []);
  const onNewFileOnDisk = useCallback(() => send({ type: "newFile" }), []);
  /** The selection, for the extension to light in the JSON beside the canvas, as the web app's panel does. */
  const onSelectionChange = useCallback((selection: object) => {
    send({ type: "selection", selection: selection as Record<string, string[]> });
  }, []);

  /** Shown at once; written to VS Code's settings, which every other diagram editor then follows. */
  const changeView = useCallback((change: Partial<ViewSettings>) => {
    setView((current) => ({ ...current, ...change }));
    clearTimeout(accentTimer.current);
    accentTimer.current = undefined;
    if (Object.keys(change).length === 1 && "accent" in change) {
      accentTimer.current = setTimeout(() => {
        accentTimer.current = undefined;
        send({ type: "setView", view: change });
      }, ACCENT_PAUSE_MS);
      return;
    }
    send({ type: "setView", view: change });
  }, []);

  /** Shown at once; written to VS Code's settings, which every other diagram editor then follows. */
  const onAiModelChange = useCallback((id: string) => {
    setAiModel(id);
    send({ type: "setAiModel", id });
  }, []);
  const shownAiLabel = aiModels.find((model) => model.id === aiModel)?.label ?? aiLabel;

  const accent = view.accent || undefined;
  // Memoised, as App.jsx does: the studio derives its export palette and more from it.
  const theme = useMemo(() => studioTheme(mode, accent), [mode, accent]);
  // A complete token set for what sits outside the studio — our two lines, the
  // modals. Not on an ancestor of the studio: there it would reach into its tokens.
  const chrome = useMemo(() => themeToStyle(completeTheme(mode, accent)), [mode, accent]);
  const canEdit = !fileReadOnly && problem === null;
  const readOnly = !canEdit || ownReadOnly;
  const title = (shown?.doc.meta?.title as string | undefined)?.trim() || filename;
  const architecture = shown?.kind === "architecture" ? shown.doc : null;
  const isPlan = useMemo(() => !!architecture && readsAsPlan(architecture), [architecture]);
  // Read from the document when a modal opens, so the copy describes what's on the canvas.
  const promptCtx = useMemo(
    () => ((schemaOpen || editOpen) && architecture ? templatePromptContext(architecture, registry) : null),
    [schemaOpen, editOpen, architecture],
  );

  const copySchema = useCallback(() => {
    if (shown?.kind !== "sequence") {
      setSchemaOpen(true);
      return;
    }
    send({
      type: "copy",
      text: buildSequencePrompt(),
      note: "Copied the sequence schema. Paste it into your AI agent to have it write this kind of diagram.",
    });
  }, [shown?.kind]);
  const deriveSequence = useCallback(() => {
    if (!architecture) return;
    send({ type: "create", doc: sequenceFromTemplate(architecture), name: `${title} — sequence` });
  }, [architecture, title]);

  const tools = shown ? (
    <HostTools
      kind={shown.kind}
      view={view}
      vsCodeMode={vsCode}
      themeAccent={(mode === "light" ? LIGHT_THEME.accent : DARK_THEME.accent) ?? "#3b82f6"}
      onView={changeView}
      readOnly={ownReadOnly}
      onReadOnly={setOwnReadOnly}
      canEdit={canEdit}
      aiLabel={shownAiLabel}
      onCopySchema={copySchema}
      onEditJson={() => setEditOpen(true)}
      onDeriveSequence={deriveSequence}
      onExample={(which) => replace({ kind: "architecture", doc: which === "zoned" ? EXAMPLE_ZONED_TEMPLATE : EXAMPLE_TEMPLATE })}
    />
  ) : null;
  const ai = shownAiLabel && view.ai ? { generate, aiLabel: shownAiLabel, aiModels, aiModel, onAiModelChange } : {};
  const shared = {
    readOnly,
    theme,
    mode: view.presentation,
    gradients: view.gradients,
    filename,
    hostHistory: VS_CODE_HISTORY,
    onFileCreate,
    onSelectionChange,
    toolbarExtras: tools,
    ...ai,
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
            <SequenceStudio key="sequence" value={shown.doc} onChange={onChange} {...shared} />
          ) : (
            <ArchitectureStudio
              key="architecture"
              value={shown.doc}
              onChange={onChange}
              registry={registry}
              minimap={view.minimap}
              edgesOnHover={view.linesOnHover}
              onNavigateFile={onNavigateFile}
              onOpenFile={openFile}
              onNewFileOnDisk={onNewFileOnDisk}
              {...shared}
            />
          )}
        </div>
      )}

      {schemaOpen && promptCtx ? (
        // Library modals read --as-* tokens, which live on the studio roots: this carries a set.
        <div style={{ display: "contents", ...chrome }}>
          <SchemaCopyModal
            subtitle={`For “${title}”. Architecture teaches only the clouds you tick — none, for a provider-neutral schema. Task flow teaches a plan of tasks.`}
            clouds={promptCtx.cloudOptions}
            resources={promptCtx.cloudResources}
            initialClouds={promptCtx.referencedClouds}
            usedResources={promptCtx.usedResources}
            buildPrompt={(scope, { geometry }) => promptCtx.promptForClouds(scope.clouds, { components: scope.components, geometry })}
            buildTaskPrompt={({ geometry }) => promptCtx.promptForClouds([], { geometry, focus: "tasks" })}
            initialFocus={isPlan ? "tasks" : "architecture"}
            copy={(text) => {
              send({ type: "copy", text, note: "Copied the schema. Paste it into your AI agent to have it write this diagram." });
              return true;
            }}
            onClose={() => setSchemaOpen(false)}
          />
        </div>
      ) : null}

      {editOpen && shown ? (
        <div style={{ display: "contents", ...chrome }}>
          <WelcomeModal
            kind={shown.kind}
            // It edits THIS file: a paste must not retype it, so the picker is pinned.
            lockKind
            defaultName={title}
            showNameField={false}
            systemPrompt={promptCtx ? promptCtx.systemPrompt : buildSequencePrompt()}
            systemPromptTasks={promptCtx?.promptForClouds([], { focus: "tasks" })}
            systemPromptTasksContent={promptCtx?.promptForClouds([], { focus: "tasks", geometry: false })}
            initialPreset={isPlan ? "tasks" : undefined}
            cloudProviders={promptCtx?.cloudOptions}
            promptForClouds={promptCtx?.promptForClouds}
            cloudResources={promptCtx?.cloudResources}
            usedResources={promptCtx?.usedResources}
            initialClouds={promptCtx?.referencedClouds}
            initialText={JSON.stringify(shown.doc, null, 2)}
            parse={(text) => (shown.kind === "sequence" ? parseLlmSequence(text) : parseLlmTemplate(text))}
            onInsert={(doc) => {
              replace({ kind: shown.kind, doc } as Shown);
              setEditOpen(false);
            }}
            onDismiss={() => setEditOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Editor />
  </StrictMode>,
);
