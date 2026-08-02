/**
 * App.jsx — a host app integrating the editors.
 *
 * This exercises the things that matter for real integration:
 *   - a WORKSPACE of files (architectures and sequences) the host owns; the
 *     editors render the file selector but store nothing themselves
 *   - both editors are CONTROLLED: `value` + `onChange`, JSON rendered live
 *   - `onSave` round-trips through localStorage, standing in for your database
 *   - cross-file links: a node url of `file:Name` jumps to that file
 *   - the registry adds node kinds, icons, and an exporter without forking
 *   - AI generation is wired through a server route, so no key is in the browser
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  ArchitectureStudio,
  DARK_THEME,
  EMPTY_SEQUENCE,
  EXAMPLE_SEQUENCE,
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  LIGHT_THEME,
  SequenceStudio,
  buildSequencePrompt,
  buildSystemPrompt,
  createProxyGenerator,
  sequenceFromTemplate,
  validateSequence,
  validateTemplate,
} from "@mosphere/architect-better-code-diagrams";
import "@mosphere/architect-better-code-diagrams/styles.css";
import { registry } from "./extensions.js";

const WORKSPACE_KEY = "architecture-studio:workspace";
// Pre-workspace storage, migrated once on first load.
const LEGACY_ARCH_KEY = "architecture-studio:example";
const LEGACY_SEQ_KEY = "architecture-studio:example-sequence";

let fileCounter = 0;
const nextFileId = () => `f_${Date.now().toString(36)}${(fileCounter++).toString(36)}`;

const validateDoc = (kind, doc) =>
  kind === "sequence" ? validateSequence(doc) : validateTemplate(doc);

/** Nothing in it yet — deleting is safe, and the mode switch flips in place. */
const isBlank = (kind, doc) =>
  kind === "sequence"
    ? !doc.participants.length && !doc.messages.length
    : !doc.nodes.length && !doc.edges.length;

/** Load the saved workspace, migrating pre-workspace storage on first run. */
function seedWorkspace() {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.files) && parsed.files.length) {
        const files = parsed.files.map((f) => ({ ...f, doc: validateDoc(f.kind, f.doc) }));
        const activeId = files.some((f) => f.id === parsed.activeId)
          ? parsed.activeId
          : files[0].id;
        const removed = Array.isArray(parsed.removed)
          ? parsed.removed.map((f) => ({ ...f, doc: validateDoc(f.kind, f.doc) }))
          : [];
        return { files, activeId, removed };
      }
    }
  } catch (err) {
    console.warn("Ignoring unreadable workspace:", err);
  }

  const legacy = (key, kind, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return validateDoc(kind, JSON.parse(raw));
    } catch (err) {
      console.warn("Ignoring unreadable legacy document:", err);
    }
    return fallback;
  };
  const archDoc = legacy(LEGACY_ARCH_KEY, "architecture", EXAMPLE_ZONED_TEMPLATE);
  const seqDoc = legacy(LEGACY_SEQ_KEY, "sequence", EXAMPLE_SEQUENCE);

  // Link the Payments node to the sequence file so the file: link feature is
  // visible out of the box (only when the node hasn't been given a url).
  const linked = validateTemplate({
    ...archDoc,
    nodes: archDoc.nodes.map((n) =>
      n.id === "pay" && !n.url ? { ...n, url: "file:Order flow" } : n,
    ),
  });

  const files = [
    { id: nextFileId(), name: "Architecture", kind: "architecture", doc: linked },
    { id: nextFileId(), name: "Order flow", kind: "sequence", doc: seqDoc },
  ];
  return { files, activeId: files[0].id, removed: [] };
}

/**
 * Sends prompts to /api/diagram (see server.mjs). The browser never holds a key.
 * The same generator serves both editors — each sends its own system prompt.
 */
const generate = createProxyGenerator({ endpoint: "/api/diagram" });

