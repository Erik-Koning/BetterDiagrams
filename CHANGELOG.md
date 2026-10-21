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

### Fixed

- The types compile under `@types/react` 19, and the suite passes on React 19; CI now runs both.
- Deleting a node also drops the per-view layout (`meta.views`) recorded for it.
- Exports that split a document into content and layout now keep custom annotation kinds' options.

## 0.1.0-beta.0 — 2026-08-02

First public preview.
