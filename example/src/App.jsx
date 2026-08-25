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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  ArchitectureStudio,
  BrandMark,
  DARK_THEME,
  EMPTY_SEQUENCE,
  EMPTY_TEMPLATE,
  EXAMPLE_SEQUENCE,
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  LIGHT_THEME,
  SchemaCopyModal,
  SequenceStudio,
  WelcomeModal,
  buildSequencePrompt,
  createProxyGenerator,
  parseLlmSequence,
  parseLlmTemplate,
  sequenceFromTemplate,
  templatePromptContext,
  themeToStyle,
  validateSequence,
  validateTemplate,
} from "@mosphere/better-diagrams";
import "@mosphere/better-diagrams/styles.css";
import { registry } from "./extensions.js";
import {
  listTemplates,
  probeTemplates,
  readTemplate,
  removeTemplate,
  templateFile,
  writeTemplate,
} from "./templates.js";

const WORKSPACE_KEY = "better-diagrams:workspace";
// Storage keys from earlier builds, read once so saved work survives a rename.
const LEGACY_WORKSPACE_KEY = "architecture-studio:workspace";
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
    const raw =
      localStorage.getItem(WORKSPACE_KEY) ?? localStorage.getItem(LEGACY_WORKSPACE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // An empty files array is a real state (the user deleted everything),
      // not corruption — reseeding the demos over it would resurrect them.
      if (Array.isArray(parsed.files)) {
        const files = parsed.files.map((f) => ({ ...f, doc: validateDoc(f.kind, f.doc) }));
        const activeId = files.some((f) => f.id === parsed.activeId)
          ? parsed.activeId
          : (files[0]?.id ?? null);
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

/**
 * The live template, rendered as the exact text of
 * `JSON.stringify(doc, null, 2)` — but assembled section by section, so the
 * entries for elements selected on the canvas get a contrasting background.
 * The editors report selection bucketed by document section (nodes / edges /
 * zones, participants / messages / …), which is what makes the lookup a
 * straight `selection[key]`.
 */
function HighlightedJson({ doc, selection }) {
  const ref = useRef(null);

  // A selection made on the canvas may sit anywhere in the document — bring
  // its first highlighted entry into view.
  useEffect(() => {
    ref.current
      ?.querySelector(".app__json-hit")
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selection]);

  const parts = [];
  let run = "{\n"; // plain text accumulated since the last highlight
  const entries = Object.entries(doc).filter(([, v]) => v !== undefined);
  entries.forEach(([key, value], i) => {
    const comma = i === entries.length - 1 ? "" : ",";
    const hits = new Set(selection?.[key] ?? []);
    if (Array.isArray(value) && value.length && hits.size) {
      run += `  ${JSON.stringify(key)}: [\n`;
      value.forEach((el, j) => {
        const text =
          JSON.stringify(el, null, 2)
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n") + (j === value.length - 1 ? "\n" : ",\n");
        if (el && hits.has(el.id)) {
          parts.push(run);
          parts.push(
            <span key={`${key}:${el.id}`} className="app__json-hit">
              {text}
            </span>,
          );
          run = "";
        } else {
          run += text;
        }
      });
      run += `  ]${comma}\n`;
    } else {
      // Indent every line but the first, which sits after the key.
      const text = JSON.stringify(value, null, 2).split("\n").join("\n  ");
      run += `  ${JSON.stringify(key)}: ${text}${comma}\n`;
    }
  });
  parts.push(`${run}}`);

  return (
    <pre ref={ref} className="app__json">
      {parts}
    </pre>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState(seedWorkspace);
  const [savedAt, setSavedAt] = useState(null);
  const [readOnly, setReadOnly] = useState(false);
  const [minimap, setMinimap] = useState(true);
  const [mode, setMode] = useState("dark");
  // null = "use the active theme's accent"; set once the user picks a colour.
  const [accent, setAccent] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  // The template panel starts collapsed; hovering the handle explains what it is.
  const [showJson, setShowJson] = useState(false);
  /** The template-JSON edit modal over the viewer panel. */
  const [editJsonOpen, setEditJsonOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);
  // What's selected on the canvas, in document terms. The editors fire this
  // on mount too, so a file switch (which remounts them) clears it for free.
  const [selection, setSelection] = useState(null);

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
      activeFileId: active?.id,
      onFileSelect: (id) => updateWorkspace((ws) => ({ ...ws, activeId: id })),
      // The menu's "＋ New file" passes nothing; the welcome modal passes a
      // name and, when JSON was inserted, a document to seed the file with.
      onFileCreate: (init) =>
        updateWorkspace((ws) => {
          // A new sibling of whatever you're looking at; use → Sequence (or
          // switch to a file of the other kind) to cross kinds.
          const activeFile = ws.files.find((f) => f.id === ws.activeId) ?? ws.files[0];
          const kind = init?.kind ?? activeFile?.kind ?? "architecture";
          const file = {
            id: nextFileId(),
            name: init?.name?.trim() || `Untitled ${ws.files.length + 1}`,
            kind,
            doc: init?.doc
              ? validateDoc(kind, init.doc)
              : kind === "sequence"
                ? EMPTY_SEQUENCE
                : EMPTY_TEMPLATE,
          };
          return { ...ws, files: [...ws.files, file], activeId: file.id };
        }),
      onFileRename: (id, name) =>
        updateWorkspace((ws) => ({
          ...ws,
          // The name and the document's meta.title are one title with two
          // homes. The editor keeps them in sync for the ACTIVE file; doing it
          // here too covers renames of files the editor isn't holding.
          files: ws.files.map((f) =>
            f.id === id ? { ...f, name, doc: { ...f.doc, meta: { ...f.doc.meta, title: name } } } : f,
          ),
        })),
      // Deleting moves the file to the trash, so it can be recovered from
      // the menu's "Recently removed" modal. Ten deep, newest first.
      onFileDelete: (id) =>
        updateWorkspace((ws) => {
          const rest = ws.files.filter((f) => f.id !== id);
          const gone = ws.files.find((f) => f.id === id);
          // Deleting the last file is allowed — the editors show the welcome
          // modal over the empty workspace.
          const activeId =
            ws.activeId === id
              ? (rest[Math.max(0, ws.files.findIndex((f) => f.id === id) - 1)]?.id ?? null)
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
    [files, removed, active?.id, updateWorkspace],
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
      if (!activeFile) return ws;
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
      if (!activeFile) return ws;
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

  /** The scope dialog behind ✦ Copy schema on an architecture file. */
  const [schemaCopyOpen, setSchemaCopyOpen] = useState(false);

  /** Sequence has no provider vocabulary to scope — it copies straight away. */
  const copySequenceSchema = useCallback(async () => {
    const text = buildSequencePrompt();
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
    toast.success("Copied the sequence schema", {
      description: "Paste it into your AI agent to have it author this diagram type.",
    });
  }, []);

  /**
   * Hand the active mode's schema contract to an external AI agent.
   *
   * Architecture files ASK first: which clouds, and which of their services,
   * the schema should teach. The open document's own clouds seed the answer,
   * but the copy is aimed at the diagram the user is ABOUT to ask for — which
   * may be on a cloud this document has never mentioned.
   */
  const copySchema = useCallback(() => {
    if (active?.kind === "sequence") void copySequenceSchema();
    else setSchemaCopyOpen(true);
  }, [active, copySequenceSchema]);

  // The dialog belongs to the file it was opened over: switching to a sequence
  // file (or deleting the last one) closes it, so the flag can't sit true and
  // reopen the modal by itself the next time an architecture file appears.
  useEffect(() => {
    if (!active || active.kind === "sequence") setSchemaCopyOpen(false);
  }, [active]);

  // Prompt context for the copy dialog, computed from the LIVE document at
  // open time — the clouds it references seed the scope, and its own cloud
  // kinds become the "in this diagram" preset.
  const copyPromptCtx = useMemo(
    () =>
      schemaCopyOpen && active && active.kind !== "sequence"
        ? templatePromptContext(active.doc, registry)
        : null,
    [schemaCopyOpen, active],
  );

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
  // The Edit-JSON modal renders OUTSIDE the studio roots, so its wrapper must
  // carry a COMPLETE token set — the empty-dark shorthand above would leave
  // every --as-* variable undefined out there, and the modal renders
  // transparent over the live canvas.
  const modalTheme = useMemo(
    () => ({
      ...(mode === "light" ? LIGHT_THEME : DARK_THEME),
      ...(accent ? { accent } : {}),
    }),
    [mode, accent],
  );
  const themeAccent = accent ?? (mode === "light" ? LIGHT_THEME.accent : DARK_THEME.accent);

  // Prompt context for the Edit-JSON modal, computed from the LIVE document
  // at open time — a copy taken after edits always describes what's on
  // screen, clouds included. Sequence files have no provider vocabulary.
  const editPromptCtx = useMemo(
    () =>
      editJsonOpen && active && active.kind !== "sequence"
        ? templatePromptContext(active.doc, registry)
        : null,
    [editJsonOpen, active],
  );

  // ── Auto-save to the repo's templates folder ──────────────────────────────
  //
  // Only while developing: the route lives in the vite dev server, so a built
  // app finds nothing and this whole section stays dark (see templates.js).
  // The point is that the diagrams you make are FILES — readable, diffable,
  // committable — rather than rows in localStorage nobody can see.

  /** null until probed; then the folder path the dev server is writing to. */
  const [templatesDir, setTemplatesDir] = useState(null);
  const [savedTemplates, setSavedTemplates] = useState([]);
  /** id → what we last wrote for it, so an idle app writes nothing at all. */
  const writtenRef = useRef(new Map());

  const refreshTemplates = useCallback(async () => {
    setSavedTemplates(await listTemplates());
  }, []);

  useEffect(() => {
    let live = true;
    probeTemplates().then((probe) => {
      if (!live || !probe) return;
      setTemplatesDir(probe.dir);
      setSavedTemplates(probe.templates);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!templatesDir) return undefined;
    // Debounced: a drag fires dozens of changes and none of them is a moment
    // worth writing to disk on its own.
    const timer = setTimeout(async () => {
      let touched = false;
      // Two files can carry the same name; their slugs must not collide, or
      // one would silently overwrite the other on disk.
      const claimed = new Map();
      for (const file of files) {
        const base = templateFile(file.name, file.id);
        const owner = claimed.get(base);
        const name = owner && owner !== file.id ? templateFile(`${file.name}-${file.id}`, file.id) : base;
        claimed.set(base, claimed.get(base) ?? file.id);
        const json = JSON.stringify(file.doc);
        const before = writtenRef.current.get(file.id);
        if (before?.file === name && before.json === json) continue;
        if (!(await writeTemplate(name, file.doc))) continue;
        // A rename writes the new name and takes the old file with it, rather
        // than leaving a stale twin behind.
        if (before && before.file !== name) await removeTemplate(before.file);
        writtenRef.current.set(file.id, { file: name, json });
        touched = true;
      }
      // Deleted in the app ⇒ deleted on disk. The workspace is the authority
      // while it is open; a file the user removed must not come back in the
      // dropdown.
      for (const [id, record] of [...writtenRef.current]) {
        if (files.some((f) => f.id === id)) continue;
        await removeTemplate(record.file);
        writtenRef.current.delete(id);
        touched = true;
      }
      if (touched) await refreshTemplates();
    }, 900);
    return () => clearTimeout(timer);
  }, [files, templatesDir, refreshTemplates]);

  /** Load one back into the active file, the way the examples do. */
  const openTemplate = useCallback(
    async (entry) => {
      const doc = await readTemplate(entry.file);
      if (!doc) return;
      setActiveDoc(entry.kind === "sequence" ? validateSequence(doc) : validateTemplate(doc));
      setSettingsOpen(false);
      toast.success(`Loaded ${entry.name}`, { description: entry.file });
    },
    [setActiveDoc],
  );

  // Guard against a stale-looking UI if another tab saves the workspace.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === WORKSPACE_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          // Same rule as seedWorkspace: an empty array is a real state.
          if (Array.isArray(parsed.files)) {
            setWorkspace({
              files: parsed.files.map((f) => ({ ...f, doc: validateDoc(f.kind, f.doc) })),
              activeId: parsed.activeId ?? null,
              removed: Array.isArray(parsed.removed)
                ? parsed.removed.map((f) => ({ ...f, doc: validateDoc(f.kind, f.doc) }))
                : [],
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

  // The settings dropdown dismisses like any menu: click away or Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event) => {
      if (!settingsRef.current?.contains(event.target)) setSettingsOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  const isSequence = active?.kind === "sequence";
  const counts = !active
    ? ""
    : isSequence
      ? `${active.doc.participants.length} participants · ${active.doc.messages.length} messages`
      : `${active.doc.nodes.length} nodes · ${active.doc.edges.length} edges`;

  return (
    <div className="app" data-theme={mode}>
      <Toaster theme={mode} position="bottom-right" closeButton richColors />
      <header className="app__bar">
        <div className="app__brand">
          <BrandMark className="app__logo" />
          <div>
            <h1 className="app__title">BetterDiagrams</h1>
            <p className="app__sub">
              A workspace of files · controlled by <code>value</code> / <code>onChange</code>
            </p>
          </div>
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
          {active && !isSequence ? (
            <button
              type="button"
              className="app__btn"
              onClick={deriveSequenceFile}
              title="Derive a NEW sequence file from this diagram's numbered flow (edge seq) — deterministic, no AI"
            >
              → Sequence
            </button>
          ) : null}
          {active ? (
            <>
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
            </>
          ) : null}
          <div className="app__menu" ref={settingsRef}>
            <button
              type="button"
              className="app__btn"
              onClick={() => {
                setSettingsOpen((on) => {
                  // Re-read the folder on the way open: a template pulled from
                  // git or written by hand is a file like any other, and the
                  // menu is the only place it can announce itself.
                  if (!on && templatesDir) void refreshTemplates();
                  return !on;
                });
              }}
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
            >
              ⚙ Settings
            </button>
            {settingsOpen ? (
              <div className="app__dropdown" role="menu" aria-label="Settings">
                {templatesDir ? (
                  <>
                    <span className="app__dropdown-caption" title={templatesDir}>
                      Saved templates
                    </span>
                    {savedTemplates.length ? (
                      savedTemplates.map((entry) => (
                        <button
                          key={entry.file}
                          type="button"
                          role="menuitem"
                          className="app__dropdown-item"
                          // A sequence template cannot land in the architecture
                          // editor, and the reverse — say so rather than
                          // failing on click.
                          disabled={!active || entry.kind === "unreadable" || entry.kind !== active.kind}
                          onClick={() => openTemplate(entry)}
                        >
                          {entry.name}
                          <span className="app__dropdown-desc">
                            {entry.kind === "unreadable"
                              ? `${entry.file} — not readable as JSON`
                              : `${entry.file} · ${entry.nodes} ${entry.kind === "sequence" ? "participants" : "nodes"}`}
                          </span>
                        </button>
                      ))
                    ) : null}
                    <span className="app__dropdown-note">
                      Auto-saving every open file to <code>/templates</code> as you work.
                    </span>
                  </>
                ) : null}
                <span className="app__dropdown-caption">Examples</span>
                <button
                  type="button"
                  role="menuitem"
                  className="app__dropdown-item"
                  disabled={!active || isSequence}
                  onClick={() => {
                    setActiveDoc(EXAMPLE_ZONED_TEMPLATE);
                    setSettingsOpen(false);
                  }}
                >
                  Multi-cloud
                  <span className="app__dropdown-desc">
                    Reset this file to the zoned multi-cloud example
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="app__dropdown-item"
                  disabled={!active || isSequence}
                  onClick={() => {
                    setActiveDoc(EXAMPLE_TEMPLATE);
                    setSettingsOpen(false);
                  }}
                >
                  Plain
                  <span className="app__dropdown-desc">
                    Reset this file to the plain example without zones
                  </span>
                </button>
                {isSequence ? (
                  <span className="app__dropdown-note">
                    Examples load into architecture files — switch to one to use them.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className={`app__body${showJson ? "" : " app__body--wide"}`}>
        {/* The editor fills whatever box it is given — it never assumes the viewport. */}
        <section className="app__editor">
          {!active ? (
            // Zero files: mount the editor over an empty document so its
            // welcome modal offers the ways back in (insert JSON, new file).
            <ArchitectureStudio
              key="__empty"
              value={EMPTY_TEMPLATE}
              readOnly={readOnly}
              minimap={minimap}
              registry={registry}
              theme={theme}
              {...fileProps}
            />
          ) : isSequence ? (
            <SequenceStudio
              key={active.id}
              value={active.doc}
              onChange={setActiveDoc}
              onSave={handleSave}
              readOnly={readOnly}
              theme={theme}
              generate={aiEnabled ? generate : undefined}
              filename={active.name}
              onSelectionChange={setSelection}
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
              onSelectionChange={setSelection}
              {...fileProps}
            />
          )}
        </section>

        {showJson && active ? (
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
            <div className="app__json-wrap">
              <HighlightedJson doc={active.doc} selection={selection} />
              <button
                type="button"
                className="app__json-edit"
                onClick={() => setEditJsonOpen(true)}
              >
                ✎ Edit template JSON
              </button>
            </div>
          </aside>
        ) : null}

        {/* One handle in one place: it flips rather than moving, so the
            control never jumps between the panel header and the screen edge. */}
        {/* No title when collapsed: the popover card below does the
            explaining, and a native tooltip on top of it would double up. */}
        <button
          type="button"
          className={`app__side-tab${showJson ? " app__side-tab--open" : ""}`}
          onClick={() => setShowJson((on) => !on)}
          title={showJson ? "Collapse the live template (⌘L)" : undefined}
          aria-label={showJson ? "Collapse the live template panel" : "Show the live template panel"}
          aria-expanded={showJson}
        >
          {showJson ? "»" : "«"}
        </button>
        {/* Hover card for the collapsed handle. Must stay the button's next
            sibling — CSS `.app__side-tab:hover + .app__side-pop` shows it,
            with the 200ms delay living in the transition. */}
        {!showJson ? (
          <div className="app__side-pop" aria-hidden="true">
            <strong className="app__side-pop-title">Template viewer</strong>
            <p className="app__side-pop-text">
              The live JSON template for this diagram — exactly what <code>onSave</code> hands
              you. Click to open (⌘L).
            </p>
          </div>
        ) : null}
      </main>

      {copyPromptCtx && active ? (
        // Same token-carrying wrapper as the Edit-JSON modal below: library
        // modals read --as-* tokens, which live on the studio roots.
        <div style={{ display: "contents", ...themeToStyle(modalTheme) }}>
          <SchemaCopyModal
            subtitle={`Scoped for “${active.name}”. Nothing is included that you haven't ticked — leave the clouds off for a provider-neutral schema.`}
            clouds={copyPromptCtx.cloudOptions}
            resources={copyPromptCtx.cloudResources}
            initialClouds={copyPromptCtx.referencedClouds}
            usedResources={copyPromptCtx.usedResources}
            buildPrompt={(scope, { geometry }) =>
              copyPromptCtx.promptForClouds(scope.clouds, {
                components: scope.components,
                geometry,
              })
            }
            onCopied={(_text, scope) =>
              toast.success("Copied the architecture schema", {
                description: scope.clouds.length
                  ? `${scope.clouds.join(", ")} — ${scope.components.length} resources. Paste it into your AI agent.`
                  : "Provider-neutral — name your cloud in your own prompt.",
              })
            }
            onClose={() => setSchemaCopyOpen(false)}
          />
        </div>
      ) : null}

      {editJsonOpen && active ? (
        // The library modal reads --as-* tokens, which live on the studio
        // roots — this wrapper carries a complete set without adding a
        // layout box.
        <div style={{ display: "contents", ...themeToStyle(modalTheme) }}>
          <WelcomeModal
            kind={active.kind === "sequence" ? "sequence" : "architecture"}
            // This dialog edits the CURRENT file — a paste must not silently
            // retype it, so the picker is pinned.
            lockKind
            defaultName={active.name}
            showNameField
            systemPrompt={editPromptCtx ? editPromptCtx.systemPrompt : buildSequencePrompt()}
            cloudProviders={editPromptCtx?.cloudOptions}
            promptForClouds={editPromptCtx?.promptForClouds}
            cloudResources={editPromptCtx?.cloudResources}
            usedResources={editPromptCtx?.usedResources}
            initialClouds={editPromptCtx?.referencedClouds}
            initialText={JSON.stringify(active.doc, null, 2)}
            parse={(text) =>
              active.kind === "sequence" ? parseLlmSequence(text) : parseLlmTemplate(text)
            }
            onInsert={(doc, name) => {
              setActiveDoc(doc);
              if (name && name !== active.name) fileProps.onFileRename(active.id, name);
              setEditJsonOpen(false);
            }}
            onDismiss={() => setEditJsonOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
