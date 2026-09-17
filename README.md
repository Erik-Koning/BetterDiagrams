# BetterDiagrams

Embeddable React diagram editors — **architecture** diagrams (nodes, groups, infra zones with
provider switching) and **sequence** diagrams (participants, messages, activation bars,
combined fragments). An LLM authors a JSON document, React Flow renders it, a human drags it
into shape, and the edits save back to the same JSON.

```bash
npm install @mosphere/better-diagrams
```

```
packages/better-diagrams/
  src/contract/    zero-dependency: the document, validation, prompt, layout, clipboard
  src/react/       the editor component, registry, exporters
example/           a small React JS app that integrates it
legacy/            the original single-file prototype, superseded
```

The package is two halves. `contract/` has **no dependencies at all** — no React, no
@xyflow/react, no DOM — so it runs in a backend, a Lambda, or an LLM pipeline:

```js
import { validateTemplate, buildSystemPrompt, autoLayout } from "@mosphere/better-diagrams/contract";
```

That's about 47 kB gzipped versus about 165 kB for the full editor, and the separation is
enforced by a test that walks the import graph rather than trusted to a comment.

## Quick start

```bash
npm install
npm run dev        # example app on http://localhost:5173
npm test           # 332 tests
npm run test:e2e   # Playwright, end to end through the example app (see e2e/)
npm run build      # builds the library to packages/better-diagrams/dist
```

The end-to-end suite starts its own dev server on :5174 and drives the example in
Chromium — first run `npx playwright install chromium`. It never writes to
`/templates`: the auto-save route is blocked for the duration of a test.

The example runs fully offline. AI generation is optional and needs a second terminal:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run server -w example        # proxy on :8787, Vite forwards /api to it
```

## Using it

```jsx
import { ArchitectureStudio } from "@mosphere/better-diagrams";
import "@mosphere/better-diagrams/styles.css";

<ArchitectureStudio
  value={template}          // controlled; or defaultValue for uncontrolled
  onChange={setTemplate}    // fires on every committed edit
  onSave={persistToDb}      // adds a Save button (⌘S)
