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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  UiIcon,
  WelcomeModal,
  buildSequencePrompt,
  createProxyGenerator,
  parseLlmSequence,
  parseLlmTemplate,
  sequenceFromTemplate,
  templatePromptContext,
  themeToStyle,
  importFolder,
  validateSequence,
  validateTemplate,
} from "@mosphere/better-diagrams";
import "@mosphere/better-diagrams/styles.css";
import { registry } from "./extensions.js";
import {
  LINKED_PREFIX,
  SCRATCH,
  flushTemplate,
  isSavable,
  linkFolder,
  onLinksChange,
  onTemplateChange,
  probeTemplates,
  readFolderTree,
  readTemplate,
  removeTemplate,
  templateFile,
  unlinkFolder,
  writeTemplate,
} from "./templates.js";

const WORKSPACE_KEY = "better-diagrams:workspace";
// Storage keys from earlier builds, read once so saved work survives a rename.
const LEGACY_WORKSPACE_KEY = "architecture-studio:workspace";
const LEGACY_ARCH_KEY = "architecture-studio:example";
const LEGACY_SEQ_KEY = "architecture-studio:example-sequence";

let fileCounter = 0;
const nextFileId = () => `f_${Date.now().toString(36)}${(fileCounter++).toString(36)}`;

/**
 * Registry-aware, like the folder import below: a plain `validateTemplate`
 * knows only the built-in kinds and rewrites every other one to "service",
 * so a data model read back from localStorage or a template file would lose
 * its entities before the studio ever saw it.
 */
const VALIDATE = { knownKinds: Object.keys(registry.nodeKinds) };
const validateDoc = (kind, doc) =>
  kind === "sequence" ? validateSequence(doc) : validateTemplate(doc, VALIDATE);

/**
 * Where each workspace file lives on disk while developing: the file it is
 * bound to (`disk` — it was opened from there, or changed there), else a
 * scratch file named after it. Bound files claim their paths first, so an
 * unbound file whose name slugs to a claimed path is suffixed with its id
 * rather than writing over another file's disk copy.
 */
function diskPaths(files) {
  const paths = new Map();
  const claimed = new Set();
  for (const f of files) {
    if (!f.disk) continue;
    paths.set(f.id, f.disk);
    claimed.add(`${f.disk.folder}/${f.disk.file}`);
  }
  for (const f of files) {
    if (f.disk) continue;
    let file = templateFile(f.name, f.id);
    if (claimed.has(`${SCRATCH}/${file}`)) file = templateFile(`${f.name}-${f.id}`, f.id);
    claimed.add(`${SCRATCH}/${file}`);
    paths.set(f.id, { folder: SCRATCH, file });
  }
  return paths;
}

/**
 * A disk file as a person reads it in a toast: a linked folder by its path
 * (`~/work/tracker/plan.json`), a repo folder by its name (`examples/…`).
 */
function whereIs(linked, folder, file) {
  const link = linked?.find((l) => l.folder === folder);
  return `${link ? link.display : folder}/${file}`;
}

