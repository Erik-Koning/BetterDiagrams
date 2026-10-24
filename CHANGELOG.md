# Changelog

All notable changes to `@mosphere/better-diagrams`. The public API is pinned in
`packages/better-diagrams/etc/*.api.md`; a change there is listed here.

## Unreleased

This changelog starts with the editing API (October 2026). For what changed between
0.1.0-beta.0 and then, see the git history.

### Added

- **Editing the document from code** (`contract`): `addNode`, `updateNode`, `renameNode`,
  `removeNodes`, `addEdge`, `updateEdge`, `removeEdges`, `addZone`, `updateZone`, `removeZones`,
  `removeElements` and `uniqueId` — pure edits that keep every reference consistent and refuse,
  rather than repair, a reference to nothing.
- `validateTemplateReport` — `validateTemplate` plus a list of every repair it made, with a JSON
  Pointer into the input and a code from `VALIDATION_ISSUE_CODES`.
- `diagramJsonSchema()` and the shipped `@mosphere/better-diagrams/schema.json` — the document as
  JSON Schema (draft 2020-12). A document's `$schema` key now survives validation.
- `StudioHandle`: `getTemplate`, `update` (one undo step, returns the validation report), `undo`,
  `redo`, `canUndo`, `canRedo`, `getSelection`, `select` and `fitView`.
- `SequenceStudio` takes a `ref`: `SequenceStudioHandle` with `getTemplate`, `update`, `undo`,
  `redo`, `canUndo`, `canRedo`.
- `registryValidateOptions(registry)` — the validation options a registry implies, for validating
  its documents outside the editor.
- `@mosphere/better-diagrams/server` — the AI route: `createDiagramRoute`, `serveAiRequest`
  (node:http), `createFetchHandler` (Fetch API: Next.js, Hono, Bun, Deno), `resolveProvider`,
  `createCompleter`, `RouteError`. `@anthropic-ai/sdk` and `openai` are optional peer
  dependencies; `complete` plugs in any other model call.
- The **Adjust with AI** chat, and wrapped cards that show all of their text.
- **Roadmaps**: Arrange → **By date** lays a plan out on a calendar — `"roadmap"` joins
  `ARRANGE_MODES`, and `settings.roadmap` (`RoadmapAxis`) stores the time axis. Tasks take a
  `startDate` and run as bars from it to their due date; dragging a card sideways reschedules it.
  `settleRoadmap`, `roadmapLayout`, `roadmapAxisOf` and `roadmapTicks` do the same outside the
  editor, and `autoLayout` dispatches to it.
- The `task-start-after-due` plan check, and a start date column in tracker CSV imports.
- `@mosphere/better-diagrams/disk` — the disk store behind live files: `createDiskStore` (lists,
  reads and writes diagram JSON, links folders and single files, saves wherever the person picks,
  tells the page about outside edits), `startStandalone` (the built editor and the store on
  127.0.0.1), `formatDiagram`, `plainJson`, `writeFileAtomic`, `isDiagram`. Prettier is an
  optional peer dependency.
- The `better-diagrams` command: `npx @mosphere/better-diagrams [file.json | folder]…` opens a
  repo's diagrams live, with no checkout of this repo; `--new` starts a file that isn't there.
- `onSaveFileAs` on both editors: **Save as…** in the file menu and on `⇧⌘S`. In the example app
  it writes the file wherever the system's save dialog says and keeps editing it there.
- `onNewFileOnDisk` on both editors and the welcome modal: **New file on disk…**, beside **Link a
  file on disk…**, for a file that isn't there yet. In the example app the system's save dialog
  names it and the dev server makes it blank, titled after its name, and links it; a name that is
  there already is linked as it is, never written over. The store's `POST symlinks` takes
  `create` (the diagram to make the file with) for it.
- `NODE_SHAPES` and `NodeShape` from `contract`; `ValidateOptions.kindShapes`, which
  `registryValidateOptions` now fills from the registry, so validation measures a wrapped card in
  its kind's shape. `wrappedNodeHeight` takes the `shape`; `wrapText` and `wrappedLineCount` take
  `breakWords`, which cuts a word too wide for the line as `overflow-wrap: anywhere` does.
- `hostHistory` (`HostHistory`) on both editors: a host that keeps the document's undo history
  itself (the VS Code extension: its text's) gets the toolbar's Undo and Redo and `⌘Z`, `⇧⌘Z`
  and `⌘Y`, so there is one history rather than two. The handle's `undo` and `redo` are unchanged.

### Changed

- The interactive HTML page docks the legend in the window's top-right corner, where it stays as
  the picture scrolls, and hides every line except the hovered box's and the structure (a line
  touching a group, or joining two boxes outside every group). Its ⋯ menu has **Show all lines**
  (off) and **Legend** (on). `buildTimelineHtml` and `buildMultiViewHtml` take this as
  `dockLegend` and `hoverLines`, over an SVG drawn with the new `viewerHooks` picture option.
