# Changelog

All notable changes to `@mosphere/better-diagrams`. The public API is pinned in
`packages/better-diagrams/etc/*.api.md`; a change there is listed here.

## Unreleased

### Added

- An auto-placer and a layout linter. `autoPlace` lays a document out from its graph, choosing per
  connected piece between ranks, a tidy tree, rings around a hub, an organic mesh and a grid, by
  what measures best, in whatever shape that is. `polishLayout` keeps an arrangement and fixes what
  the linter finds; `arrangeBest` keeps an author's arrangement unless the auto-placer's is clearly
  better; `arrangeSelection` arranges part of a canvas; `straightenLines` runs a line dead straight;
  `layoutCandidates` gives the different arrangements a document could take. `lintLayout` scores the
  picture as drawn, with `LAYOUT_RULES` and `LAYOUT_LINT_RULES`. `buildScene` and `settleLines` are
  the parts underneath.
- `settings.arrange: "auto"`, and `settings.layout` (`LayoutPreferences`: `algorithm`, `direction`,
  `inner`, `shape`, `spacing`, `ends`, `rankGap`, `nodeGap`) for how it arranges. `edge.secondary` marks a
  line that shouldn't shape the layout. `EdgeAnchor.auto` marks a side the placer chose, which the
  next Tidy may change where a person's pin stays.
- The Layout panel, from Arrange: a score and what's behind it, Polish, Arrange selection, Straighten,
  the layout settings, and thumbnails of the other arrangements. Pointing at a finding picks it out on
  the canvas. Arrange also gains Polish, Arrange selection and Best fit. The edge inspector gains "Doesn't shape the layout".
- `bd-layout`, a command for the same: `lint`, `fix`, `place` and `best`.
- A **Model** picker in the AI panel, in both editors. `aiModels`, `aiModel` and `onAiModelChange` on
  `ArchitectureStudio` and `SequenceStudio` offer the choice, and it travels as `GenerateRequest.model`
  (`AiModelOption`). On the server, `AiRouteStatus.models` lists every model the environment's keys
  open up, a request can name one, and the route answers any other with a 400.
- How the interactive HTML page opens is the document's to say, like `settings.htmlLines`:
  `settings.htmlTimeline` (`HTML_TIMELINES`: the timeline bar shown or put away),
  `settings.htmlTimelineDate` (`HTML_TIMELINE_DATES`: open on today, the first date or the last),
  `settings.htmlLater` (`HTML_LATER`: what is dated later ghosted or hidden) and
  `settings.htmlLegend` (`HTML_LEGENDS`). The page builders take them as `hideTimeline`,
  `timelineDate`, `hideLater` and `hideLegend`. The reader can still change each from the page's
  ⋯ menu.
- Export → Interactive HTML → **Page settings…** sets all five in one dialog, one undo step. It
  replaces the menu's **Show all lines in the page** check.
- `ToolbarMenu`, the studio's own toolbar dropdown, for a host's menu in `toolbarExtras`: the
  same look and arrow keys as Insert, Arrange and Export. The VS Code extension's Settings menu
  is one.
- `SchemaCopyModal` takes `copy`, the host's clipboard, for a page whose own is blocked.

### Changed

- Tidy and the auto-tidy after a generation now use the auto-placer unless the document chose
  otherwise, so `autoLayout` with no mode means `"auto"`, not `"flow"`, and can move zones and grow a
  box that its words don't fit. A document with `settings.arrange: "flow"` or `"untangle"` arranges
  as it always did; pass `mode: "flow"` for the old default.
- The system prompt no longer asks for a left-to-right layout or 6-14 nodes per level. Placement is
  optional and free-form, and a diagram may be any shape and any size.
- A line ends on the outline of the shape it meets, not on the box around it: at a diamond's point,
  on a parallelogram's slanted side, around a pipe's rounded end and a cylinder's lid. On the canvas
  and in every export. `EdgePathSpec` gains `startShape` and `endShape`.
- A pinned line that leaves on one axis and arrives on the other draws one clean turn, rather than
  overshooting the far end's level and coming back to it. One that leaves and arrives on the same side
  no longer swings out further the longer it is.
- Lines landing on one table row sit side by side inside the row, rather than on a single point.
- Fit stops at 125%, so a few boxes aren't blown up to fill the window.
- Lines that meet one side of a box enter it side by side: their ends are bundled, arrowhead
  beside arrowhead a pixel apart, centred on the side and ordered by where each line comes from,
  on the canvas and in every export. The bundle stays put while the boxes at the lines' other
  ends are dragged; before, every line into a side landed on its middle, on top of the others,
  or slid along it as its box moved. `lineEndSlots` is the pass; `EndSlots` gains `startSide` and
  `endSide` for an end it places, and `withEndSlots` applies them.