export default function App() {
  const [workspace, setWorkspace] = useState(seedWorkspace);
  const [savedAt, setSavedAt] = useState(null);
  const [readOnly, setReadOnly] = useState(false);
  const [minimap, setMinimap] = useState(true);
  const [mode, setMode] = useState("dark");
  // null = "use the active theme's accent"; set once the user picks a colour.
  const [accent, setAccent] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [showJson, setShowJson] = useState(true);

  const { files, removed } = workspace;
  const active = files.find((f) => f.id === workspace.activeId) ?? files[0];

  const persist = useCallback((ws) => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(ws));
  }, []);

  /** Structure ops (create/rename/delete/switch/convert) persist immediately. */
  const updateWorkspace = useCallback(
    (updater) => {
      setWorkspace((ws) => {
        const next = updater(ws);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  /** Live document edits stay in memory; Save writes them through. */
  const setActiveDoc = useCallback((doc) => {
    setWorkspace((ws) => ({
      ...ws,
      files: ws.files.map((f) => (f.id === ws.activeId ? { ...f, doc } : f)),
    }));
  }, []);

  const handleSave = useCallback(
    async (doc) => {
      // Simulate network latency so the Saving… state is visible.
      await new Promise((resolve) => setTimeout(resolve, 350));
      setWorkspace((ws) => {
        const next = {
          ...ws,
          files: ws.files.map((f) => (f.id === ws.activeId ? { ...f, doc } : f)),
        };
        persist(next);
        return next;
      });
      setSavedAt(new Date());
    },
    [persist],
  );

  // ── File operations, handed to the editors' file selector ─────────────────

  const fileProps = useMemo(
    () => ({
      files: files.map(({ id, name, kind, doc }) => ({
        id,
        name,
        kind: kind === "sequence" ? "seq" : "arch",
        empty: isBlank(kind, doc),
      })),
      activeFileId: active.id,
      onFileSelect: (id) => updateWorkspace((ws) => ({ ...ws, activeId: id })),
      onFileCreate: () =>
        updateWorkspace((ws) => {
          // A new sibling of whatever you're looking at; use → Sequence (or
          // switch to a file of the other kind) to cross kinds.
          const activeFile = ws.files.find((f) => f.id === ws.activeId) ?? ws.files[0];
          const kind = activeFile.kind;
          const file = {
            id: nextFileId(),
            name: `Untitled ${ws.files.length + 1}`,
            kind,
            doc:
              kind === "sequence"
                ? EMPTY_SEQUENCE
                : validateTemplate({ version: 1, nodes: [], edges: [] }),
          };
          return { ...ws, files: [...ws.files, file], activeId: file.id };
        }),
      onFileRename: (id, name) =>
        updateWorkspace((ws) => ({
          ...ws,
          files: ws.files.map((f) => (f.id === id ? { ...f, name } : f)),
        })),
      // Deleting moves the file to the trash, so it can be recovered from
      // the menu's "Recently removed" modal. Ten deep, newest first.
      onFileDelete: (id) =>
        updateWorkspace((ws) => {
          const rest = ws.files.filter((f) => f.id !== id);
          if (!rest.length) return ws;
          const gone = ws.files.find((f) => f.id === id);
          const activeId =
            ws.activeId === id
              ? rest[Math.max(0, ws.files.findIndex((f) => f.id === id) - 1)].id
              : ws.activeId;
          return {
            ...ws,
            files: rest,
            activeId,
            removed: [{ ...gone, removedAt: Date.now() }, ...ws.removed].slice(0, 10),
          };
        }),
      removedFiles: removed.map(({ id, name, kind }) => ({
        id,
        name,
        kind: kind === "sequence" ? "seq" : "arch",
      })),
      onFileRestore: (id) =>
        updateWorkspace((ws) => {
          const file = ws.removed.find((f) => f.id === id);
          if (!file) return ws;
          const { removedAt: _removedAt, ...restored } = file;
          return {
            ...ws,
            files: [...ws.files, restored],
            removed: ws.removed.filter((f) => f.id !== id),
            activeId: restored.id,
          };
        }),
    }),
    [files, removed, active.id, updateWorkspace],
  );

  /** file: links resolve by id first, then case-insensitive name. */
  const navigateFile = useCallback(
    (ref) => {
      const target =
        files.find((f) => f.id === ref) ??
        files.find((f) => f.name.toLowerCase() === ref.toLowerCase());
      if (!target) {
        toast.error(`No file “${ref}” in this workspace`);
        return;
      }
      updateWorkspace((ws) => ({ ...ws, activeId: target.id }));
    },
    [files, updateWorkspace],
  );

  /** → Sequence: derive a NEW sequence file — never overwrites an existing one. */
  const deriveSequenceFile = useCallback(() => {
    updateWorkspace((ws) => {
      const activeFile = ws.files.find((f) => f.id === ws.activeId) ?? ws.files[0];
      const file = {
        id: nextFileId(),
        name: `${activeFile.name} — sequence`,
        kind: "sequence",
        doc: sequenceFromTemplate(activeFile.doc),
      };
      return { ...ws, files: [...ws.files, file], activeId: file.id };
    });
  }, [updateWorkspace]);

  /** Flip a blank file's kind in place; otherwise open a new file of that kind. */
  const switchMode = useCallback(() => {
    updateWorkspace((ws) => {
      const activeFile = ws.files.find((f) => f.id === ws.activeId) ?? ws.files[0];
      const nextKind = activeFile.kind === "sequence" ? "architecture" : "sequence";
      const blankDoc =
        nextKind === "sequence"
          ? EMPTY_SEQUENCE
          : validateTemplate({ version: 1, nodes: [], edges: [] });

      if (isBlank(activeFile.kind, activeFile.doc)) {
        return {
          ...ws,
          files: ws.files.map((f) =>
            f.id === activeFile.id ? { ...f, kind: nextKind, doc: blankDoc } : f,
          ),
        };
      }
      const file = {
        id: nextFileId(),
        name: `Untitled ${ws.files.length + 1}`,
        kind: nextKind,
        doc: blankDoc,
      };
      return { ...ws, files: [...ws.files, file], activeId: file.id };
    });
  }, [updateWorkspace]);

  /** Hand the active mode's schema contract to an external AI agent. */
  const copySchema = useCallback(async () => {
    const isSeq = active.kind === "sequence";
    const text = isSeq ? buildSequencePrompt() : buildSystemPrompt();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard blocked (insecure context, permissions) — fall back to a
      // throwaway textarea, which works everywhere execCommand still does.
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast.success(`Copied the ${isSeq ? "sequence" : "architecture"} schema`, {
      description: "Paste it into your AI agent to have it author this diagram type.",
    });
  }, [active.kind]);

  // ── Presentation state ────────────────────────────────────────────────────

  // LIGHT_THEME is a complete token set; dark is the stylesheet's default, so
  // it needs no theme at all. Either way a hand-picked accent wins.
  const theme = useMemo(
    () => ({
      ...(mode === "light" ? LIGHT_THEME : {}),
      ...(accent ? { accent } : {}),
    }),
    [mode, accent],
  );
  const themeAccent = accent ?? (mode === "light" ? LIGHT_THEME.accent : DARK_THEME.accent);

  // Guard against a stale-looking UI if another tab saves the workspace.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === WORKSPACE_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          if (Array.isArray(parsed.files) && parsed.files.length) {
            setWorkspace({
              files: parsed.files.map((f) => ({ ...f, doc: validateDoc(f.kind, f.doc) })),
              activeId: parsed.activeId,
            });
          }
        } catch (err) {
          console.warn("Ignoring unreadable workspace update:", err);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ⌘L / Ctrl+L toggles the live-template panel. Chrome and Safari deliver
  // the keydown before the address-bar shortcut, so preventDefault keeps
  // focus in the app; if a browser ever reserves it outright, the header
  // checkbox and the panel's own collapse button still work.
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setShowJson((on) => !on);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const isSequence = active.kind === "sequence";
  const counts = isSequence
    ? `${active.doc.participants.length} participants · ${active.doc.messages.length} messages`
    : `${active.doc.nodes.length} nodes · ${active.doc.edges.length} edges`;

  return (
    <div className="app" data-theme={mode}>
      <Toaster theme={mode} position="bottom-right" closeButton richColors />
      <header className="app__bar">
        <div>
          <h1 className="app__title">Architecture Studio</h1>
          <p className="app__sub">
            A workspace of files · controlled by <code>value</code> / <code>onChange</code>
          </p>
        </div>

        <div className="app__controls">
          <label className="app__toggle">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            Read-only
          </label>
          <label className="app__toggle">
            <input type="checkbox" checked={minimap} onChange={(e) => setMinimap(e.target.checked)} />
            Minimap
          </label>
          <label className="app__toggle">
            <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
            AI panel
          </label>
          <label className="app__toggle">
            <input
              type="checkbox"
              checked={mode === "light"}
              onChange={(e) => setMode(e.target.checked ? "light" : "dark")}
            />
            Light
          </label>
          <label className="app__toggle">
            <input type="checkbox" checked={showJson} onChange={(e) => setShowJson(e.target.checked)} />
            JSON
          </label>
          <label className="app__toggle">
            Accent
            <input type="color" value={themeAccent} onChange={(e) => setAccent(e.target.value)} />
          </label>
          {!isSequence ? (
            <>
              <button
                type="button"
                className="app__btn"
                onClick={() => setActiveDoc(EXAMPLE_ZONED_TEMPLATE)}
                title="Reset this file to the multi-cloud example"
              >
                Multi-cloud
              </button>
              <button type="button" className="app__btn" onClick={() => setActiveDoc(EXAMPLE_TEMPLATE)}>
                Plain
              </button>
              <button
                type="button"
                className="app__btn"
                onClick={deriveSequenceFile}
                title="Derive a NEW sequence file from this diagram's numbered flow (edge seq) — deterministic, no AI"
              >
                → Sequence
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="app__btn"
            onClick={switchMode}
            title={
              isBlank(active.kind, active.doc)
                ? "This file is blank — switch it to the other diagram type"
                : "This file has content — open a new blank file of the other type"
            }
          >
            ⇄ {isSequence ? "Architecture" : "Sequence"}
          </button>
          <button
            type="button"
            className="app__btn"
            onClick={copySchema}
            title="Copy Schema Definition For Diagram — paste it into your AI agent"
          >
            ✦ Copy schema
          </button>
        </div>
      </header>

      <main className={`app__body${showJson ? "" : " app__body--wide"}`}>
        {/* The editor fills whatever box it is given — it never assumes the viewport. */}
        <section className="app__editor">
          {isSequence ? (
            <SequenceStudio
              key={active.id}
              value={active.doc}
              onChange={setActiveDoc}
              onSave={handleSave}
              readOnly={readOnly}
              theme={theme}
              generate={aiEnabled ? generate : undefined}
              filename={active.name}
              {...fileProps}
            />
          ) : (
            <ArchitectureStudio
              key={active.id}
              value={active.doc}
              onChange={setActiveDoc}
              onSave={handleSave}
              readOnly={readOnly}
              minimap={minimap}
              registry={registry}
              theme={theme}
              generate={aiEnabled ? generate : undefined}
              filename={active.name}
              onNavigateFile={navigateFile}
              {...fileProps}
            />
          )}
        </section>

        {showJson ? (
          <aside className="app__side">
            <div className="app__side-head">
              <h2>{active.name}</h2>
              <span className="app__meta">
                {counts}
                {savedAt ? ` · saved ${savedAt.toLocaleTimeString()}` : ""}
              </span>
            </div>
            <p className="app__note">
              This updates on every committed edit. It is exactly what <code>onSave</code> hands
              you, and exactly what an LLM is asked to produce.
            </p>
            <p className="app__note">
              The file menu (top-left of the editor) switches, creates, renames, and deletes
              files. A node url of <code>file:Order flow</code> makes its ↗ jump to that file —
              try the Payments node.
            </p>
            <pre className="app__json">{JSON.stringify(active.doc, null, 2)}</pre>
          </aside>
        ) : null}

        {/* One handle in one place: it flips rather than moving, so the
            control never jumps between the panel header and the screen edge. */}
        <button
          type="button"
          className={`app__side-tab${showJson ? " app__side-tab--open" : ""}`}
          onClick={() => setShowJson((on) => !on)}
          title={showJson ? "Collapse the live template (⌘L)" : "Show the live template (⌘L)"}
          aria-label={showJson ? "Collapse the live template panel" : "Show the live template panel"}
          aria-expanded={showJson}
        >
          {showJson ? "»" : "«"}
        </button>
      </main>
    </div>
  );
}