- A new `value` from the host is an undo step instead of clearing the undo history; a change of
  `activeFileId` starts a fresh history.
- The build keeps one file per module, so hosts tree-shake what they don't use, and the HTML page
  builder and the JSON code editor (with CodeMirror) load on first use. As a result
  `BUILTIN_EXPORTERS.html.run` and `BUILTIN_SEQUENCE_EXPORTERS.html.run` return a Promise — which
  `ExporterDef.run` always allowed.
- `htmlExplorerData` moved module internally; it is still exported from the root entry.
- `engines.node` is now `>=22`.
- `tasksCsv` has a `start` column, before `due`.
- Live files on disk are written the way their repo writes JSON — by its own Prettier, with its
  config, `.editorconfig` and `.prettierignore`, where it has a Prettier config — and atomically,
  through a temporary file renamed over the old one.
- A linked folder lists its diagrams at any depth (by git's own idea of the project, in a work
  tree), and leaves JSON that isn't a diagram out of the listing, counting it instead.
- With `onLinkFile` set, the Import menu puts **Link a file on disk…** right after **Open file…**,
  whose hint says it reads a copy, and a diagram read in through Open file… says so in a note.
- `onOpenFile` on both editors runs **Open file…** through the host's own dialog. In the example
  app the dev server shows the system's dialog: a diagram `.json` picked there is linked, as Link a
  file on disk… links it, and anything else is read in as a copy. The store's `POST symlinks`
  takes `open` for it, answering `copy` with the file's text when it isn't a diagram, and its
  listing says `openPicker`; `BD_OPEN_PICKER` stands in for that dialog, and `none` turns a
  dialog off. The Import menu's four hints are shorter.
- The disk store no longer counts a React Flow export as a diagram: it is converted on import,
  never edited in place, so it is neither listed, linked nor written over.
- The inspector's pickers search: each opens with a search box at its top, and a key typed on a
  closed one opens it already filtered — every picker for a node, a line or a zone.
- A decision's and a milestone's text is centred unless the document says otherwise, so on those
  kinds `"textAlign": "center"` is the default validation drops and `"left"` is the value it keeps.
  Existing diamonds with no alignment set now draw centred.
- A wrapped diamond (a decision, a milestone) too small for its text grows in proportion, about
  its middle: `validateTemplate` scales its `w` and `h` together and moves its `x`/`y` so the
  centre stays, and an edit fits it both ways. Its text sits in the middle, in the column that
  needs the shortest diamond, widening when the diamond is taller than that. A document laid out
  for smaller diamonds may need **Arrange → Tidy** afterwards.
- A pipe's rounded ends stop at a 40px radius (and half its width), so a pipe grown tall keeps
  straight sides rather than becoming a capsule whose ends eat its text.

### Fixed

- Marketing cards keep their fills and icon strokes on a page that declares no `color-scheme` of
  its own. Built for browsers without `light-dark()` (Vite's lightningcss does this, for this
  package's stylesheet and most hosts'), those paints only switch under a literal `color-scheme`,
  which the root now declares from the theme, as `data-color-scheme`.
- The types compile under `@types/react` 19, and the suite passes on React 19; CI now runs both.
- Deleting a node also drops the per-view layout (`meta.views`) recorded for it.
- Exports that split a document into content and layout now keep custom annotation kinds' options.
- A diamond's label (a decision, a milestone) sits in its middle, on the canvas and in exports;
  centred text in one no longer drifts right in exports, and text in a pipe, diamond or
  parallelogram no longer runs into the shape's right side there.
- A wrapped decision, milestone or other shaped card draws its description over the shape on the
  canvas, not hidden behind it, and keeps all of its text inside the outline — on the canvas and
  in exports, which dropped the lines that didn't fit. Wrapped shapes were measured as plain cards.
- Exports: a wrapped card's date chip sits under the last line of its title rather than over the
  second, and a centred or right-aligned node's chip is centred or right-aligned, as on the canvas.
- An empty drilled-in level names the level it is ("at C2 · Containers"), as the breadcrumb bar
  does, instead of "its next C4 level".
- Live files: a file opened through a link answers to the file the link pointed at, so a link
  removed outside the app and remade under its name for another file never reads or writes that
  file as this one; linking the same file again asks before the edits made meanwhile meet it,
  rather than replacing them with the file's copy.
- Live files: a save that would drop something from the file — a key the editor doesn't know, a
  value outside its vocabulary — asks first, and nothing is written until it's answered.
- Live files: a watcher reporting a write made before it looked no longer replaces an edit made
  since; Save as… into a linked folder no longer reloads its own write over the next edit.

## 0.1.0-beta.0 — 2026-08-02

First public preview.