- A text note's description is edited on the canvas too: double-clicking the note opens its
  sentence and, under it, its description, as one edit (Tab moves between them, Escape puts both
  back), with the caret at the end of the text. A note the text then runs past grows to hold it.
  The inspector's description field takes lines, and image exports draw every line of it rather
  than three.
- A node's `file:` link draws its ↗ in the interactive HTML page too, as the canvas does: it opens
  that diagram's own page, where exporting the two side by side puts it (`payments.json` →
  `payments.html`, a workspace's `Order flow` → `Order flow.html`), in the same tab.

### Fixed

- The interactive HTML page no longer carries a data profile's column `min` and `max`, or anything
  else a profiler wrote beyond the counts it shows (row count, null rate, distinct, orphan rate):
  those are values out of the data, and the page is a file that gets shared.

## 0.1.0 — 2026-11-01

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
- `settings.htmlLines` (`HTML_LINES`, `HtmlLines`): `"all"` opens the interactive HTML page with
  **Show all lines** on, for every export of that document; `"hover"`, the default, is never
  stored. The Export menu's **Show all lines in the page**, under Interactive HTML, sets it, and
  one undo takes it back. `buildTimelineHtml` and `buildMultiViewHtml` take it as `allLines`.

### Changed

- The interactive HTML page docks the legend in the window's top-right corner, where it stays as
  the picture scrolls, and hides every line except the hovered box's and the structure (a line
  touching a group, or joining two boxes outside every group). Its ⋯ menu has **Show all lines**
  (off) and **Legend** (on). `buildTimelineHtml` and `buildMultiViewHtml` take this as
  `dockLegend` and `hoverLines`, over an SVG drawn with the new `viewerHooks` picture option.
- The interactive HTML page shows a card's ↗ where the canvas does, as a link that opens in a new
  tab and does nothing else (no selection, no drill); a `file:` link, which names a diagram in the
  editor's workspace, is left out. A card or group with things inside wears the canvas's `⊞ N`,
  counted on the whole document, so a level shows what opens a level of its own. The picture
  options `links` and `drillCounts` draw them; PNG, SVG and PDF exports leave both out.
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
- An unpinned line runs straight wherever its two boxes' facing sides overlap: both ends sit in
  the middle of the overlap, where they used to sit at the middle of each side, so boxes that
  were only roughly level, or of different heights, drew a jog or an S. Its sides come from the
  gap between the boxes rather than the angle between their centres, so a line between two wide,
  slightly offset boxes no longer leaves one's side and doubles back across both. An unpinned end
  opposite a pinned one lines up with it. Lines between boxes whose middles already match are
  unchanged; other documents redraw, on screen and in exports.
- A connection drawn out of a box's dot, or dropped on one, keeps that side (`start`/`end`,
  side only) when it isn't the side the line would take anyway.
- Edge labels wrap to the room between the line's ends and stack upward above it, so a long
  label on a short arrow no longer runs over both boxes; on an up-and-down line the label,
  `[tech]` and date sit beside the line, the step badge on it. The same in every image export.
- Double-click on an empty box names it in place; a box with something inside still opens on
  double-click. An empty box's level is **Open its level** on its right-click menu.
- The node inspector has a **Colour** row for any box (the six line colours, a picker, *Auto*),
  where only groups had one. The icon picker shows each glyph, searches by what an icon stands
  for, and suggests icons from the box's name and description.

### Fixed

- Marketing cards keep their fills and icon strokes on a page that declares no `color-scheme` of
  its own. Built for browsers without `light-dark()` (Vite's lightningcss does this, for this
  package's stylesheet and most hosts'), those paints only switch under a literal `color-scheme`,
  which the root now declares from the theme, as `data-color-scheme`.
- `better-diagrams file.json --no-open` printed the editor's bare address, which opens on its
  starter diagram; it prints the link that opens the file, the one a browser would be sent to.
- The types compile under `@types/react` 19, and the suite passes on React 19; CI now runs both.
- Deleting a node also drops the per-view layout (`meta.views`) recorded for it.
- Exports that split a document into content and layout now keep custom annotation kinds' options.
- Exports in marketing mode: a team pill holds its whole name; the bold text ran past the pill's end.
- Exports lay out a card's top row as the canvas does — kind and status, then the pills, in that
  order, centred or right-aligned as one row. A right-aligned task listed its pills before its
  kind, a centred one centred only the kind, a marketing task's pills overlapped its status or
  estimate, and a centred or right-aligned deprecated card dropped the word "deprecated".
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