/>
```

The component **fills its parent box**. Give it a sized container — it never assumes the viewport,
so it embeds in a panel, a modal, or a split view without fighting your layout. In a narrow box
the toolbar wraps to more rows rather than clipping its last buttons, and its type scale is in
`rem`, so a reader who has raised their browser font size gets a bigger editor rather than a
bigger page around the same 8px labels. Keyboard focus is visible on every control, and a
`forced-colors` block restates the states that are otherwise carried only by a background or a
shadow.

### Props

| Prop | Type | Notes |
|---|---|---|
| `value` | `DiagramTemplate` | Controlled document. Pair with `onChange`. |
| `defaultValue` | `DiagramTemplate` | Initial document when uncontrolled. |
| `onChange` | `(t) => void` | Every committed edit, already validated. Typing in an inspector field fires per keystroke, so a host that persists on every call should debounce; the UNDO stack does not — a run of typing in one field is one entry. |
| `onSave` | `(t) => void \| Promise` | Shows a Save button; `⌘S` also triggers it, from inside a text field too, and never twice at once. The button reads `Save •` while the document differs from what was last saved. A rejected promise is surfaced to the user rather than swallowed. |
| `readOnly` | `boolean` | Hides editing affordances; pan/zoom/export still work. |
| `registry` | `RegistryExtensions` | Add node kinds, icons, exporters. See below. |
| `theme` | `Theme` | Overrides `--as-*` design tokens. `LIGHT_THEME` / `DARK_THEME` are complete presets — `theme={LIGHT_THEME}` flips the whole editor **and** its image exports (the export palette derives from the theme). |
| `mode` | `"technical" \| "marketing"` | Presentation mode. Default `"technical"`. `"marketing"` restyles the same document for a slide or a landing page — see **Marketing mode** below. Both editors take it; unknown values fall back to technical. |
| `generate` | `DiagramGenerator` | Enables the AI panel. Omitted ⇒ no network code runs. |
| `minimap` | `boolean` | Default `true`. |
| `welcome` | `boolean` | Default `true`. Shows the **welcome modal** over a brand-new document — see below. |
| `legend` | `boolean` | Show the corner legend: the infra key when zones exist, and the key to the lit paths. Defaults to `true`. |
| `defaultShowHidden` | `boolean` | Start with provider-hidden nodes ghosted rather than omitted. Default `false`. |
| `diffBase` | `DiagramTemplate` | Baseline to compare against: the canvas becomes a read-only diff view (added/removed/changed) while set. The toolbar's Compare button offers the same via a file picker. |
| `filename` | `string` | Base name for exports. Default `"architecture"`. |
| `files` / `activeFileId` / `onFileSelect` / `onFileCreate` / `onFileRename` / `onFileDelete` | `StudioFile[]`, callbacks | When `files` is provided the brand becomes a **file selector** (switch, new, rename, delete). The host owns all storage — the editor only calls back. Both editors take these. **The file name and the document's `meta.title` are one title with two homes**: renaming the active file writes `meta.title` (committed, emitted, undoable), and a document title arriving any other way — AI generation, import, a controlled `value` — is pushed back out through `onFileRename`, so the dropdown always shows what exports will print. The sync is a reconciler, not two blind pushes: on a mismatch, *which side moved since they last agreed* decides — a title edit (including undo) renames the file, while a **host-side rename** (another tab, the host's own UI, a changed `files` prop) is adopted as the document's new title rather than being reverted; when both moved at once, the document wins. The editor can only do this for the document it holds; a host that stores the other documents should mirror renames into them too (the example app does). Set `StudioFile.empty` and a blank file deletes straight away; anything else asks for confirmation first. `onFileCreate` receives an optional `StudioFileInit` (`{ name?, kind?, doc? }`): the menu's New file row passes nothing, the welcome modal passes a name and — when JSON was inserted — a validated document to seed the file with. |
| `removedFiles` / `onFileRestore` | `StudioFile[]`, `(id) => void` | Deleted documents the host still holds. The menu grows a **Recently removed…** entry opening a recovery modal. |
| `onNavigateFile` | `(ref) => void` | Fired when a node url with the `file:` prefix (e.g. `file:Order flow`) has its ↗ clicked — resolve by id, then name, and switch documents. |
| `onSelectionChange` | `(sel) => void` | The canvas selection in **document terms** — ids bucketed by template section (`{ nodes, edges, zones }` here; `{ participants, messages, activations, fragments, notes }` on the sequence editor), so a host can mirror it, e.g. highlight the matching entries of a live JSON view (the example app does exactly this). Fires on mount too, so a host that remounts per file never keeps a stale selection. |
| `onPinsChange` | `(pins: Pin[]) => void` | The **pins** — a field (`{ nodeId, fieldId }`) or a whole table (`{ nodeId }`) — mirrored like the two above: fires on mount (empty) and on every change. View state — never in the document; a pin is dropped when its node leaves the document. See **Fields beyond the rows** below. |
| `onCoverageChange` | `(keys: FieldRef[]) => void` | The keys the **Key coverage** panel is scoring, mirrored like the pins. View state; pruned when a key's table leaves the document. |
| `onFocusChange` / `onActivePathsChange` | `(ids: string[]) => void` | The two pieces of **view state** the editor keeps outside the document, mirrored to the host: the drill-in stack (root first, `[]` at the top) and the ids of the lit paths. Both fire on mount and on every change, keyed by content, so a host can render its own breadcrumbs or path list. Neither is content — a drill never enters undo or `onChange`. |
| `ref` | `Ref<StudioHandle>` | Imperative access to the same view state: `getFocus()`, `drillTo(stack)`, `navigateTo(nodeId)`, `getActivePaths()`, `setActivePaths(ids)`. `drillTo` fits the view to the new level; the deepest id the document knows names the level and its real ancestry becomes the stack; `navigateTo` drills to whichever level shows a node, then selects and centres it. Fields: `getPins()`, `setPins(refs)` (a pin is `{ nodeId, fieldId? }` — a whole table when `fieldId` is absent), `navigateToField(ref)` (drill, select, mark the row), `openFieldGrid(nodeId, fieldId?)`, and for the coverage panel `getCoverageKeys()`, `setCoverageKeys(refs)`, `openCoverage()`. The slot context (`toolbarExtras` / `inspectorExtras`) carries the same reads and writes as `focus`, `drillTo`, `activePaths`, `setActivePaths`, `pins`, `setPins`. |
| `toolbarExtras` / `inspectorExtras` | `ReactNode \| (ctx) => ReactNode` | Slots for your own controls. |

### Marketing mode

```jsx
<ArchitectureStudio value={template} mode="marketing" />
```

The default, **technical**, is the dense, exact rendering: every kind eyebrow, column type and
technology label on screen, 8px corners, flat surfaces. **Marketing** dresses the *same document*
for a slide, a pitch deck or a landing page. Nothing in the document, the registry, the tools, the
exports or the keyboard changes — only the stylesheet's reading of it:

- **Bigger, rounder, softer.** Icon glyphs go from 17px to 22px in a 36px chip, titles and
  labels step up a size and switch to the UI sans, corners are 12px, and every card gets a quiet
  gradient derived from its kind's accent — so a database warms differently from a queue, and a
  node's own `color` or a host's custom kind gets a gradient of its own for free — under a soft
  accent-tinted shadow. Silhouette shapes (person, cylinder, pipe) get the same gradient as an
  SVG def.
- **Redundant labels tucked away.** A card's kind eyebrow when the icon has already said it (a
  status or a drill badge keeps the row), a column's type and required mark, an edge's
  technology sub-label, a sequence message's tech. They are all still in the document, the
  inspector, and every document export — only the picture stops printing them.
- **More air.** Every layout the editor performs spreads ranks and rank-mates wider — Tidy,
  the AI layout, and a never-placed document arriving by paste, Import, `value`, or as a compare
  baseline (`modeLayoutOptions` exposes the gaps if you run `autoLayout` yourself).

It composes with `theme`: `mode="marketing" theme={LIGHT_THEME}` is the light marketing look, and
the two schemes are *not* the same card at two brightnesses. Over the dark canvas a card is
already the bright object in the frame and its own glow does the lifting; on a white page nothing
is brighter than the paper, so the card earns its edge instead — more of its kind's hue, a firmer
border, a shadow you can actually see, and an icon chip that **inverts**: a pale tile carrying a
near-saturated glyph, rather than a pool of the kind's colour that would only wash an
already-tinted card twice. The stylesheet does this with `light-dark()`, which reads the
`colorScheme` token — `LIGHT_THEME` sets it; a partial theme that omits it is read as dark, exactly
as the browser already reads it for its own widgets.

The root element carries `as-root--marketing` and `data-mode`, so a host stylesheet can reach in;
technical adds no class at all, so existing host CSS keeps matching exactly what it matched before.
Titles that are set to wrap keep their technical font size and chip width, because the stored
height was measured with those, and a sequence participant's name stops one step short of a card
title's for the same reason — its header is a fixed lane box.

**Exports follow the mode.** PNG, PDF, SVG and the interactive HTML all render the dress the screen
is wearing, gradients, shadows, tucked-away labels and all — see **Exports** below.

### Starting from blank — the welcome modal

A brand-new document (no nodes, edges, or zones; no participants or messages on the sequence
editor) — or a workspace with zero files — greets with a centred, branded modal offering three
ways in:

- **Insert Node Manually** — dismisses the modal to build on the canvas (in an empty workspace
  it first calls `onFileCreate({ name })` so there is a file to land in).
- **Copy Schema & System Prompt** — puts the registry-aware system prompt on the clipboard, so
  an external LLM can author the document.
- **Paste JSON** — a CodeMirror editor with line numbers, folding, and live JSON linting.
  Anything `Import` accepts works here too: a template, a raw React Flow export, or fenced LLM
  output. A name field sets the file's title on insert. Everything the validator repairs
  *silently* gets a **yellow warning** stating the real consequence — never an error, Insert
  always proceeds: unknown keys ("ignored"), unknown enum values (`"kind": "spaceship"` →
  "inserted as \"service\"" — registry-aware, so custom kinds lint clean), dangling references
  (`"target"` to a missing node → "the whole edge will be dropped"), a zone `provider` outside
  its own `providers` list, and dates `normalizeDate` can't read. Near misses get a
  "did you mean". The known-key lists live beside the schema interfaces (`TEMPLATE_KEYS`,
  `NODE_KEYS`, …), where `Record<keyof T, true>` maps make the compiler keep them in sync with
  the types. A paste with no coordinates (every node at the origin) is **auto-laid-out** on
  insert instead of stacking at (0,0); any explicitly placed node disables that.

Escape and a backdrop click behave like the manual CTA — the modal never traps. It reappears
for each new blank file, closes itself the moment the document gains content, and is suppressed
by `readOnly`, `diffBase`, or `welcome={false}`.

The editor is powered by `@codemirror/*` packages, which are declared dependencies but
**externalized** from the bundle (like `@xyflow/react`), so a host that already ships CodeMirror
keeps a single copy of `@codemirror/state`.

### Cloud provider packs

A curated set of components per big cloud ships as first-class node kinds — AWS (`aws-lambda`,
`aws-s3`, `aws-dynamodb`, `aws-bedrock`, …), Azure (`azure-functions`, `azure-app-service`, `azure-cosmos`,
`azure-openai`, …), GCP (`gcp-cloud-run`, `gcp-pubsub`, `gcp-bigquery`, `gcp-vertex-ai`, …) —
each styled in its provider's brand palette with a silhouette by role (databases are cylinders,
queues are pipes) and an icon chosen per service where the role is too coarse: a virtual machine
is a `server`, a serverless container is a `box`, a function is a `bolt`, and a managed
Kubernetes cluster is a `grid`, so Compute Engine, Cloud Run, Cloud Functions and GKE read
apart at a glance, and EC2, Azure VM and Compute Engine read alike across clouds.

- **Always valid data**: cloud kinds are registered built-ins, so pasting, validation, and the
  schema lint accept them in any document. Relevance only shapes the UI.
- **Relevance-aware kind picker**: the node inspector's type dropdown lists core kinds, then
  the clouds the document actually references — via zone/node/edge `providers`, or simply by
  **using any of that cloud's kinds** (one `aws-lambda` node makes the whole AWS pack
  first-class). Every other cloud's components sit in a grayed, darkened **Other clouds**
  section at the bottom, still selectable.
- **Adaptive prompts**: both copy surfaces ask which clouds — and which of their services —
  the schema should teach, and copy exactly that. The welcome modal grows an AWS/Azure/GCP
  multi-select under the title; ticking a cloud reveals its resource checklist (with
  **All / In this diagram / None** presets), and **Copy Schema & System Prompt** appends only
  the ticked components' sections after the base prompt. The AI panel's own prompt adapts
  automatically to the providers the document references.
- **No cloud by default**: nothing selected ⇒ the base prompt — no cloud ids in the kind enum,
  no component sections, and no provider standing in as the zone example (the skeleton shows
  the `providers` enum instead). That is the correct output when the user hasn't said which
  cloud they are on yet; they name it in their own prompt. The same rule runs deeper: a zone
  saved with no provider resolves to `onprem`, not to a cloud, so silence can't quietly make a
  document "reference" a cloud nobody chose.
- Registry extensions treat cloud kinds like any builtin: override with a partial def, remove
  with `null`. An extension kind tagged `provider: "aws"` is offered and advertised exactly
  when AWS is.

```jsx
// Copying the schema from an OPEN document: ask first, seeded with the
// document's own clouds. `templatePromptContext` derives everything the
// dialog needs from the doc + registry.
import { SchemaCopyModal, templatePromptContext } from "@mosphere/better-diagrams";

const ctx = templatePromptContext(doc, registry);
<SchemaCopyModal
  clouds={ctx.cloudOptions}
  resources={ctx.cloudResources}
  initialClouds={ctx.referencedClouds}   // ticked at open
  usedResources={ctx.usedResources}      // the "In this diagram" preset
  buildPrompt={(scope, { geometry }) =>
    ctx.promptForClouds(scope.clouds, { components: scope.components, geometry })
  }
  onClose={() => setOpen(false)}
/>
```

## The schema is the contract

`contract/schema.ts` is the single source of truth for the vocabulary, the validator, **and the
LLM system prompt** — the prompt is generated from the same constants the validator checks
against, so they cannot drift apart.

```ts
import { buildSystemPrompt, validateTemplate, parseLlmTemplate } from "@mosphere/better-diagrams";
```

`validateTemplate` never throws on recoverable input — an unknown kind becomes `service`, a
duplicate id gets suffixed, an edge to a missing node is dropped, and **parent cycles are broken**
so every consumer can assume the parent graph is a forest. It throws only when there is no
`nodes` array at all.

"Repair rather than reject" is meant literally, and the awkward cases are the ones that matter:
a numeric `"id": 1` is coerced, not dropped (dropping the node would take its edges and its
children's parent links with it); a duplicate id is suffixed without ever *stealing* an id a
later element already claimed; `"providers": "aws"` is repaired into a one-element list rather
than discarded, because discarding it INVERTS the meaning and makes an AWS-only node visible
everywhere. Two things are refused outright, because keeping them would be worse than losing
them: a `url` whose scheme executes when clicked (`javascript:`, `data:` — only `http(s):`,
`mailto:`, `tel:`, `ftp:`, relative links and the internal `file:` form survive), and a date
that isn't one. Rows are never truncated: a load/save round-trip that quietly deleted a real
table's columns would be data loss with no error and no undo.

`parseLlmTemplateReport` (and `parseLlmSequenceReport`) return the healer's notes alongside the
document. The one a caller must not swallow is `truncated`: a reply cut off by `max_tokens`
parses cleanly once its brackets are closed, so the elements that never arrived are
indistinguishable from elements the model chose to delete — and a refine merges that as a
deletion. The editor says so rather than applying it silently.

The export surface is curated. Everything importable from the root entry or
`@mosphere/better-diagrams/contract` — the components, schema types, validators, migrations,
prompts, adapters, layout, lint, diff, clipboard, and timeline — is a deliberate API we intend
to keep stable. Layout maths, pixel constants, and id plumbing are intentionally unexported;
if you need one of them, open an issue rather than vendoring the source.

Text notes render **boxed by default** — a subtle outline and background, on screen and in image
exports. Set `plain: true` (or untick **Outline** in the inspector) for bare text. Like every
default, it is stored only when it differs, so pre-existing documents round-trip byte-identical.
A note's `description` renders as a dim sub-line under its sentence (canvas and image exports
alike), sized against the note's own `fontSize`; the sentence itself is the `label`, edited by
double-clicking the note.

Every node and edge may carry a **`data` bag** — `data?: Record<string, unknown>` — for whatever
the host knows that the diagram doesn't: the record a node was generated from, an external id,
a foreign key's delete rule, the metadata a custom inspector shows. It is the one lenient field
on an otherwise strict element: any plain object is kept as-is (a shallow copy) and round-trips
untouched through validation, the canvas, the clipboard and every exporter, the way `meta` does
for the document; an array, a string or an empty object is dropped so the key is present exactly
when it carries something. Nothing in the editor reads it. `DiagramNodeData.data` /
`DiagramEdgeData.data` carry it on the React Flow side, so a custom node component can show it.

### Paths: named flows the reader can light up

A document may name **paths** — ordered walks through the diagram, each with a title — and the
toolbar's **Paths** menu lists them. Tick one and every node and arrow on it glows in that
path's colour; tick several and each keeps its own colour, with a key in the corner legend. The
glow pulses, and the bright spot travels the walk from its first step to its last while each
arrow's dashes run the way the walk takes it — against the arrowhead when the flow goes back up
an edge. Which paths are lit is view state, like the tag filter: it never enters the document.

```json
{
  "paths": [
    { "id": "checkout", "title": "Checkout charge", "steps": ["cdn", "api", "pay"] },
    { "id": "jobs", "title": "Background job", "steps": ["api", "z6", "q", "z7", "wrk"], "color": "violet" }
  ]
}
```

`steps` is one ordered list of ids. Node ids are the normal currency: the edge between two
consecutive nodes is inferred when exactly one joins them (and walked backwards when it points
the other way). Put an edge id between two nodes only when several edges join them; an edge
named on its own brings its endpoints with it. `color` is optional and comes from the edge
palette — unset paths take the next colour in a fixed cycle, by their position among *all* the
document's paths, so lighting a second path never recolours the first. `resolvePath(doc, path)`
exposes the expanded walk. A step naming nothing in the document is dropped on validation, and
so is a path left with no steps; deleting a node removes it from every path it was on.

The glow is themed: `LIGHT_THEME` ships a tighter, denser halo (`glowAlpha`, `glowBlur`) than the
dark default, because a glow on white has nothing to bloom into, and the hue itself follows the
theme's `edgeColors`. Under `prefers-reduced-motion` the halo stays and nothing travels. The
**Interactive HTML** export carries the paths too: its ⋯ menu lists them, lighting one adds the
same glow and dash flow to the exported SVG, with a key over the stage.

### Finding paths: graph search

`paths.ts` resolves a walk someone has written down; `contract/graph.ts` **finds** one. Every
search reads the structural slice a `DiagramTemplate` already satisfies (`{ nodes, edges }`), so a
scoped view document serves too, and returns `GraphWalk`s — `{ nodes, edges }` interleaved, so
`nodes[i]` is joined to `nodes[i + 1]` by `edges[i]`.

```ts
import {
  shortestPath, shortestPaths, allSimplePaths, neighbourhood, walkToPath,
} from "@mosphere/better-diagrams/contract";

shortestPath(doc, "cdn", "db");                       // fewest hops (BFS), or null
shortestPaths(doc, "cdn", "db", 3);                   // the 3 best simple routes (Yen's), shortest first
allSimplePaths(doc, "cdn", "db", { maxDepth: 5, limit: 50 });
neighbourhood(doc, "orders", 2);                      // { nodes: Map<id, hops>, edges } within two hops
neighbourhood(doc, ["orders", "users"], 1, { undirected: true });

// Light a found route: make it a document path, then tick it.
const walk = shortestPath(doc, "cdn", "db")!;
const path = walkToPath(doc, walk, { id: "cdn-to-db", title: "CDN → DB", color: "rose" });
setTemplate({ ...doc, paths: [...(doc.paths ?? []), path] });
studioRef.current?.setActivePaths([path.id]);
```

Direction is honoured by default — an edge is walked source → target, except one whose
`direction` is `both` or `none`, which reads as a two-way link; `{ undirected: true }` ignores
arrows. `edgeFilter` and `nodeFilter` narrow the graph (the endpoints of a search are always
allowed). Parallel edges are distinct routes; self-loops are never walked. Ties break by document
order, so a result is stable across runs. `walkToPath` writes the shortest `steps` that
`resolvePath` expands back to exactly that walk — an edge id only where the pair is joined by
more than one.

#### Between fields

The same searches run **field to field**: a route leaves the first table through an edge anchored
at the pinned field (`startField`/`endField`, or the dialect's own record of the field when the
row isn't drawn — `edgeFieldIds` in `contract/fields.ts` is the one definition of "anchored") and
arrives on an edge anchored at the other.

```ts
import { fieldPaths, between, reachableFrom } from "@mosphere/better-diagrams/contract";

fieldPaths(doc, { nodeId: "contact", fieldId: "AccountId" }, { nodeId: "account", fieldId: "Id" }, { undirected: true });
// → { walks, constrained: { from, to }, truncated }     k = 10 routes, maxDepth = 10
between(doc, a, b, { undirected: true });
// → { onRoutes, corridor, routes, truncated }           two tiers, see below
reachableFrom(doc, [a, b, c]);
// → { nodes: Map<id, hops>, edges, constrained }        linear, no bound needed
```

`keyFrequency(doc, a, b)` shares one bounded enumeration with `between` and says, per key (a
referencing field, see `keyFields`), how many of the routes travel it — the "keys most routes use"
list. `keyCoverage(doc, keys, { scope })`, `marginalGains(doc, chosen)` and
`minimalKeyCover(doc, { scope, budgetMs, exactUpTo })` in `contract/coverage.ts` are what the
coverage panel draws: what a set of keys reaches, what each other key would add, and the fewest
keys that reach everything (`optimal` only when the exact pass finished).

Every result says when it was **cut short** (`truncated`) and whether an end was **held to its
field** (`constrained`) or fell back to the table because the field anchors nothing on this
document. `between` answers "which tables sit between these two fields" in two tiers, because
enumerating simple routes is exponential: `onRoutes` is exact under the bounds (on at least one
enumerated simple route — `maxDepth` 8, 20 000 expansions, 300 ms, an injectable clock), and
`corridor` is the cheap superset (within `maxDepth` of both ends by shortest distance, two
breadth-first searches) the panel can always show. A field that is two tables away in both
directions but a dead end sits in the corridor and on no route; the panel labels the two.

### Settings: how the whole document is shown

A root-level `settings` object holds rendering preferences that apply document-wide — how the
diagram is *shown*, never what it says. Unlike `meta`, it is strict: only the keys the schema
defines survive validation (the JSON editor lints the rest), and an object left saying nothing
is omitted, so a document that never set one round-trips byte-identical.

```json
{
  "settings": { "groupContents": "hide" }
}
```

`groupContents` decides what groups do with what they contain. `"show"` — the default, never
stored — is the canvas you know: every group is an open frame, or a chip when its own
`collapsed` flag says so. `"hide"` **folds every group that has contents** into a chip, whatever
its own flag says: contents leave the canvas, their edges re-route to the chip, and the stored
frame size survives — the same mechanics as collapsing one group by hand, applied to all of
them at once. An empty frame hides nothing, so it stays open. Image exports and the export crop
follow the fold; the whole-document exports (Template, React Flow) do not, and neither does a
Compare overlay — a diff shows the architecture inside every group.

The toolbar gets a **Fold groups** toggle whenever the document says something here and some
group has contents to fold — a diagram that never set `groupContents` keeps the toolbar it always
had. Pressed means folded; pressing it writes `"show"` (so the switch stays, and there is a way
back), and the flip is a document edit like any other: committed, undoable, emitted through
`onChange`. A **read-only** viewer gets the same toggle as a view-only override — it changes
what they see, never the document, and is dropped the moment editing is re-enabled. Under a fold
each chip loses its own ▸ expand toggle — flipping one group's flag underneath the document's
fold would change nothing on screen — and the groups' own `collapsed` flags are never written,
so unfolding reopens exactly what was open before.

**The fold never eats an edit.** Under `"hide"`, an edit that gives a group contents — a card
dropped into a frame, a selection wrapped in a group with `⌘G` — would fold that group at once
and take the very cards you just placed off the canvas. Instead the document flips to `"show"`
in the same undo entry (the toast says so), and **Fold groups** folds everything again when you
are done. Edits that arrive as whole documents — import, paste, an AI reply — fold as authored.
The setting is opt-in for the model too: the system prompt teaches it, but only for a request
that asks for folded groups or a summary view.

## Node text: alignment and wrapping

A node's label is one ellipsised line, left-aligned and vertically centred, unless you say
otherwise. Four optional fields change that, in the **Text** section of the inspector or
directly in the document:

```jsonc
{ "id": "api", "label": "Payment Reconciliation Worker",
  "textAlign": "center",     // left (default) · center · right
  "textVAlign": "middle",    // top · middle (default) · bottom
  "wrap": true,              // break across lines instead of ellipsising
  "fontSize": 16 }           // default 13
```

**`wrap` grows the node.** Nothing is ever clipped: `validateTemplate` measures the wrapped label
and raises the stored `h` to hold every line, the same way a table node already grows to fit its
rows. Width stays exactly as authored. The measurement lives in `contract/text.ts`, and
validation, the canvas and the PNG/SVG exporters all call it — which is the only reason an export
can be trusted to look like the screen. A record node is excluded from vertical alignment: its
rows sit at offsets that field-anchored edges also compute, so moving them would leave
foreign-key lines pointing between columns.

Every value above is stored **only when it differs from the default**, so a document written
before these existed round-trips byte-identical.

## Transparent containers: boxes in boxes

Nesting is `parentId`, and any node can parent any other, to any depth — a `group` renders its
children inline inside its frame, and dropping a node on a group nests it while dragging it out
un-nests it. What a group looks like is now separately controllable, using the same four knobs a
zone has:

```jsonc
{ "id": "ctx", "label": "Bounded context", "kind": "group",
  "fill": false,        // drop the background tint     (default true)
  "outline": "none",    // solid · dashed (default) · dotted · none
  "color": "#8b5cf6",   // frame ink; the tint derives from it
  "opacity": 0.28 }     // tint strength
```

`color` is **not** container-only: on any other kind it overrides that kind's registry accent,
which is what `"color": "#ff0000"` on a service can only mean. `fill`, `outline` and `opacity`
stay frame concepts — a leaf draws its own silhouette — and the JSON editor's lint says so
rather than letting them vanish on save.

`fill: false` + `outline: "none"` is a **fully invisible grouping frame** — nothing renders on
screen or in exports except its name chip, but it still nests, still accepts drops, still
collapses to a chip, and still drills in. Selecting it restores a visible border so you can tell
you have hold of it. `⌘G` wraps the current selection in a new container and `⌘⇧G` unwraps one,
converting between absolute and parent-relative coordinates in the same pass.

Note the deliberate split: **groups nest, zones don't.** (And only groups can be nested a level
deeper — see below; a zone is a backdrop, not a box with insides.) A zone is a shaped infra *background*
that nodes reference by `zoneId` (so a node can be in one zone and one group at once); zones
resolve overlap by `z`, not by containment. If you want boxes inside boxes, they are groups.

## Drill-down: C1–C4 levels in one document

A node's children (`parentId`) are its next C4 level — any kind can have them, not just
groups. A `group` still renders its children inline inside its frame; a **card of any other
kind keeps its normal look** and its children live behind it, visible only by drilling in.
Double-click a node (or its `⊞ n` badge) to slide into its level: the focused node becomes an
open boundary frame, its direct children render at their stored coordinates, and everything
they talk to outside appears as dashed **ghost** stand-ins — double-click a ghost to visit the
real thing. Breadcrumbs, a `C2 · Containers`-style level pill, and `Esc` step you back out.

Levels are **views, never copies**: every derivation comes from `scopedView(template, focusId)`
and every edit inside a level writes straight back to the one document (a child's stored
parent-relative x/y *are* its coordinates in the focused view). Cross-level consistency is
derived rather than maintained — an edge from a grandchild to an outsider automatically appears
on every level between them, rerouted to whatever box represents each end. Deleting a ghost is
refused (it lives on another level); dragging one to tidy a view is saved per-view under
`meta.views` and never counts as an architecture change in `diffTemplates`.

**Moving between the two shapes.** A group draws its children on this level; any other kind's
children are a level down. Those are the same relationship rendered two ways, so the editor
converts between them: with a container selected, *Arrange ▸ Nest contents a level deeper* (or
the inspector's **Nest…**) turns the frame into one card and pushes everything inside it to its
own C4 level, and *Show contents inline* brings them back. A confirmation dialog says how many
nodes move and lets you pick what the frame becomes — `service` by default, C4's "container".

No edge is rewritten by either direction: cross-level connections are derived, so arrows that
pointed into the contents simply land on the card, and the internal wiring reappears when you
drill in. That is also why it is exactly one undo. As transforms:

```ts
import { nestContents, inlineContents } from "@mosphere/better-diagrams";

nestContents(template, "vpc", { kind: "azure-app-service" });  // frame → card, contents a level down
inlineContents(template, "vpc");                               // card → frame, contents back inline
```

A stand-in for hidden contents keeps its words when it stands for exactly ONE edge, and goes
blank only when it is summarising several — the same rule at every level, and in exports.

The AI knows the convention but is told to keep levels flat unless you ask: refine while
drilled in and the request is scoped to that component ("split the parser" decomposes the
focused card, everything outside is untouched). The **Interactive HTML export** pre-renders
every level into one self-contained page — click boxes to drill, breadcrumbs and `Esc` to come
back, deep-linkable via `#/pay/workers`, with the timeline scrubber acting on every level at
once. Flat documents keep the exact single-view page they always had. Mermaid / C4-PlantUML /
sequence derivations project drill detail onto its card, so flat formats stay flat.

```ts
import { scopedView, liftScopedReactFlow, drillableIds, focusPath } from "@mosphere/better-diagrams";

const level = scopedView(template, "payments");   // an ordinary DiagramTemplate — render it anywhere
drillableIds(template);                            // every node with internal detail
focusPath(template, "retry-worker");               // ["payments", "workers"] — the stack that shows it
```

A host drives the drill the same way the reader does, through the component's `ref`
(`StudioHandle`): `drillTo(["payments", "workers"])` lands on a level and fits to it,
`navigateTo("retry-worker")` goes to whichever level shows a node and selects it, and
`onFocusChange` reports every move — so an explorer can put its own tree or breadcrumbs beside
the canvas and keep the two in step.

## Folder format: a directory tree in, a document out

A diagram can also live as a **folder tree** — one folder per node, nesting to any depth, with
per-folder files carrying the node's content. `contract/folder` converts both ways, with a
pluggable **dialect** deciding what the files mean:

- **`generic`** — `node.json` / `edges.json` per folder plus a `.better-diagrams/manifest.json`.
  What the **Folder (.zip)** export writes, and what any bare directory tree reads as (a folder
  with children is a group, a leaf is a box, named after the folder).
- **`salesforce-datamodel`** — the tree a Salesforce org exporter writes: bands and groups as
  folders, an object per folder with `schema.json` (fields, foreign keys), `object.yaml` (a flat
  summary, read only as a fallback), optional `forensics.json`; views aliasing an object; record
  types beneath it; a root `relationships.json` naming the business edges.

```ts
import { importFolder, exportFolder, salesforceRegistry } from "@mosphere/better-diagrams/contract";
import { readFolderToFileMap, writeFileMap } from "@mosphere/better-diagrams/contract/folder/node";

const files = await readFolderToFileMap("./data-model");        // path → text; a browser builds one from a dropped directory
const { template, dialect, warnings, stats, registry } = importFolder(files, {
  fields: "keys",          // "keys" (id, name, references, external ids) | "visible" | "all" | predicate
  edges: "business",       // hide audit FKs (OwnerId, CreatedById…) | "all"
  polymorphic: "collapse", // one point node per polymorphic FK | "in-model" (fan out, capped) | "none"
});
<ArchitectureStudio defaultValue={template} registry={salesforceRegistry} />

// Later — positions, curated labels, notes and drawn paths back beside the source, nothing else:
const out = exportFolder(edited, { tree: buildFolderTree(files) });   // sidecar mode
await writeFileMap("./data-model", out.files, out.deletions);        // writes .better-diagrams/ only
```

Import is dialect-detected (or named with `dialect`), never throws on a recoverable tree, and returns
typed `warnings` — `unknown-shape`, `folder-mismatch`, `edge-target-missing`, `poly-capped`,
`too-many-fields`, `sidecar-orphan`, `yaml-fallback-used`, … A dropped directory whose own name
prefixes every path is re-rooted automatically. Node ids are folder paths (`core/account`), edge
ids are `${from}::${field}::${to}`, so both stay stable across regenerations and addressable
from a host. Every node and edge carries the source's metadata in `data` (`data.folder`, and for
Salesforce `data.sf` — api name, key prefix, record count, FK delete rules, business/audit flag,
per-row FLS and external-id marks). Objects nested under objects become drill-in detail; views
draw a single dashed `alias` link to their object and no FK lines; references that leave the model
get a stub under an **Outside the model** group so path search never dead-ends.

Export is **partial and additive by contract**. Sidecar mode (the default for an imported
Salesforce tree) writes only `.better-diagrams/layout.json` — the presentation half of the
[split document](#content-and-layout-the-split-document) — and `.better-diagrams/overrides.json`,
the labels, descriptions, tags, notes and `paths` a curator changed, diffed against a fresh import
when the source tree is at hand. It never rewrites `schema.json`, `relationships.json` or the
metadata folder; the org exporter stays the sole writer of org-derived content. `writeObjectYaml`
opts into patching the two curated keys (`diagramName`, `diagramType`) of existing `object.yaml`
files, byte-identical elsewhere. Full mode (`mode: "full"`, the generic writer) round-trips
`importFolder(exportFolder(t).files) ≡ t` for any document, order included.

In the editor: **Import folder** beside Import picks a directory; the Export menu offers
**Folder (.zip)** built in, and **Folder sidecar (.zip)** once a host registers the opt-in preset
(`registry={{ exporters: FOLDER_EXPORTERS }}`) — it only means something for a document that came
from a folder tree. A node added on the canvas has no source folder, so a sidecar export reports it
(`no-source-folder`) rather than writing it anywhere. The `bd-folder` CLI does the same from a shell —
`bd-folder import <dir> --out t.json`, `bd-folder export t.json <dir>`, and `bd-folder check <dir>`
(exit 1 when the sidecar on disk is out of date). The example app lists any tree dropped into
`templates/folders/` under Settings ▾ → Templates.

Every object node also carries its **full field list** in `data.sf.fields` — compact
(name, label, type, nillable, external-id/unique marks, formula, FLS visibility, reference targets;
no picklist values or lengths), whatever the `fields:` row mode drew on the canvas, capped at
`MAX_NODE_FIELDS` (500) with a `fields-truncated` warning past that. `fieldRecords(node, doc)`
merges it with the rows; the field grid, the search and the row menu read that, never the bag.

## Content and layout: the split document

A diagram is really two documents living in one JSON: the **architecture** (nodes, edges,
containment, statuses, dates — what an AI should edit) and the **presentation** (where things
sit and how lines travel — what a human arranged and wants left alone). The split makes that
boundary literal, and both forms are first-class: the inline template keeps working exactly as
before, and any template can be split into a content doc plus a layout doc and merged back
byte-for-byte.

```ts
import { splitTemplate, mergeTemplate, validatePresentation } from "@mosphere/better-diagrams";

const { content, presentation } = splitTemplate(template);
// content   → nodes without x/y/w/h, edges without labelT/anchors/waypoints
// presentation → { version, format: "better-diagrams/presentation",
//                  nodes: { api: { x, y, w, h, parent: "vpc" } },
//                  edges: { e1: { source, target, labelT, start, end, points } } }
mergeTemplate(content, presentation); // ≡ template, byte-identical
```

The merge is defensive where content edits and stale layouts collide:

- A node record remembers the `parent` and `zone` it was captured under. If a content edit
  reparented or re-zoned the node, its old coordinates are meaningless — the position is
  discarded (the size survives) and the node is **re-placed** instead of materialising somewhere
  that only made sense in its old home.
- Elements with no record (new ones) are placed by `placeUnpositioned`: stacked below the
  occupied area of their own container, which only ever **grows** — nothing that already has a
  position moves. A content doc with no layout at all goes through the full `autoLayout` instead.
- An edge record carries its captured `(source, target)`, so a model that renumbered edge ids
  doesn't silently lose every hand-drawn route — the record is matched back by endpoints.

One deliberate boundary: **zone boxes stay in content.** In this editor zone geometry *is*
meaning — membership (`zoneId`) is derived from who sits inside the box — so a layout file that
moved zones could silently rewrite the architecture. Presentation covers node boxes and edge
routes only. (Sequence diagrams already store no coordinates at all — order is the layout — so
they are the split's precedent, not a new case.)

### Edge routes: anchors and waypoints

Presentation now includes how a line travels, not just where boxes sit. An edge may pin its
`start`/`end` to a side of the node box (`{ "side": "left", "t": 0.25 }` — `t` slides along the
side, centre by default) and carry `points`, absolute-canvas waypoints the line bends through.
All three routings honour them: curved threads a smooth spline through every waypoint — the line enters and leaves each dot at the same angle, so it reads as one continuous stroke that happens to pass through a handle;
orthogonal keeps every segment axis-aligned and always leaves/arrives square to a pinned side;
straight runs direct point-to-point strokes, the classic flow-chart line. The same geometry
function drives the screen and every image export, so a routed edge exports exactly as drawn.

In the editor, shaping a line is direct manipulation: **drag anywhere on it** to bend it there —
a waypoint is born under the pointer and follows it until release, snapping softly to the
endpoints' and other waypoints' reference lines (dashed guides show while a snap holds — level
runs read as deliberate). **Its label is a handle on the same line**: drag the text ALONG the
line and it slides (`labelT`, as always); drag it AWAY from the line and the line follows,
which is how you move a line without having to hit the 2px stroke hiding under the words.
Where the line already has a waypoint, the drag MOVES the one governing the label's stretch of
line — travelling by the drag, so a dot further along doesn't teleport under the text — and
only a line with no waypoints at all gets a new one, at a deliberately blunt threshold. Nudging
the same line by its label repeatedly moves one dot instead of leaving a trail of them.
**Double-click the line or its label to edit the label inline.**
Drag a waypoint to move it, double-click the dot to remove it, or *Clear route* in the
inspector (or right-click). *Arrange → Clear routes* does the whole canvas at once — or just
the selected lines, the same scope rule Tidy uses — and says how many it changed. However many
lines any of them touches, it is **one undo**: `⌘Z` puts every route back in a single step. On a selected edge, **drag an endpoint handle** to pin exactly where
the line attaches — anywhere along any side of its box — or drop it on another node to
re-attach the edge there. The inspector's anchor pickers do the same by side (`start: auto`
follows wherever the line is going, exactly the old behaviour).
Waypoints are deliberately canvas-absolute: dragging a node re-aims the endpoints but leaves the
route in place, a **Tidy** discards all waypoints as stale (pinned anchors survive — sides are
intent), pasting a fragment translates them with it, and zone scaling carries the routes whose
endpoints both scaled.

### Dangling arrows

Drag a connection out of a node and release it over empty canvas: instead of the drop being
discarded, a bare **point** — a 12px dot, node kind `"point"` — is born under the pointer and
the arrow attaches to it. That gives you abstract arrows: pointing in a direction, at a
component that doesn't exist yet, or into the space between things. Because the dot is an
ordinary (tiny) node, everything already works on it — drag it to re-aim the arrow, bend the
line through waypoints, label it, undo it, copy it, export it. Chaining another arrow off the
head goes through a small trigger dot beside it: the four connect handles stay hidden and
inert until the pointer rests exactly on that trigger, so they never bury the head you came
to drag. Drag the arrow's endpoint onto
a real node when the thing it pointed at arrives, and the stranded dot cleans itself up
(deleting a dangling edge sweeps its dot the same way). Releasing a connection drag on a
node's **body** connects to that node — the tiny handle dots no longer have to be hit
exactly.

Exports know the difference: image exports draw the same small dot the canvas shows, Mermaid
renders the closest thing it has (a tiny circle), and C4-PlantUML — a strict semantic model
with no dangling concept — omits points and their arrows entirely.

### The split at the toolbar and the API boundary

Two exporters join the menu: **Content (.json)** ("hand this to an AI") and **Layout (.json)**.
Importing them is asymmetric on purpose — a content file is a whole document, so it loads and
lays itself out; a layout file carries no architecture, so it **re-dresses the current
document** and reports what it touched ("Applied layout to 12 elements · 3 unmatched" — the
counts are what stop a wrong-diagram layout from reading as success).

AI **refine** now speaks the content form end to end: the request's `current` and the inline
JSON are the content doc, the system prompt omits geometry and demands stable ids, and the reply
is merged with the live document's own presentation. A refine can rename, rewire, add, and
remove — and every surviving element keeps its exact place; only genuinely new elements get
positions. The trade-off is explicit: spatial instructions to the model ("make this node wider")
are no-ops, zones excepted, since their boxes are content. Generate mode is unchanged — a fresh
document has no layout to protect.

## Data models: rows, keys, and cardinality

A node can carry **rows**. `kind: "table"` renders its `fields` as a column list — name, type,
a `pk`/`fk`/`pfk` key badge, and a required marker — which is all an ER diagram is: entities
whose substance is their columns, joined by relationships that name the columns they join.

```ts
{ "id": "orders", "label": "orders", "kind": "table",
  "fields": [{ "id": "id",      "name": "id",      "type": "uuid", "key": "pk", "required": true },
             { "id": "user_id", "name": "user_id", "type": "uuid", "key": "fk" }] }

{ "id": "fk1", "source": "orders", "target": "users",
  "startField": "user_id", "endField": "id",     // the columns, not just the tables
  "startLabel": "0..*",    "endLabel": "1" }     // cardinality, at the end it describes
```

An end label that reads as a cardinality draws its **crow's-foot symbol** at the box — one bar
for exactly-one, a ring for optional, three prongs for many — and that end drops its arrowhead,
since a relationship reads by its notation. The parser is deliberately strict: `endLabel: "owns"`
is role text and keeps the plain arrow it always had, so no existing diagram sprouts symbols.
The text still renders alongside the symbol, pushed clear of it, for readers who don't speak
crow's foot.

`startField`/`endField` are **semantic, not geometric**: the line re-aims itself when rows are
reordered, and degrades to the box when the row isn't on screen — inside a collapsed group, or
one drill-in level away. Both the canvas and the image exporters resolve them through the same
`fieldAnchors`, so a PNG's foreign keys land on the same columns the screen shows. A node is
grown to fit every row it carries rather than clipping any, and a dangling field reference is
dropped on validation like any other bad reference.

Rows and cardinality are **content**, so they ride the split with the architecture: an
elements-only prompt owns them, a layout file never mentions a column, and an AI refine can add
a column without touching your layout. Everything else composes as usual — drill into a bounded
context to get a subject-area view of one domain with ghost stand-ins for cross-domain
references, put tables in a `group` to draw a subject-area boundary, date a table to watch a
migration land on the timeline.

`table` is a registry kind, and `record: true` is what marks a kind as row-bearing — declare it
on your own kinds (a class, a message schema, an API resource) and they get the same list and
the same inspector. **Insert ▸ Table** starts one with its `id` primary key already in place.

The Mermaid export follows the document: when every visible box carries rows it emits an
`erDiagram` with the columns, their `PK`/`FK` markers, and crow's-foot cardinality — read
through the *same parser* the canvas draws its symbols from, so the two can't disagree. A mixed
document stays a `flowchart`, because half the entities having no columns would make an ER
diagram claim something false about them.

### Fields beyond the rows

A record node draws its `fields[]` rows; everything else a field *is* — its label, the tables a
reference points at, FLS visibility, external-id and unique marks, a formula, and the fields an
import left off the canvas — lives in the node's `data` bag (`data.sf.fields` after a Salesforce
import; a host may put the same shape under `data.fields`). `fieldRecords(node, doc)` merges the
two into one `FieldRecord` per field, `searchFields(doc, query)` finds them, and the editor builds
on that:

- **Rows are clickable.** A click (or right-click) opens the field menu: *Pin for search*, *View
  all fields*, *Follow reference* (one per table the field points at), *Edit…* (hand-authored
  documents only — a folder-imported document's fields belong to the source), *Copy name*. Rows
  stay 19px; the states are inset-only.
- **The field grid** — *View all fields* on a row, the node's menu, or the inspector — lists every
  field record of a node: sort by any column, filter, drag columns, walk with the keyboard (Enter
  follows a reference, `p` pins, `/` filters), copy as TSV, download as CSV. Read-only. Also
  exported as `FieldGridModal` for a host's own chrome.
- **Search matches fields.** The toolbar search lists `Table · field` hits after node hits; Enter
  marks the row, or opens the grid on a field the node doesn't draw.
- **Pins.** A pinned field wears a mark and sits in the strip above the canvas; pins survive
  drilling and navigating (view state, never in the document; pruned when the node goes away).
  `getPins`/`setPins`/`navigateToField` on the ref, `onPinsChange` on the props.
- **Show paths** (two pins — a field each, or a whole table via *Pin table for search* on the
  node's menu): the routes between them, shortest first, each with its **hop strip** — the key
  carrying every hop (`order_id ▸ user_id`). All routes light in palette colours; hover or click
  one and it is singled out in the theme's **route colour** (`routeColor`, `--as-route`, a
  highlighter outside the edge palette) with a **key badge** on every lit hop. Below the routes,
  **Keys most routes use** ranks the keys the routes share (`Contact.AccountId — 7 of 9`); hover
  one to light every route through it, click to pin it. Then the tables between and the wider
  corridor, every table a click away. Three or more pins: what lies between every pair and
  everything the pins reach, with the canvas dimmed to one or the other. "Ignore arrow direction"
  is on by default. The panel says when a search stopped at its limits or a pin's field anchors
  nothing. See **Between fields** under *Finding paths* for the contract calls.
- **Key coverage** (View → *Key coverage*, or `openCoverage()` on the ref): a right-hand panel that
  scores a chosen set of keys — **`73%` · 100 of 137 tables** — with a bar per key: the chosen ones
  stacked with the running percentage, then every candidate ranked by what it would add. Click a
  bar to add or drop a key; hover one and the canvas dims to what it reaches. **Find smallest set**
  fills the chosen set with the fewest keys that reach everything any key can (greedy, then an
  exact pass over up to 12 candidates within 300 ms — the panel says "proven" only when that pass
  finished). Scope is *All tables* (a table counts when a chosen key's edge touches it) or *From
  ‹the selected table›* (a breadth-first search over the chosen keys' edges).

## Infrastructure zones

A **zone** is a shaped background region tagged to an infra provider. Zones are deliberately *not*
containers — nodes reference one by `zoneId` rather than being parented to it, so a node can sit in
the "Azure West US" zone **and** the "Payments" group at once.

Each zone lists the providers it can be switched between. Switching changes its colour **and which
nodes inside it render**:

```jsonc
{
  "zones": [
    { "id": "region", "label": "Cloud Region", "shape": "rounded",
      "x": 40, "y": 40, "w": 940, "h": 520,
      "providers": ["azure", "aws", "gcp"], "provider": "azure", "z": 0 },

    // A SaaS island drawn on top — higher z, so it claims the nodes inside it
    { "id": "vendor", "label": "Stripe", "shape": "hexagon",
      "x": 660, "y": 340, "w": 280, "h": 190,
      "providers": ["saas"], "provider": "saas", "z": 1 }
  ],
  "nodes": [
    { "id": "sql-az",  "zoneId": "region", "providers": ["azure"] },        // only on Azure
    { "id": "sql-aws", "zoneId": "region", "providers": ["aws"] },          // only on AWS
    { "id": "cache",   "zoneId": "region", "providers": ["azure", "aws"] }, // not on GCP
    { "id": "api",     "zoneId": "region" }                                 // always visible
  ]
}
```

Flip the region to AWS and Azure SQL becomes RDS in place. Flip it to GCP and Redis disappears
too. **Hidden nodes are never deleted** — they stay in the document and come back when the
provider does. `EXAMPLE_ZONED_TEMPLATE` is exactly this diagram; the example app loads it.

| Concept | What it does |
|---|---|
| Per-zone toggle | Segmented control in the zone header (a `<select>` past 4 providers). |
| Global scenario | Toolbar control drives every zone that *offers* that provider; zones that don't keep theirs. |
| Legend | Corner panel listing providers on show, with a count and how many nodes are hidden. |
| Shapes | `rect`, `rounded`, `ellipse`, `hexagon`, `polygon` — the last with draggable vertices (press an edge midpoint to add a point and keep holding to place it; double-click a vertex to remove; drag a vertex past the box edge and the zone grows to hold it). |
| Membership | Assigned on drop using **shape-aware** containment, so an L-shaped zone's notch isn't "inside" it. Overlaps resolve by highest `z`, then smallest area. |
| Moving one | Press anywhere on it and go, the way a node moves — the header chip and the whole interior are both drag surfaces from the first mouse-down, with no click to select first. Nodes sit above it and keep their own presses, and the Select tool (`M`) takes the pointer first, so a rubber band still starts inside a region. **Its members travel with it**, the way resizing one already scaled them — a node nested in a container moves with the container rather than twice, and a member living on a drilled-in level is left where it is. Anything the region is dragged *over* is enrolled on drop, as before. A **locked** zone has no drag surface at all. |
| Where a new one lands | *Insert ▾ → Zone* puts it in the first corner of the visible canvas that is clear of every node and zone, sized to fit the viewport. If no corner is free it goes below the diagram and the canvas pans to it. It arrives selected, so it can be dragged immediately. |

Providers are registry-extensible like everything else:

```jsx
registry={{ providers: { fly: { label: "Fly.io", color: "#8b5cf6" }, aws: { color: "#ff9d2e" } } }}
```

A provider that is **not** registered still works — the zone inspector's *Supports* row takes any
name as free text, which is how you add one without touching the registry. It is named from its id
(`render` reads as "Render", `my-cloud` as "My Cloud") and given a colour derived from that id, so
two hand-added providers never look alike. Register it when you want the real brand colour, a
label the id can't spell, or an icon.

Programmatic control, if you'd rather drive it from your own UI:

```ts
import { setZoneProvider, setAllZoneProviders, visibleElements, activeScenario } from "@mosphere/better-diagrams";

setAllZoneProviders(template, "aws");   // the "show me the all-AWS build" switch
visibleElements(template).nodes;        // Set<string> of what renders right now
activeScenario(template);               // "aws" when uniform, null when mixed
```

> **If you consume `fromReactFlow` directly, pass `base`.** `toReactFlow` omits hidden nodes, so
> without the original document as `base` those nodes are absent from the round-trip and get
> deleted — toggling a zone and back would permanently destroy every provider-specific node. The
> component does this for you.

### Zone styling

A zone stores (or inherits) one colour: its **ink** — the vivid outline colour a human actually
reads. The background fill is **derived** from it as a duller tint (the ink at `opacity`,
composited over the canvas), which automatically reads darker-dull in dark mode and
lighter-dull in light mode. `color` is optional canonical `#rrggbb`; validation also accepts
`#rgb`, CSS 8-digit `#rrggbbaa`, and `#rrggbb/NN` (percent), folding any alpha into the zone's
`opacity` field (an explicit `opacity` wins). `outline` is `solid` (default, never stored) /
`dashed` / `dotted` / `none`; `fill: false` turns the background off entirely.

The zone inspector's colour row shows every provider default plus every custom colour already
used by another zone — matching an existing colour is one click — alongside a native picker for
anything else, and an **Auto** chip returning to the provider's colour. Selection reads as
outline *weight*, not dash, so a deliberately dashed zone stays distinguishable from a selected
one. Exports (PNG/SVG/PDF/interactive HTML) resolve the same `zoneInk`/`zoneFill` formulas the
canvas uses, so they cannot disagree; the legend deliberately stays grouped by provider — a
recoloured zone is still hosted where it is hosted.

### Colour tokens

Beyond the base tokens, the `theme` prop reaches the warning and comparison colours
(`diffAdded/diffRemoved/diffChanged`, `warn`/`warnStrong` for deprecated's salmon→red,
`overdue`, `hazardInk`/`hazardTape`), the shadow ink, the strength of a lit path's glow
(`glowAlpha`, `glowBlur` — `LIGHT_THEME` tightens both), `colorScheme` (which native date pickers,
select popups and scrollbars follow), and three record tokens — `edgeColors`, `seqAccents` and
`nodeAccents` — that fan out to per-entry CSS variables (`--as-edge-sky`, `--as-seq-database`,
`--as-node-service`).

**`LIGHT_THEME` retunes all of them**, and clears WCAG AA throughout: the fixed palettes were
picked for the dark canvas (sky `#38bdf8` sits at ~2.2:1 on a light page, and the node-kind
accents that colour every eyebrow, icon and PK/FK badge sat between 1.6 and 2.5:1) and darken to
legible counterparts in light mode, on canvas and in every export. A node's own `color` still
wins over both, and the registry's accent remains the fallback for a kind the theme doesn't
name — including one a host registers.

Two things the theme is deliberately not responsible for. **Dimmed states fade the box, not the
words**: `deprecated`, `retired`, ghosted and tag-filtered nodes recede by dulling their frame,
icon and description while the title and the status word stay legible (the word "deprecated"
reads at 4.95:1 in light mode, where it used to be 1.88:1) — because hover-to-restore does
nothing for a keyboard, a touch screen, or a PNG. And **provider segments derive their ink from
the provider's own colour** rather than the theme's, so a host that registers a pale brand still
gets readable text on it.

## Extending it

Three plain records, shallow-merged over the built-ins. Omit a key to keep the built-in, pass a
partial to override it, pass `null` to remove it:

```jsx
<ArchitectureStudio
  registry={{
    nodeKinds: {
      lambda: { label: "Lambda", accent: "#fb923c", icon: "lambda" },
      region: { label: "AWS Region", container: true },   // nodes can nest inside it
      queue: null,                                         // remove a built-in
    },
    icons: { lambda: ["M4 4h6l7 16h3", "M20 4h-5L8 20H4"] },  // 24x24 viewBox paths, stroke only
    exporters: { terraform: myExporter, pdf: null },
    promptExtraRules: "- This org runs on AWS; prefer lambda for compute.",
  }}
/>
```

**Icons.** Forty-five built-in glyphs, listed by `ICON_NAMES` and offered in the node
inspector's picker: the C4 primitives (`user`, `server`, `database`, `cloud`, `globe`, `box`,
`shield`, `lock`, `layers`, `code`, `doc`, `mail`, `gear`, `bolt`, `window`, `mobile`, `users`,
`sparkle`) plus the roles a real diagram keeps needing — `balance` for a load balancer, `share`
for a topic or a mesh, `grid` for a replica set, `branch` for a pipeline, `key`, `chart`,
`search`, `filter`, `folder`, `sync`, `cpu`, `terminal`, `clock`, `calendar`, `bell`, `card`,
`cart`, `activity`, `eye`, `warning`, `check`, `link`, `image`, `video`, `pin`, `robot` and
`flask`. All one stroke-only 24×24 idiom, so the same path data drives the canvas, the SVG
export and the Canvas2D raster export. `"none"` opts a node out.


A registered kind shows up in the inspector dropdown **and** in the generated system prompt, so
the model can emit it too. `example/src/extensions.js` demonstrates all of it.

## Exports

PNG, PDF, SVG, template JSON, Content/Layout JSON (the split — see above), React Flow JSON,
Mermaid, and C4-PlantUML ship built in. The
image formats render from one emitter: `emitTemplate(template, registry, palette, { mode })`
produces a backend-neutral command list that `renderTemplateToCanvas` and `renderTemplateToSvg`
both replay — through the **same** edge geometry the screen uses — so PNG, PDF, and SVG can never
disagree with each other or the editor. The `palette` (see `ExportPalette`, `DARK_EXPORT_PALETTE`,
`LIGHT_EXPORT_PALETTE`) recolours an export without touching its layout; the editor passes one
derived from the active `theme`, so a light-mode app exports light images automatically.

`mode` is the other half of that: it is the same `"technical" | "marketing"` the editor takes, and
it dresses the drawing rather than recolouring it — 12px corners, per-kind gradient cards under an
accent-tinted shadow, the larger icon chip (inverted to a pale tile on a light palette, the way the
screen inverts it), the bigger sans type, and the labels marketing tucks away. The editor threads
its own mode into every picture export, so a slide exported out of marketing mode comes back
looking like the slide. Whether a palette is light or dark is read off `palette.bg`, not passed in,
so a headless `renderTemplateToSvg(doc, registry, LIGHT_EXPORT_PALETTE, { mode: "marketing" })`
gets the light treatment with no theme in sight. Anything unrecognised in `mode` falls back to
technical rather than half-applying a look.

Image exports draw zones behind everything, honour the active provider selection (hidden nodes
and their edges are omitted, and the crop tightens to what's visible), and stamp the legend into
the corner so the file explains its own colours — in a gutter of its own, so it never lands on
the diagram. Dates in an export always carry the year: a picture outlives the calendar. With
something selected, Export offers **Selection only**, which narrows the PICTURE formats to the
selected subgraph (descendants and internal wiring included, the same rule Copy uses). Document
formats never narrow — "export → save to your database" must not quietly become "save only what
I had highlighted". Mermaid can't express overlapping regions, so it
records the active selection as `%% zone:` comments and reserves subgraphs for groups.

A custom exporter receives the mode alongside the palette (`{ template, registry, filename,
palette, mode }`), and returns a blob to download, or nothing if it delivered the result itself:

```js
const summary = {
  label: "Copy summary",
  async run({ template, registry, filename }) {
    await navigator.clipboard.writeText(`${template.nodes.length} nodes`);
    // returning nothing = handled, no download
  },
};
```

## AI generation

The editor **never calls a model provider directly** — that would ship an API key to every
visitor and be CORS-blocked anyway. You supply `generate`:

```jsx
import { createProxyGenerator } from "@mosphere/better-diagrams";
const generate = createProxyGenerator({ endpoint: "/api/diagram" });
```

Your route receives `{ mode, input, systemPrompt, current }` and returns `{ text }` or
`{ template }`. `example/server.mjs` is a complete ~90-line reference using `claude-opus-5`.

## C4 & professional editing

The schema and editor cover C4's notational essentials:

| Feature | Where |
|---|---|
| **Silhouettes** — `cylinder` (database), `pipe` (queue), `person` (opt-in actor) | Registry-level `shape` on a kind; identical geometry in exports |
| **Edge tech label** — C4's `[JSON/HTTPS]` | `edge.tech`, second line under the label |
| **Numbered dynamic flows** | `edge.seq` renders a circled step badge; C4-PlantUML export prefixes `1.` |
| **Direction** — `forward` / `both` / `none` arrowheads | `edge.direction` |
| **End glyphs** — solid arrow, open chevron, hollow diamond (aggregation), circle, bar | `edge.startHead` / `edge.endHead`; an explicit `startHead` renders even on a `forward` edge. Drawn back from the attachment so nodes can't cover them |
| **Self-loops** | `source === target` draws a retry arrow out one face and back into an adjacent one; drag an edge's endpoint onto its own source to make one |
| **Routing** — curved / right-angle / straight | `meta.routing` sets the diagram default (Arrange → connector picker); `edge.routing` overrides per edge. Right-angle elbows are rounded |
| **Flow-chart kinds** — `decision` (diamond), `terminator` (stadium), `io` (parallelogram) | Insert or the kind picker; Mermaid exports each by its shape |
| **Language models** — `lm-small`, `lm-medium`, `llm` | One hue at three strengths, so the weight class is legible at a glance: a 1B router never looks like a frontier model. Provider-neutral — name the model in `description` ("Phi-3 mini", "Claude Opus 5"); use a cloud's own kind (`azure-openai`, `aws-bedrock`, `gcp-vertex-ai`) when the box is the hosting *service* |
| **Collapsible groups** | ▾ on a group collapses it to a chip; contents hide, their edges re-route to the chip, and the stored size survives expand. Never destructive — collapse is view state that rides the undo stack. `settings.groupContents: "hide"` folds every group with contents at once, with a **Fold groups** toolbar toggle to flip it (see **Settings** above) |
| **Tags + filter** | `node.tags`; the View tag filter dims non-matching nodes — dim only, never hide, so the filter can't touch what persists |
| **Doc links** | `node.url` renders an ↗ affix (a real link in read-only) |
| **Team ownership** | `node.team` renders a tag riding the node's edge, coloured stably per team name (same hue on screen and in image exports); View → Show team badges toggles them while editing |
| **Lifecycle status** | `node.status`: `proposed` (dotted) / `planned` (dashed) / `stubbed` (heavy construction dashes + faint hatch — scaffolding with no implementation) / `dark` (black/white hazard-tape outline — built and shipped but not yet enabled) / `active` (default, never stored) / `deprecated` (dimmed, salmon status text sharpening to red on hover/selection) / `retired` (dimmed + struck through). Every dulled stage brightens to full strength under the cursor so its label stays readable. Same conventions in image exports; C4-PlantUML gets `$tags` |
| **Version tag** | `meta.versionTag` ("v2.1", "2026-Q3 draft") renders as a corner notice — `meta.versionTagPosition` picks the corner; click it to edit, View → Set version tag… to create one. Stamped into image exports |
| **Lock** | `node.locked` / zone lock pins an element against drags and resizes |
| **Search** | ⌘K, matches id/label/description/kind/tags, Enter cycles and centres |
| **Snap & align** | Arrange: snap-to-grid, align left/centre/right/top/middle/bottom (2+ selected), distribute (3+), clear routes |
| **Title block** | `meta.title` stamps exported images |
| **C4-PlantUML export** | `Person`/`ContainerDb`/`ContainerQueue`/`System_Ext`/`Container`, `Container_Boundary` for groups, `Deployment_Node` for zones, `Rel`/`BiRel` with tech |

Zone **Supports** is editable in place: chips toggle registered providers, the free-text input
adds any provider by name (neutral colour until the host registers it), and custom entries can
be removed the same way.

## Sequence mode

A second, **feature-complete schema** — `SequenceTemplate` — with its own editor,
`SequenceStudio`, sharing the same chrome (toolbar dropdowns, bottom-centre inspector, undo,
save, theming, version tag) but sequence-style:

| Element | Schema | On canvas |
|---|---|---|
| Participants | `participants[]` — `kind` (actor/service/database/queue/external), `team`, `status` | Header row; drag a header past the halfway point to reorder columns |
| Messages | `messages[]` — `style` (sync/async/reply), `tech`, self-messages (`from === to`), lost/found (`null` endpoint, pick "(the environment)" as an end) | Horizontal arrows; click the label to select, **drag it up/down to reorder time**; drag between headers to connect |
| Activation bars | `activations[]` — anchored to message ids | **Press-drag on a lifeline to add one** (a click selects the column instead), resize its ends, Delete to remove |
| Fragments | `fragments[]` — loop/alt/opt/par/break with else branches | Frames with operator tabs; wrap the selected messages via Insert. Branch guards are editable and removable one at a time, and `+ branch` is offered only on the kinds that can hold one |
| Notes | `notes[]` — side, anchor message | Dog-eared cards; drag onto another lifeline to re-anchor, above the first row to float free |

The document stores **no coordinates**: participant column = array order, message time = array
order, and spans anchor to message *ids* — so inserting a message inside a `loop` grows the
loop, diffs stay structural, and the whole document maps 1:1 onto Mermaid/PlantUML.

Two ids are all a span has, which is what makes inserting a step inside a loop free — and what
makes removing or moving a BOUNDARY message need help. `removeMessages` and `moveMessage` resolve
each span to the ROWS IT COVERS before the list changes and re-hang its ends on the survivors, so
deleting a loop's first message leaves the loop over what is left rather than deleting the loop,
and dragging that message to the bottom takes it OUT of the loop rather than stretching the frame
to follow it. Deleting a participant that carries messages asks first, and says what went with it.
A fragment that would CROSS an existing one is refused: properly nested or disjoint frames are the
only shapes Mermaid and PlantUML can express. Exports:
PNG/PDF/SVG through the same draw-command backends (light/dark palettes included), Mermaid
`sequenceDiagram`, PlantUML (full fidelity incl. lost/found), and the JSON itself. The example
app's **Architecture | Sequence** tabs switch editors.

```jsx
import { SequenceStudio, EXAMPLE_SEQUENCE } from "@mosphere/better-diagrams";
<SequenceStudio value={doc} onChange={setDoc} onSave={persist} theme={LIGHT_THEME} />
```

**Architecture → sequence, deterministically.** `sequenceFromTemplate(archTemplate)` derives a
base sequence with no model involved: edges carrying `seq` (the numbered dynamic flow) become
the messages in order — or every edge in document order when nothing is numbered — with
kind/team/status/tech carried over and `direction: "both"` expanding to a call plus a dashed
reply. The example app's **→ Sequence** button on the Architecture tab is exactly this.

**Files & linking.** Both editors accept a `files` list + callbacks; the toolbar brand then
becomes a file selector (switch, create, rename, delete — with a confirmation before losing
a document that still has content, and a **Recently removed** modal to undo a mistake) while
the HOST owns the workspace —
the example app keeps a unified file list in localStorage where each file's kind (arch/seq)
decides which editor mounts. Cross-file links reuse `node.url` with the `file:` prefix
(`file:Order flow` by name or `file:<id>`): the node's ↗ then jumps to that file via
`onNavigateFile` instead of opening a browser tab. **→ Sequence** derives a NEW sequence file
from the active architecture — it never overwrites an existing document.

The example app also carries a **⇄ mode switch** (flips a blank file between architecture and
sequence in place; on a file with content it opens a new blank file of the other type) and a
**Copy schema** button. On an architecture file that button opens the `SchemaCopyModal`
described above — which clouds and which of their resources the copied contract should teach,
seeded with the open document's own — rather than copying blind; sequence files have no
provider vocabulary to scope, so they copy straight to the clipboard.

**Auto-save to the repo, while developing.** `npm run dev` mounts a small dev-only route
(`example/vite-plugin-templates.js`) that writes every open file to `templates/scratch/` at
the repo root, one plain `.json` per document, debounced. Renaming a file renames the JSON and
deletes the old one; deleting a file deletes it. `scratch/` is git-ignored — it's rewritten
every session — while `templates/examples/` is tracked, curated, and read-only to the app:
drop a template there (or copy one up from scratch) and it's loadable but never overwritten.
Both folders appear under **Settings → Templates**, re-read each time the menu opens. The
files are ordinary templates — the same shape Import and the paste box accept. The route
exists only in the dev server: a built app finds nothing there and carries on with
localStorage, which is still the app's own source of truth.

**AI is optional, per editor.** Pass the same `generate` function the architecture editor takes
(`createProxyGenerator` works unchanged — the sequence system prompt travels with each request)
and the Sequence tab gains the AI panel: a context box for describing who participates, how
the flow goes, and the steps in order, plus a refine input against the current document. Omit
`generate` and no network code runs; the example app's "AI panel" checkbox toggles it for both
tabs.

## Governance: Checks and Compare

**Checks** is an architecture lint. `lintTemplate(template, rules)` is a pure contract function
run on every committed edit; findings appear in the toolbar's **Checks** menu (error-first) and
clicking one selects and centres the offenders. Built-in rules: unconnected components,
synchronous cycles, external systems reaching datastores directly (error), partially-missing
team ownership, unlabeled cross-team edges, and active components depending on
deprecated/retired ones. Hosts add or remove rules through the registry:

```js
registry={{ lintRules: {
  "keep-it-small": {
    label: "Diagram too large",
    severity: "warning",
    check: (t) => (t.nodes.length > 30 ? [{ message: `${t.nodes.length} nodes` }] : []),
  },
  "missing-owner": null,   // remove a built-in
} }}
```

One element can opt out with a **tag**: `lint-ignore` silences every rule on it,
`lint-ignore:no-orphans` silences one. A tag rather than a schema field because that is where
"this is deliberate, stop telling me" already lives in the document — it survives every
round-trip and shows in the tag filter, so a reader can see what has been excused and why the
Checks count is what it is. The built-in rules also know what is *not* a component: a retry
self-loop is not a cycle, a `direction: "none"` association is not a call, and nobody owns a
decision diamond or the dot at the end of a dangling arrow.

**Compare** diffs the live document against a baseline — `diffTemplates(base, current)` matches
by id and ignores pure moves/resizes *and* pure view state (a folded group is not an
architecture change), so the diff is about structure, not tidying. It reports `meta` too, so a
retitled diagram or a changed version tag is visible. `diffSequences` is the same function for a
sequence document, where there are no coordinates to ignore at all. On screen,
added elements outline green-dashed, removed ones render **ghosted in place** in red, changed
ones amber, with a `+a −r ~c` banner. Pass `diffBase` (e.g. the last approved revision from
your DB) or use the toolbar's Compare button with a `.json` file. The view is strictly
read-only and rendered by a separate canvas, so entering and leaving it can never touch the
document.

## Timeline: dates and the scrubber

Every element in both documents — nodes, edges, zones, sequence participants and messages —
may carry a `date` (`"YYYY-MM-DD"`). It renders on the element as a small grey outlined chip
(`Mar 14`, gaining a two-digit year once the year stops being the current one) and it appears in
image exports, so a roadmap survives into the shared artefact.

```json
{ "id": "wrk", "label": "Worker", "kind": "service", "date": "2026-06-15" }
```

The dates **are** the timeline — there is no separate phases structure to keep in sync with the
diagram. `templateTimeline(doc)` collects the distinct dates into ascending *stops*, and the
toolbar's **Timeline** button appears as soon as one element is dated. The cursor is a
**date, not a stop index**: scrubbing is continuous over days, so "what did this look like on
the 20th of April" is answerable even though nothing is dated then. The stops still matter —
each gets a tick, and the handle **snaps** to one whenever it comes within a few pixels (the
threshold is converted from pixels to days against the measured track, so the pull feels the
same whether the plan spans a month or a decade). Hovering near a tick previews the landing: a
ghost outline appears at the tick and the real handle fades, so the two read as one move.
Clicking the date readout on the right swaps it for a date field — type any date, on the plan
or off it. The scrubber opens on **today**, held inside the plan's own span.

- an element dated **on or before** the cursor is present;
- an element with **no date** is present at every point — undated means "always been there",
  not "due at the epoch";
- so the earliest stop shows that date's elements plus the undated backdrop, and any cursor at
  or past the last date shows everything.

Dates **cascade down containment**: a node's effective date is the latest in its ancestor chain,
because a box cannot exist before the boundary drawn around it. An edge is never earlier than
the two nodes it joins, and a sequence message never earlier than its two participants. A zone's
date is its own — `zoneId` is membership, not containment, so a region arriving later says
nothing about when its members do.

**Ghost later / Hide later** decides what happens to everything ahead of the cursor: greyed out,
or left out of the render entirely. Rows and columns keep their positions in a sequence diagram,
so a hidden step leaves a gap where it will land rather than renumbering the flow under the
cursor.

Exports split by intent while you are scrubbed with **Hide later** on. Picture and
communication formats (PNG, PDF, SVG, Mermaid, PlantUML) export the slice you are looking at —
a PNG of the June view should look like June. **Document formats never slice**: Template
(.json), React Flow (.json), Sequence JSON, and Interactive HTML all declare
`fullDocument: true` and receive everything, because "export → save to your database" while
scrubbed must not silently delete the elements the cursor was hiding. **Ghost later** exports
the whole document from every format, because that is what it is showing. Dates travel into the
Mermaid exports as well as the image ones; C4-PlantUML has no honest slot for them (`$tags` is a
styling hook), so they are omitted there.

**Interactive HTML** (Export → Interactive HTML, both editors) writes one self-contained
`.html` file — no network requests, no dependencies — with the diagram as inline SVG and the
timeline scrubber working *inside the file*: continuous over days with snap-to-stop, hover
landing preview, a click-to-type date readout, ◀ ▶ / arrow-key stop stepping, and an "N ahead"
count. A ⋯ menu holds the presentation options (Ghost later / Hide later, Fit to window, show or
hide the timeline bar) and a ⛶ button toggles full screen. It works because the SVG backend
groups every element's drawing under a `<g data-day>` carrying its **effective** landing day —
cascade and edge inheritance already resolved by the emitter — so a few lines of inline vanilla
JS scrub by comparing numbers and toggling classes, never re-rendering. This exporter declares
`fullDocument: true`, so it receives every element and every date even while you are scrubbed
with later elements hidden — a slice would leave the file nothing to scrub. An undated document
exports as a plain viewer (fit + fullscreen, no bar). `buildTimelineHtml` is exported for
servers and custom exporters.

Timeline mode is **fully editable** — drag, connect, insert, and inspect as normal while
scrubbed. The cursor is applied as a display pass over the canvas the editor already holds
(later elements are flagged or hidden on the way into React Flow, never removed from state), so
a commit while scrubbing can never delete what the cursor is hiding. Anything **inserted** while
scrubbing inherits the cursor as its `date` — a tab hanging under the bar says so — because a
box added to the June view belongs to June, and in Hide-later it would otherwise vanish the
moment it was created. Scrubbing itself never commits, and exiting shows the whole diagram
again. `←` / `→` step between stops while nothing is selected; `Esc` leaves.

A **past date on a still-pre-active element** (proposed/planned/stubbed/dark) renders its chip
in amber — the plan says landed, the status says not. Active elements with past dates stay
quiet: that just means "landed". The predicate is `isOverdue` in the contract, and exports
carry the amber.

Set a date from the **Date** section of any inspector, or have the model author one — both
generated prompts describe the field and tell the model to use it only when the request is
actually about a rollout. The scrubbing logic is pure and lives in `contract/timeline.ts`
(`timelineView`, `sequenceTimelineView`, `normalizeDate`, `formatDiagramDate`), so a backend can
render "the architecture as of 2026-06-15" without React.

## Layout, clipboard, ghosts

**Tidy** arranges nodes within each zone and group using a layered (Sugiyama-style) layout,
growing containers to fit but never moving them. It's written in-package rather than delegating
to dagre because the layout has to be *container-constrained* — a global layout that ignored
zones would drag nodes out of the region deciding whether they're visible, silently changing the
document's meaning. It also runs automatically on generated diagrams, but only when
`hasOverlaps` says the output is actually a mess.

Two things Tidy leaves alone, because moving them would contradict what they mean. A **locked**
node keeps its position and its size — a lock says the editor refuses to drag or resize it, and
a Tidy is the editor doing exactly that. And **provider alternates** stay stacked: "Azure SQL /
Amazon RDS / Cloud SQL" is one box drawn three ways, authored at the same spot with disjoint
`providers` so that switching scenario swaps it in place. Ranking them as three members would
deal them three slots — a permanent gap wherever the hidden two sit, and a database that jumps
across the diagram when the scenario changes. A set counts as alternates when its members share
a container and the same neighbours, and their provider lists cannot both be showing at once.

**Copy / paste** (`⌘C` / `⌘V`) travel as template JSON through the system clipboard, so a
fragment pastes into another diagram or another tab. Text on the clipboard that is not a
fragment pastes nothing and says so — re-applying the last in-app copy instead would look like
the editor inventing a node out of nowhere. Descendants come along with a copied
container, ids are remapped, and an existing zone is reused rather than cloned. A fragment
keeps only the lines wholly **inside** the selection — copy two connected nodes and the line
between them pastes too; copy one node and no lines come along (the other endpoint may not
exist wherever the fragment lands).

The copy lands **clear of its original and cascades** on repeat pastes. That matters more than it
sounds: a single-node fragment carries no lines by design, and a copy sitting nearly on top of
its source — selected, so drawn a z-band above it — reads convincingly as "pasting deleted my
node's edges" when they are simply underneath. A fragment also carries **absolute** coordinates
for its roots, so copying a node out of a group puts the copy beside it rather than wherever its
parent-relative numbers happened to point.

**Duplicate** (`⌘D`, or the duplicate button in the inspector) is different by design: it happens in
the same document, so it carries the selection's **direct connections** — internal lines clone
between the copies, and boundary lines re-attach their cloned end to the copy while keeping the
original neighbour (`duplicateWithConnections` in the contract).

**Zones** copy too, with subject/ride-along asymmetry: a zone that rides along because a copied
node references it is *reused* by id when pasting into the same diagram (pasting a node from
"Cloud Region" must not spawn a second region), but a zone you select and copy is a **subject**
— it brings its member nodes and their internal edges, and paste always clones it under a fresh
id, re-zoning the copied members into the clone. `⌘D` (or the duplicate button) on a zone duplicates the whole region
with its members and mirrors their boundary connections.

**Show hidden nodes** (View) ghosts the nodes the active provider hides, so they stay
selectable and editable instead of being unreachable. Ghosts never appear in exports — an export
shows the active scenario.

The toolbar opens with the **tool tray** (below), then groups its actions into four dropdowns —
**Insert** (node/group/text/zone),
**Arrange** (tidy, clear routes, align, distribute, routing, snap), **View** (ghosts, tag filter), and
**Export** — all sharing one open-menu slot, so opening one closes the rest and a click
anywhere else closes them all — and the click that dismisses a menu is spent on dismissing it,
rather than also selecting whatever was under the pointer. The inspector reads as captioned
sections (Node · Style · On · Tags · Link) instead of an unbroken run of inputs.

Selecting **more than one** element keeps the same inspector, handed the whole selection: the
count, then every node setting the selected nodes **share** — kind, icon, lifecycle status, text
alignment, vertical alignment, label size and wrap, the frame styling when every one is a group,
a note's outline when every one is a note, provider scoping when they all sit in one zone, tags,
team, date, lock — and every connection setting the selected lines share: direction, the tail
and head glyphs, routing, the side each end leaves from and arrives at, cardinality, technology,
date, style, colour, providers, plus Reverse and Clear routes for the lot. Only what names *one*
thing is withheld: a node's label, description, rows and link; a line's label, step number and
row attachments. Each control shows the shared value — or **Mixed** (a disabled option, an
indeterminate checkbox, a placeholder) when the selection disagrees — and setting it writes to
everything selected in one undo entry. A tag chip is on when *every* node carries it; toggling
an on chip strips it everywhere, an off one gives it to everyone. The bar adds align, distribute,
group, a lock that covers zones too, duplicate and delete. A selection of nodes **and**
connections edits one side at a time: the count becomes a tab strip (`3 nodes` · `2 connections`),
so the bar stays a few rows and never buries the canvas it is editing.

**Resizing one node of a multi-selection resizes its peers.** React Flow already drags every
selected node together; the resize handle now does the same, live, so five cards can be matched
in one gesture. Peers are boxes of the same class — cards follow cards, frames follow frames,
notes follow notes — and each keeps its own floor (a table its rows, a wrapped title its lines, a
group its children), so a size the handle can reach on the dragged box never squashes a
neighbour's contents. Locked nodes, zones, and dangling-arrow dots stay as they are, and so do
the resized node's own container and contents: a band across a group selects the frame and what
is in it, and resizing the frame must not stamp its size onto the cards inside.

## Canvas tools

What a press and a drag on the canvas MEAN is a mode, and the toolbar's leftmost control is the
tray that picks it. It **opens on hover**, unlike every other menu on the bar: a tool is reached
for mid-gesture — you want the rubber band because of what is in front of you right now — and a
click-to-open, click-to-pick tray puts two presses in the way of a switch that should cost one.
Hovering opens it; the click that picks a tool is the only one you spend. (Hover is a mouse
affordance: a tap synthesises `pointerenter` on the very control it is about to press, so touch,
pen and the keyboard get an ordinary click/`↓` open instead.)

| | | |
|---|---|---|
| **Cursor** | `V` | The canvas you already had. Click to select, `⇧`/`⌘`-click to add, drag a card to move it, drag the bare pane to rubber-band |
| **Select** | `M` | Drag **anywhere** — over the cards too — to rubber-band. Nothing is draggable, so a band never begins by shoving whatever it started on |
| **Pan** | `H` | Drag anywhere to move the canvas. On touch, where there is no modifier to hold and no middle button, this is how you pan while Select is live |

Two rules hold across both bands:

- **A press that never moves is an ordinary click.** Under Select, click-to-select,
  double-click-to-drill and right-click all still work; only a real drag (4px) is intercepted.
- **`⇧` or `⌘` MERGES.** A modified band adds its catch to what was already selected instead of
  replacing it, and it stays selected *throughout* the drag rather than blinking out and
  returning at the end. React Flow's own band cannot do this — it calls `resetSelectedElements()`
  the moment a drag passes the click threshold — so the pre-drag set is snapshotted on the
  pointerdown that starts the gesture and put back after each of its select changes. The Select
  tool's band is ours outright (`react/marquee.ts`), for the same reason plus one more: React
  Flow only starts a band on a press that lands on the bare pane, so its band cannot begin on top
  of a card.

Resize handles and zone vertices are Cursor-tool affordances and disappear under the other two —
left live, a band that began on a selected card's corner resized the card instead of drawing.

## Keyboard

Press **`?`** for the full sheet (also in View). Bindings follow Excalidraw's conventions
wherever this editor has the same concept, so muscle memory carries over.

| | |
|---|---|
| **Essentials** | `⌘Z` undo · `⇧⌘Z` / `⌘Y` redo · `⌘S` save · `⌘A` select all · `F2` (or `Enter`) rename in place · `Delete` remove selection (cascades into groups) · `Esc` one thing at a time — see below |
| **Clipboard** | `⌘C` · `⌘V` · `⌘X` cut · `⌘D` duplicate with connections · `⌥`-drag to drag a copy and leave the original |
| **Tools** | `V` cursor · `M` select (rubber-band) · `H` pan · `⇧`/`⌘`-click adds to the selection · `⇧`/`⌘`-drag bands *into* it |
| **Insert** | `N` node · `G` group · `T` text note · `Z` zone — all land at the canvas centre, exactly as the Insert menu does |
| **Arrange** | `←↑→↓` nudge 1px · `⇧`+arrows nudge 10px · `⌘⇧`+arrows align · `⌘G` wrap the selection in a container · `⌘⇧G` ungroup · `⌘⇧L` lock |
| **View** | `⌘=`/`⌘-`/`⌘0` zoom · `⇧1` fit · `⇧2` fit selection · `⌘'` snap to grid · `⌘K` search (`⇧Enter` for the previous match) · `⌘⇧K` the selected node's link · `⌘⇧E` export PNG · `Space`-drag pan |
| **Timeline** | `←`/`→` step between stops, while scrubbing with nothing selected |

`⌘S`, `⌘K` and `⌘⇧K` are **global**: they work from inside a text field, because "rename the
node, hit `⌘S`" is the most natural sequence here and yielding to the field would hand the key
to the browser. Every other binding stands down while you are typing, and all of them stand
down while a dialog is open — a shortcut that edits a canvas nobody can see is not a shortcut.

**`Esc` does ONE thing per press**, outermost first: close the shortcut sheet, then the tool tray,
then a menu, then a panel, then put the arrow back if another tool is live, then drop the
selection, then leave the timeline, then step out one drilled level. It
used to clear everything at once, so dismissing the `?` sheet also threw away the timeline
cursor you had scrubbed to. `Esc` also abandons a drag in progress — a connection being pulled,
a line being bent — rather than leaving undo as the only way back.

Four places the conventions could not be copied verbatim, and why:

- **`⌘K` is search, not link.** It predates this, is advertised in the search field, and works
  from inside any input. Links take `⌘⇧K`.
- **Renaming is `F2`, not double-click.** Double-click is the DRILL gesture and worth keeping:
  it opens a component's next C4 level, including the empty one you start a decomposition from.
  `F2` (or `Enter` on a single selection) opens the name in place instead; a text note and an
  edge label still edit on double-click, since neither has a level to drill into.
- **Arrow keys move the selection, not the focused node.** React Flow's built-in nudge only
  moves the one node with DOM focus and can't move a multi-selection, so `disableKeyboardA11y`
  turns it off and the editor owns all four arrows. With nothing selected they fall through to
  the timeline.
- **`⌘]`/`⌘[` restack zones only.** A node's z-index is *derived* from nesting depth and overlap
  into fixed painting bands (zones < containers < edges < leaves); only zones carry a stored `z`.
  One press swaps with the neighbour rather than incrementing, since equal `z` resolves by array
  order and would look like nothing happened.
- **Edge text is the topmost layer, always.** A line passes *under* the cards it crosses by
  design; its label, cardinality, tech and date do not — they render through React Flow's
  viewport portal (and paint in a final pass in exports), above every node and every other line.
  A connection whose name is hidden by whatever it happens to cross is a connection you can't read.
- **A node sitting ON another node paints above it — and so do its edges.** "On" means inside
  its box, or overlapping most of it (≥60% of the smaller card), so a card dropped on another
  and left hanging over the edge still counts. The whole band lifts together
  (`… edges(0) < leaves(0) < edges(1) < leaves(1) …`), because a stacked card whose wiring
  stayed buried under the card it sits on would read as unconnected. Group frames are exempt:
  they are the band edges already cross, so nesting in a group lifts nothing. Cards that merely
  graze a corner, or match exactly in size, tie and resolve by document order as before. Image
  exports paint in the same bands.

Excalidraw's freedraw, eraser, laser, image and flip tools have no counterpart in a node graph,
and copy-/paste-styles is near-empty here because colour is registry-level by kind rather than
stored per node — so none of those are bound.

Sequence mode binds the subset that means something there (`N` participant, `A` actor,
`M` message, `T` note, `⌘D` duplicate, plus the essentials and zoom); its `?` sheet lists only
those, and its View menu points at the sheet. `Insert ▸ Message` uses the participants you have
selected and lands after the selected message rather than always appending Customer → Web App at
the bottom of the flow.

Mouse: drag from a node edge to connect. Drop a node onto a group to nest it, drag it out to
un-nest — the frame you are about to land in lights up while you drag, and dropping onto a
COLLAPSED frame opens it so you can see the node arrive. Dragging a node also shows **alignment
guides** against its neighbours' edges and centres, and snaps softly to them (off while
snap-to-grid is on, and only for a single dragged node). Drag an edge label along its curve to
slide it, or away from the curve to bend the line itself. Shift- or ⌘-click extends a selection;
a rubber band takes everything it touches, plus the lines those elements are wired to, and holding
the same modifier adds that catch to the selection instead of replacing it (see **Canvas tools**). A group
is dragged by its label bar, so the space between its children is free for a rubber band.
**Right-click** anything for the actions that apply to it. Drop a `.json` template file on the
canvas to load it — a file that would replace a diagram with content in it asks first.

## Versioning

Documents carry a `version`, and `migrateTemplate` runs them up to `CURRENT_VERSION` through a
registered migration chain. A document from a **newer** build throws rather than being coerced —
silently dropping fields a future release added would turn "open an old client" into irreversible
data loss on the next save. `MIGRATIONS` is empty today; the hook exists so v2 has somewhere to
go.

## Known issue

`npm audit` reports 4 high advisories from `vite-plugin-dts` → `@vue/language-core` → `minimatch`.
These are DoS-only, build-time-only, and never reach the published bundle. Fixing them needs a
breaking downgrade of the `.d.ts` generator.