/** `Plan, Roadmap` — workspace files named in a toast. */
const namesOf = (files) => files.map((f) => f.name).join(", ");

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
  const [minimap, setMinimap] = useState(false);
  const [mode, setMode] = useState("light");
  // "technical" | "marketing" — the editor's presentation mode, independent
  // of light/dark.
  const [studioMode, setStudioMode] = useState("marketing");
  // Marketing's one setting: its gradients, or one flat coat per card. Kept
  // while the mode is technical (where it is inert) so flipping back to
  // marketing finds it where it was left.
  const [gradients, setGradients] = useState(false);
  // Draw a connection only while the pointer is over a node it touches.
  const [edgesOnHover, setEdgesOnHover] = useState(false);
  // null = "use the active theme's accent"; set once the user picks a colour.
  const [accent, setAccent] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  // The template panel starts collapsed; hovering the handle explains what it is.
  const [showJson, setShowJson] = useState(false);
  /** The template-JSON edit modal over the viewer panel. */
  const [editJsonOpen, setEditJsonOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);
  // What's selected on the canvas, in document terms. The editors fire this
  // on mount too, so a file switch (which remounts them) clears it for free.
  const [selection, setSelection] = useState(null);
  /** The fields pinned in the architecture editor — mirrored here like the selection. */
  const [pins, setPins] = useState([]);
  /** The keys the coverage panel is scoring — mirrored the same way. */
  const [coverageKeys, setCoverageKeys] = useState([]);

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

  /** null until probed AND reconciled; then `{ examples, scratch, folders }` — the dev server's folders. */
  const [templatesDir, setTemplatesDir] = useState(null);
  const [savedTemplates, setSavedTemplates] = useState([]);
  /**
   * The folders linked from outside the repo, as the server last listed them:
   * `[{ folder, name, dir, display, source, missing }]` (see templates.js).
   */
  const [linked, setLinked] = useState([]);
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  /** Can the dev server show the system's folder dialog? Without one, linking takes a typed path. */
  const [picker, setPicker] = useState(false);
  /** id → the disk file it was last synced with and that document's JSON, so an idle app writes nothing. */
  const writtenRef = useRef(new Map());
  /** Ids of files whose last save failed — warned about once, until a save goes through. */
  const failingRef = useRef(new Set());
  /** The workspace as of the last render — for the async sync paths below. */
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  /** Take in a listing from the server — the probe's, or a link's answer. */
  const applyListing = useCallback((listing) => {
    setSavedTemplates(listing.templates ?? []);
    setLinked(listing.linked ?? []);
    setPicker(Boolean(listing.picker));
  }, []);

  const refreshTemplates = useCallback(async () => {
    const probe = await probeTemplates();
    if (probe) applyListing(probe);
  }, [applyListing]);

  /** A save that went through after failing: take its warning down. */
  const clearFailure = (id) => {
    if (failingRef.current.delete(id)) toast.dismiss(`save-failed:${id}`);
  };

  /**
   * Adopt documents read from disk — the file on disk wins. Each adopted file
   * is BOUND to the file it came from (`disk`), so a title changed on disk
   * renames the workspace file without moving the file underneath it, and
   * its next edit in the app saves straight back there. The sync record is
   * set to the adopted document, so adopting writes nothing back: the file
   * keeps the exact text its author wrote until someone edits it here.
   */
  const adoptFromDisk = useCallback(
    (adopted) => {
      if (!adopted.length) return;
      const byId = new Map(adopted.map((a) => [a.id, a]));
      for (const a of adopted) {
        writtenRef.current.set(a.id, { ...a.path, json: JSON.stringify(a.doc) });
        // Whatever kept its save failing (a half-written file), disk has won now.
        clearFailure(a.id);
      }
      updateWorkspace((ws) => ({
        ...ws,
        files: ws.files.map((f) => {
          const a = byId.get(f.id);
          if (!a) return f;
          const title = typeof a.doc.meta?.title === "string" && a.doc.meta.title.trim() ? a.doc.meta.title : f.name;
          return { ...f, doc: a.doc, name: title, disk: a.path };
        }),
      }));
    },
    [updateWorkspace],
  );

  /**
   * Read each file's disk copy and adopt whichever differ. Files with no disk
   * copy yet are left for auto-save to write; files that already match just
   * have their sync record set.
   */
  const reconcile = useCallback(
    async (targets) => {
      const adopted = [];
      for (const { file, path } of targets) {
        const raw = await readTemplate(path.folder, path.file);
        if (!raw) continue;
        let doc;
        try {
          doc = validateDoc(file.kind, raw);
        } catch {
          continue; // mid-save or hand-broken JSON: keep what the app has
        }
        const json = JSON.stringify(doc);
        // Compared against the LIVE document, not the one this pass started
        // from: an edit made while the read was in flight is newer than the
        // record, and only a real disk change may replace it.
        const live = workspaceRef.current.files.find((f) => f.id === file.id);
        if (!live) continue;
        if (json === JSON.stringify(live.doc)) {
          writtenRef.current.set(file.id, { ...path, json });
          continue;
        }
        adopted.push({ id: file.id, path, doc });
      }
      adoptFromDisk(adopted);
      return adopted;
    },
    [adoptFromDisk],
  );

  useEffect(() => {
    let live = true;
    probeTemplates().then(async (probe) => {
      if (!live || !probe) return;
      applyListing(probe);
      // Disk wins at startup too. Auto-save stays off (no `templatesDir`)
      // until this pass is done — otherwise it would write the workspace's
      // stored copies over files another program changed while the app was
      // closed, before the app had even looked at them.
      const { files: current } = workspaceRef.current;
      const paths = diskPaths(current);
      await reconcile(current.map((file) => ({ file, path: paths.get(file.id) })));
      if (live) setTemplatesDir(probe.dirs);
    });
    return () => {
      live = false;
    };
  }, [reconcile, applyListing]);

  // Another program changed a template on disk: reload whichever open file
  // is synced with it. The server never announces its own writes, and a file
  // whose disk copy already matches is left alone, so the app's saves don't
  // bounce back as reloads.
  useEffect(() => {
    if (!templatesDir) return undefined;
    return onTemplateChange(async ({ folder, file: name }) => {
      void refreshTemplates();
      const { files: current } = workspaceRef.current;
      const paths = diskPaths(current);
      const targets = current
        .filter((f) => paths.get(f.id)?.folder === folder && paths.get(f.id)?.file === name)
        .map((f) => ({ file: f, path: paths.get(f.id) }));
      if (!targets.length) return;
      const adopted = await reconcile(targets);
      for (const a of adopted) {
        const file = workspaceRef.current.files.find((f) => f.id === a.id);
        toast.info(`Reloaded ${file?.name ?? name} from disk`, { description: whereIs(linkedRef.current, folder, name) });
      }
    });
  }, [templatesDir, reconcile, refreshTemplates]);

  // A linked folder appeared or vanished on disk (moved, deleted, a drive
  // unmounted): re-list, so the menu and the re-link warning catch up.
  useEffect(() => {
    if (!templatesDir) return undefined;
    return onLinksChange(() => void refreshTemplates());
  }, [templatesDir, refreshTemplates]);

  /**
   * Say which saves failed — once per file until one goes through. A failed
   * save to a linked folder is most likely the folder going missing, so the
   * folders are re-listed first and a lost one is left to the re-link
   * warning. No server at all (a restart) is not worth a word.
   */
  const reportSaveFailures = useCallback(
    async (failures) => {
      const probe = await probeTemplates();
      if (probe) applyListing(probe);
      const listedLinks = probe?.linked ?? [];
      const lost = (folder) => folder.startsWith(LINKED_PREFIX) && !listedLinks.some((l) => l.folder === folder && !l.missing);
      for (const { file, path, result } of failures) {
        if (result.status === 0 || lost(path.folder) || failingRef.current.has(file.id)) continue;
        failingRef.current.add(file.id);
        toast.warning(`Couldn't save ${file.name}`, {
          id: `save-failed:${file.id}`,
          description: `${whereIs(listedLinks, path.folder, path.file)}: ${result.error}. Edits stay in this browser.`,
          duration: Infinity,
        });
      }
    },
    [applyListing],
  );

  useEffect(() => {
    if (!templatesDir) return undefined;
    // Debounced: a drag fires dozens of changes and none of them is a moment
    // worth writing to disk on its own. And CANCELLABLE: a pass awaits the
    // network, and `files` can change under it. Without the flag, a pass
    // started against an older file list could reach its delete loop after a
    // newer pass had written a just-created file — and delete it, because the
    // older list never had it. Once cancelled, the pass stops touching disk
    // and the ref; the pass for the new list redoes the work from what
    // actually landed. A reload from disk lands here as a change too, and
    // cancels any write still waiting: the file on disk wins.
    let cancelled = false;
    const timer = setTimeout(async () => {
      let touched = false;
      const failures = [];
      const paths = diskPaths(files);
      const claimed = new Set([...paths.values()].map((p) => `${p.folder}/${p.file}`));
      for (const file of files) {
        const path = paths.get(file.id);
        const json = JSON.stringify(file.doc);
        const before = writtenRef.current.get(file.id);
        const moved = before && (before.folder !== path.folder || before.file !== path.file);
        if (before && !moved && before.json === json) continue;
        if (cancelled) return;
        const result = await writeTemplate(path.folder, path.file, file.doc);
        if (cancelled) return;
        if (!result.ok) {
          failures.push({ file, path, result });
          continue;
        }
        clearFailure(file.id);
        // A rename of an unbound file writes the new name and takes the old
        // scratch file with it, rather than leaving a stale twin behind.
        if (moved && before.folder === SCRATCH && !claimed.has(`${before.folder}/${before.file}`)) {
          await removeTemplate(before.file);
        }
        if (cancelled) return;
        writtenRef.current.set(file.id, { ...path, json });
        touched = true;
      }
      // Deleted in the app ⇒ deleted on disk — scratch only. The workspace is
      // the authority while it is open; a file the user removed must not come
      // back in the dropdown. A tracked example is never deleted.
      for (const [id, record] of [...writtenRef.current]) {
        if (files.some((f) => f.id === id)) continue;
        if (cancelled) return;
        if (record.folder === SCRATCH && !claimed.has(`${record.folder}/${record.file}`)) {
          await removeTemplate(record.file);
        }
        if (cancelled) return;
        writtenRef.current.delete(id);
        clearFailure(id);
        touched = true;
      }
      if (failures.length && !cancelled) await reportSaveFailures(failures);
      if (touched && !cancelled) await refreshTemplates();
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [files, templatesDir, refreshTemplates, reportSaveFailures]);

  // Closing the tab inside the debounce would drop the last edit; hand the
  // unsynced files to the browser to finish writing on the way out.
  useEffect(() => {
    if (!templatesDir) return undefined;
    const flush = () => {
      const { files: current } = workspaceRef.current;
      const paths = diskPaths(current);
      for (const file of current) {
        const path = paths.get(file.id);
        const before = writtenRef.current.get(file.id);
        const json = JSON.stringify(file.doc);
        if (before && before.folder === path.folder && before.file === path.file && before.json === json) continue;
        flushTemplate(path.folder, path.file, file.doc);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [templatesDir]);

  /**
   * Open a template. A file from scratch or examples opens as its OWN
   * workspace file, bound to that file on disk — edits save back to it and
   * outside edits reload into it — or, if a workspace file is already bound
   * to it, switches there. (Loading it over the active file would have
   * thrown that file's content away.)
   */
  const openTemplate = useCallback(
    async (entry) => {
      if (entry.folder === "folders") {
        // A folder-format tree: fetched whole, converted on the client, so
        // the same code path a dropped directory takes is what runs here.
        const tree = await readFolderTree(entry.file);
        if (!tree) return;
        const result = importFolder(new Map(Object.entries(tree.files)), {
          validate: VALIDATE,
        });
        setActiveDoc(result.template);
        setSettingsOpen(false);
        const { nodes, edges } = result.stats;
        toast.success(`Imported ${entry.name}`, {
          description: `${result.dialect} · ${nodes} nodes · ${edges} edges${
            result.warnings.length ? ` · ${result.warnings.length} warnings (see console)` : ""
          }`,
        });
        if (result.warnings.length) console.warn(`importFolder(${entry.file}):`, result.warnings);
        return;
      }
      const raw = await readTemplate(entry.folder, entry.file);
      if (!raw) return;
      const kind = entry.kind === "sequence" ? "sequence" : "architecture";
      const doc = validateDoc(kind, raw);
      // A linked file's binding also keeps the folder's path, so a later
      // session started without that link can say which folder it needs.
      const link = linkedRef.current.find((l) => l.folder === entry.folder);
      const path = { folder: entry.folder, file: entry.file, ...(link ? { display: link.display } : {}) };
      const where = whereIs(linkedRef.current, entry.folder, entry.file);
      setSettingsOpen(false);
      const { files: current } = workspaceRef.current;
      const paths = diskPaths(current);
      const open = current.find((f) => paths.get(f.id)?.folder === path.folder && paths.get(f.id)?.file === path.file);
      if (open) {
        updateWorkspace((ws) => ({ ...ws, activeId: open.id }));
        await reconcile([{ file: open, path }]);
        toast.success(`Switched to ${open.name}`, { description: `${where} — already open` });
        return;
      }
      const id = nextFileId();
      // In sync from the start: opening writes nothing back.
      if (isSavable(entry.folder)) writtenRef.current.set(id, { ...path, json: JSON.stringify(doc) });
      updateWorkspace((ws) => ({
        ...ws,
        files: [
          ...ws.files,
          { id, name: entry.name, kind, doc, ...(isSavable(entry.folder) ? { disk: path } : {}) },
        ],
        activeId: id,
      }));
      toast.success(`Opened ${entry.name}`, { description: `${where} — saved back as you edit` });
    },
    [setActiveDoc, updateWorkspace, reconcile],
  );

  // ── Linking folders outside the repo ──────────────────────────────────────
  //
  // A linked folder can be lost: moved, renamed, deleted, on a drive that is
  // not mounted, or named in a BD_LINKED_DIRS this server was started
  // without. Files bound to it can then neither load nor save — their edits
  // live only in this browser — so they are STRANDED, and the app says so
  // and offers a re-link: pick where the folder is now, and the files bind
  // to the same names there. Picking goes through the dev server, which can
  // show the system's own folder dialog and so learn the real path; a
  // browser's folder picker never tells the page where a folder is.

  /** Stranded files, one group per folder they were bound to. */
  const strandedGroups = useMemo(() => {
    if (!templatesDir) return [];
    const groups = new Map();
    for (const f of files) {
      const folder = f.disk?.folder;
      if (!folder?.startsWith(LINKED_PREFIX)) continue;
      const link = linked.find((l) => l.folder === folder);
      if (link && !link.missing) continue;
      if (!groups.has(folder)) {
        groups.set(folder, { folder, display: link?.display ?? f.disk.display ?? folder, missing: Boolean(link), files: [] });
      }
      groups.get(folder).files.push(f);
    }
    return [...groups.values()];
  }, [files, linked, templatesDir]);

  /** The Link-a-folder form in the Settings menu: null, or `{ group? }` — `group` when it re-links one. */
  const [linkForm, setLinkForm] = useState(null);
  const [linkPath, setLinkPath] = useState("");
  const [linkError, setLinkError] = useState(null);
  const [linkBusy, setLinkBusy] = useState(false);

  const openLinkForm = useCallback((group) => {
    setLinkForm(group ? { group } : {});
    // A re-link starts from where the folder was: often it was only renamed.
    setLinkPath(group?.display ?? "");
    setLinkError(null);
    setSettingsOpen(true);
  }, []);

  // The form belongs to the menu: closing the menu puts it away.
  useEffect(() => {
    if (!settingsOpen) setLinkForm(null);
  }, [settingsOpen]);

  // One warning per lost folder, kept up until it is re-linked (or its files
  // stop syncing). Keyed on the folders and files it names, not on every
  // edit, so typing in a stranded file doesn't keep re-raising it.
  const strandedKey = strandedGroups.map((g) => `${g.folder}:${g.missing}=${g.files.map((f) => f.id).join(",")}`).join("|");
  const strandedShown = useRef(new Set());
  useEffect(() => {
    const shown = strandedShown.current;
    for (const folder of [...shown]) {
      if (strandedGroups.some((g) => g.folder === folder)) continue;
      toast.dismiss(`stranded:${folder}`);
      shown.delete(folder);
    }
    for (const group of strandedGroups) {
      shown.add(group.folder);
      toast.warning(`${namesOf(group.files)} ${group.files.length === 1 ? "isn't" : "aren't"} synced to disk`, {
        id: `stranded:${group.folder}`,
        description: `Bound to ${group.display}, which ${
          group.missing ? "is missing — moved, renamed or deleted?" : "this dev server isn't linking"
        }. Edits stay in this browser until it's re-linked.`,
        duration: Infinity,
        action: { label: "Re-link…", onClick: () => openLinkForm(group) },
      });
    }
  }, [strandedKey]);

  /** Bind a workspace file to a disk file, in sync as of `json` — the disk copy's. */
  const bindTo = useCallback(
    (id, path, json) => {
      writtenRef.current.set(id, { ...path, json });
      updateWorkspace((ws) => ({ ...ws, files: ws.files.map((f) => (f.id === id ? { ...f, disk: path } : f)) }));
    },
    [updateWorkspace],
  );

  /**
   * Stop syncing every file bound to a folder: each carries on as an ordinary
   * workspace file, which auto-save writes to scratch. Nothing in the folder
   * is touched.
   */
  const unbind = useCallback(
    (folder) => {
      const bound = workspaceRef.current.files.filter((f) => f.disk?.folder === folder);
      if (bound.length) {
        updateWorkspace((ws) => ({
          ...ws,
          files: ws.files.map((f) => {
            if (f.disk?.folder !== folder) return f;
            const { disk: _unbound, ...rest } = f;
            return rest;
          }),
        }));
      }
      return bound;
    },
    [updateWorkspace],
  );

  /**
   * After a re-link: bind each stranded file to its namesake in the new
   * folder. Where the two copies match, quietly. Where they differ, both may
   * hold work — edits made here while the folder was lost, edits made to the
   * file since — so the person picks, and until they do nothing is written.
   */
  const rebind = useCallback(
    async (group, link, templates) => {
      const synced = [];
      const notThere = [];
      for (const { id } of group.files) {
        const f = workspaceRef.current.files.find((x) => x.id === id);
        if (!f || f.disk?.folder !== group.folder) continue; // closed, or re-linked meanwhile
        const target = { folder: link.folder, file: f.disk.file, display: link.display };
        const where = whereIs([link], target.folder, target.file);
        const listed = templates.find((t) => t.folder === target.folder && t.file === target.file);
        if (!listed || listed.kind === "unreadable") {
          notThere.push(f);
          continue;
        }
        // Opened from the new folder already: two files bound to one would write over each other.
        const twin = workspaceRef.current.files.find((x) => x.id !== id && x.disk?.folder === target.folder && x.disk?.file === target.file);
        if (twin) {
          toast.info(`${f.name} is already open as ${twin.name}`, { description: `Both are ${where} — close one, then re-link.` });
          continue;
        }
        const raw = await readTemplate(target.folder, target.file);
        let doc;
        try {
          doc = raw && validateDoc(f.kind, raw);
        } catch {
          doc = null;
        }
        if (!doc) {
          notThere.push(f);
          continue;
        }
        const json = JSON.stringify(doc);
        const live = workspaceRef.current.files.find((x) => x.id === id);
        if (!live) continue;
        if (json === JSON.stringify(live.doc)) {
          bindTo(id, target, json);
          synced.push(f);
          continue;
        }
        toast(`${f.name} differs from ${where}`, {
          id: `relink:${id}`,
          description: "One of them changed while they weren't syncing. Keep which?",
          duration: Infinity,
          // Bound in sync with the DISK copy, so auto-save writes this one over it.
          action: { label: "Keep my edits", onClick: () => bindTo(id, target, json) },
          cancel: { label: "Use the file", onClick: () => adoptFromDisk([{ id, path: target, doc }]) },
        });
      }
      if (synced.length) {
        toast.success(`Re-linked ${link.display}`, { description: `${namesOf(synced)} ${synced.length === 1 ? "syncs" : "sync"} again` });
      }
      if (notThere.length) {
        toast.warning(`${namesOf(notThere)} ${notThere.length === 1 ? "isn't" : "aren't"} in ${link.display}`, {
          description: `No diagram named ${notThere.map((f) => f.disk.file).join(", ")} there — still not syncing. Re-link to the folder that has it.`,
        });
      }
    },
    [adoptFromDisk, bindTo],
  );

  /** Link (or re-link) a folder: `{ dir }` typed, or `{ pick: true }` through the system's dialog. */
  const linkWith = useCallback(
    async (request, group) => {
      setLinkBusy(true);
      setLinkError(null);
      try {
        const answer = await linkFolder({ ...request, ...(group ? { replaces: group.folder } : {}) });
        if (answer.cancelled) return;
        if (answer.unsupported) {
          setPicker(false);
          setLinkError("No folder dialog on this system — type the path instead.");
          return;
        }
        if (!answer.link) {
          setLinkError(answer.error ?? "Couldn't link that folder");
          return;
        }
        applyListing(answer);
        setLinkForm(null);
        const { link } = answer;
        if (group) {
          await rebind(group, link, answer.templates);
          return;
        }
        const count = answer.templates.filter((t) => t.folder === link.folder && t.kind !== "unreadable").length;
        toast.success(`Linked ${link.display}`, {
          description: `${count} ${count === 1 ? "diagram" : "diagrams"}, listed under Linked / ${link.name}`,
        });
      } finally {
        setLinkBusy(false);
      }
    },
    [applyListing, rebind],
  );

  /** Unlink a folder linked from the app; its open files carry on as ordinary files. */
  const unlink = useCallback(
    async (link) => {
      const answer = await unlinkFolder(link.folder);
      if (answer.error) {
        toast.error(`Couldn't unlink ${link.display}`, { description: answer.error });
        return;
      }
      applyListing(answer);
      const bound = unbind(link.folder);
      toast.success(`Unlinked ${link.display}`, {
        description: bound.length
          ? `${namesOf(bound)} ${bound.length === 1 ? "is" : "are"} no longer synced with it, and saved to scratch instead`
          : "Its files stay where they are",
      });
    },
    [applyListing, unbind],
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
      // Not ⌘⇧L — that is the editor's lock shortcut, and swallowing it here
      // meant locking a zone toggled this panel instead.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "l"
      ) {
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
    // The Accent picker drives the shell's own toggles too, not just the
    // editor's `theme` prop — a colour control that restyles half the page and
    // leaves the other half on a default reads as a bug.
    <div className="app" data-theme={mode} style={{ "--shell-accent": themeAccent }}>
      <Toaster theme={mode} position="bottom-right" closeButton richColors />
      <header className="app__bar">
        <div className="app__brand">
          <BrandMark className="app__logo" />
          <div>
            <h1 className="app__title">BetterDiagrams</h1>
            <p className="app__sub">
              Schema driven diagrams your AI agent can understand, and you can edit.
            </p>
          </div>
        </div>

        <div className="app__controls">
          <label className="app__toggle">
            Accent
            <input type="color" value={themeAccent} onChange={(e) => setAccent(e.target.value)} />
          </label>
          <span className="app__controls-sep" aria-hidden="true" />

          {active && !isSequence ? (
            <button
              type="button"
              className="app__btn"
              onClick={deriveSequenceFile}
              title="Derive a NEW sequence file from this diagram's numbered flow (edge seq) — deterministic, no AI"
            >
              <UiIcon name="arrowRight" size={14} />
              {/* "Derive sequence", not "Sequence": the switch-kind button
                  beside it is already named for the kind it switches to, and
                  the ⇄/→ glyphs that used to tell the two apart were never
                  announced to a screen reader. */}
              Derive sequence
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
                <UiIcon name="swap" size={14} />
                {isSequence ? "Architecture" : "Sequence"}
              </button>
              <button
                type="button"
                className="app__btn"
                onClick={copySchema}
                title="Copy Schema Definition For Diagram — paste it into your AI agent"
              >
                <UiIcon name="sparkle" size={14} />
                Copy schema
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
              <UiIcon name="settings" size={14} />
              Settings
            </button>
            {settingsOpen ? (
              <div className="app__dropdown" role="menu" aria-label="Settings">
                {/* Linking a folder takes over the top of the menu, so a
                    re-link raised from a warning lands in view. */}
                {linkForm ? (
                  <form
                    className="app__link-form"
                    aria-label={linkForm.group ? "Re-link folder" : "Link a folder"}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void linkWith({ dir: linkPath }, linkForm.group);
                    }}
                  >
                    {/* The caption is set in capitals, so the path goes in the note. */}
                    <span className="app__dropdown-caption">{linkForm.group ? "Re-link a folder" : "Link a folder"}</span>
                    <span className="app__dropdown-note">
                      {linkForm.group
                        ? `${linkForm.group.display} — where is it now?${
                            linkForm.group.files.length
                              ? ` ${namesOf(linkForm.group.files)} will sync with the same ${
                                  linkForm.group.files.length === 1 ? "file name" : "file names"
                                } there.`
                              : ""
                          }`
                        : "A folder of diagram JSON outside this repo. Its files open live, like examples."}
                    </span>
                    <div className="app__link-row">
                      <input
                        className="app__link-input"
                        aria-label="Folder path"
                        placeholder="~/path/to/folder"
                        spellCheck={false}
                        autoFocus
                        value={linkPath}
                        onChange={(event) => setLinkPath(event.target.value)}
                      />
                      {picker ? (
                        <button
                          type="button"
                          className="app__link-btn"
                          disabled={linkBusy}
                          // The dev server shows the system's dialog and
                          // answers with the folder's real path.
                          onClick={() => void linkWith({ pick: true, near: linkPath.trim() || undefined }, linkForm.group)}
                        >
                          Browse…
                        </button>
                      ) : null}
                    </div>
                    {linkError ? (
                      <span className="app__link-error" role="alert">
                        {linkError}
                      </span>
                    ) : null}
                    <div className="app__link-row app__link-row--end">
                      <button type="button" className="app__link-btn" onClick={() => setLinkForm(null)}>
                        Cancel
                      </button>
                      <button type="submit" className="app__link-btn app__link-btn--primary" disabled={linkBusy || !linkPath.trim()}>
                        {linkForm.group ? "Re-link" : "Link"}
                      </button>
                    </div>
                  </form>
                ) : null}
                {/* The view settings live here rather than loose on the bar:
                    they are set once and left, and eight chips across the
                    top read as a toolbar for things you never touch. Each
                    is a checkbox, so the menu stays open while you tick. */}
                <span className="app__dropdown-caption">View</span>
                {[
                  ["Read-only", readOnly, setReadOnly, "Hide every editing affordance; pan, zoom and export still work"],
                  ["Minimap", minimap, setMinimap, "The overview in the canvas corner"],
                  ["AI panel", aiEnabled, setAiEnabled, "Offer the AI generate / refine panel"],
                  ["Light", mode === "light", (on) => setMode(on ? "light" : "dark"), "Light theme, or dark"],
                  [
                    "Marketing",
                    studioMode === "marketing",
                    (on) => setStudioMode(on ? "marketing" : "technical"),
                    "The presentation look — bigger type and icons, tucked-away labels",
                  ],
                  // Only meaningful in marketing mode — technical has no
                  // gradients to switch off — so it only shows there.
                  ...(studioMode === "marketing"
                    ? [["Gradients", gradients, setGradients, "Marketing's gradients, or one flat coat per card — on screen and in every picture export"]]
                    : []),
                  [
                    "Lines on hover",
                    edgesOnHover,
                    setEdgesOnHover,
                    "Draw a connection only while the pointer is over a node it touches; a selected node keeps its lines",
                  ],
                  ["JSON", showJson, setShowJson, "The live template panel beside the editor"],
                ].map(([label, checked, set, hint]) => (
                  <label key={label} className="app__dropdown-check" title={hint}>
                    <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
                    {label}
                  </label>
                ))}
                {templatesDir ? (
                  <>
                    {/* One section per folder, in the order a reader ranks them:
                        the curated examples first, then whatever auto-save has
                        been writing, then the folders linked from outside the
                        repo. An empty folder still gets its caption, so every
                        place a template can live is always visible. */}
                    {[
                      ["examples", "Templates / examples", "Curated and tracked — opens live: edits save back, disk edits reload"],
                      ["scratch", "Templates / scratch", "Auto-saved as you work; git-ignored; live like examples"],
                      ["folders", "Templates / folders", "Folder-format trees — imported on open; git-ignored"],
                      ...linked.map((l) => [
                        l.folder,
                        `Linked / ${l.name}${l.missing ? " — missing" : ""}`,
                        l.missing
                          ? "Moved, renamed or deleted? Re-link it to where it is now"
                          : `Outside the repo${l.source === "env" ? ", from BD_LINKED_DIRS" : ""} — live like examples; never deleted`,
                        l.display,
                        l,
                      ]),
                    ].map(([folder, caption, note, title = templatesDir[folder], link]) => {
                      const entries = savedTemplates.filter((entry) => entry.folder === folder);
                      return (
                        <Fragment key={folder}>
                          <span className="app__dropdown-caption" title={title}>
                            {caption}
                          </span>
                          {entries.map((entry) => (
                            <button
                              key={`${entry.folder}/${entry.file}`}
                              type="button"
                              role="menuitem"
                              className="app__dropdown-item"
                              // A template opens as a workspace file of its own kind,
                              // so any readable one can open; only a folder tree,
                              // which still loads into the active file, needs an
                              // architecture file to land in.
                              disabled={
                                entry.kind === "unreadable" ||
                                // A folder tree still loads into the active file.
                                (entry.folder === "folders" && (!active || active.kind !== "architecture"))
                              }
                              onClick={() => openTemplate(entry)}
                            >
                              {entry.name}
                              <span className="app__dropdown-desc">
                                {entry.kind === "unreadable"
                                  ? `${entry.file} — ${entry.reason ?? "not readable as JSON"}`
                                  : entry.folder === "folders"
                                    ? `${entry.file}/ · folder format`
                                    : `${entry.file} · ${entry.nodes} ${entry.kind === "sequence" ? "participants" : "nodes"}`}
                              </span>
                            </button>
                          ))}
                          {link?.missing ? (
                            <button
                              type="button"
                              role="menuitem"
                              className="app__dropdown-item"
                              onClick={() =>
                                openLinkForm(
                                  strandedGroups.find((g) => g.folder === link.folder) ?? {
                                    folder: link.folder,
                                    display: link.display,
                                    missing: true,
                                    files: [],
                                  },
                                )
                              }
                            >
                              Re-link {link.name}…
                              <span className="app__dropdown-desc">Pick where the folder is now</span>
                            </button>
                          ) : null}
                          {link?.source === "saved" ? (
                            <button type="button" role="menuitem" className="app__dropdown-item" onClick={() => void unlink(link)}>
                              Unlink {link.name}
                              <span className="app__dropdown-desc">Stop listing it; files open from it save to scratch instead</span>
                            </button>
                          ) : null}
                          <span className="app__dropdown-note">{note}</span>
                        </Fragment>
                      );
                    })}
                    {/* Files bound to a folder this server doesn't link at all
                        (the env var changed, or the link was saved elsewhere). */}
                    {strandedGroups.some((g) => !g.missing) ? (
                      <span className="app__dropdown-caption">Needs re-linking</span>
                    ) : null}
                    {strandedGroups
                      .filter((g) => !g.missing)
                      .map((g) => (
                        <Fragment key={g.folder}>
                          <button type="button" role="menuitem" className="app__dropdown-item" onClick={() => openLinkForm(g)}>
                            Re-link {g.display}…
                            <span className="app__dropdown-desc">{namesOf(g.files)} — edits stay in this browser until then</span>
                          </button>
                          <button type="button" role="menuitem" className="app__dropdown-item" onClick={() => unbind(g.folder)}>
                            Stop syncing {namesOf(g.files)}
                            <span className="app__dropdown-desc">Keep {g.files.length === 1 ? "it" : "them"} as ordinary files, saved to scratch</span>
                          </button>
                        </Fragment>
                      ))}
                    <button type="button" role="menuitem" className="app__dropdown-item" onClick={() => openLinkForm()}>
                      Link a folder…
                      <span className="app__dropdown-desc">Diagram JSON that lives with another project, outside this repo</span>
                    </button>
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
              edgesOnHover={edgesOnHover}
              registry={registry}
              theme={theme}
              mode={studioMode}
              gradients={gradients}
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
              mode={studioMode}
              gradients={gradients}
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
              edgesOnHover={edgesOnHover}
              registry={registry}
              theme={theme}
              mode={studioMode}
              gradients={gradients}
              generate={aiEnabled ? generate : undefined}
              filename={active.name}
              onNavigateFile={navigateFile}
              onSelectionChange={setSelection}
              onPinsChange={setPins}
              onCoverageChange={setCoverageKeys}
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
                {pins.length ? ` · ${pins.length} pinned` : ""}
                {coverageKeys.length ? ` · ${coverageKeys.length} coverage key${coverageKeys.length === 1 ? "" : "s"}` : ""}
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
                <UiIcon name="pencil" size={13} />
                Edit template JSON
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
          <UiIcon name={showJson ? "chevronRight" : "chevronLeft"} size={14} />
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
