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

That's 12 kB gzipped versus 92 kB for the full editor, and it's enforced by a test that walks
the import graph rather than trusted to a comment.

## Quick start

```bash
npm install
npm run dev        # example app on http://localhost:5173
npm test           # 332 tests
npm run build      # builds the library to packages/better-diagrams/dist
```

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
so it embeds in a panel, a modal, or a split view without fighting your layout.

### Props

| Prop | Type | Notes |
|---|---|---|
| `value` | `DiagramTemplate` | Controlled document. Pair with `onChange`. |
| `defaultValue` | `DiagramTemplate` | Initial document when uncontrolled. |
| `onChange` | `(t) => void` | Every committed edit, already validated. |
| `onSave` | `(t) => void \| Promise` | Shows a Save button; `⌘S` also triggers it. |
| `readOnly` | `boolean` | Hides editing affordances; pan/zoom/export still work. |
| `registry` | `RegistryExtensions` | Add node kinds, icons, exporters. See below. |
| `theme` | `Theme` | Overrides `--as-*` design tokens. `LIGHT_THEME` / `DARK_THEME` are complete presets — `theme={LIGHT_THEME}` flips the whole editor **and** its image exports (the export palette derives from the theme). |
| `generate` | `DiagramGenerator` | Enables the AI panel. Omitted ⇒ no network code runs. |
| `minimap` | `boolean` | Default `true`. |
| `welcome` | `boolean` | Default `true`. Shows the **welcome modal** over a brand-new document — see below. |
| `legend` | `boolean` | Infra legend in the corner. Default `true`; only renders when zones exist. |
| `defaultShowHidden` | `boolean` | Start with provider-hidden nodes ghosted rather than omitted. Default `false`. |
| `diffBase` | `DiagramTemplate` | Baseline to compare against: the canvas becomes a read-only diff view (added/removed/changed) while set. The toolbar's Compare button offers the same via a file picker. |
| `filename` | `string` | Base name for exports. Default `"architecture"`. |
| `files` / `activeFileId` / `onFileSelect` / `onFileCreate` / `onFileRename` / `onFileDelete` | `StudioFile[]`, callbacks | When `files` is provided the brand becomes a **file selector** (switch, ＋ new, ✎ rename, × delete). The host owns all storage — the editor only calls back. Both editors take these. **The file name and the document's `meta.title` are one title with two homes**: renaming the active file writes `meta.title` (committed, emitted, undoable), and a document title arriving any other way — AI generation, import, a controlled `value` — is pushed back out through `onFileRename`, so the dropdown always shows what exports will print. The sync is a reconciler, not two blind pushes: on a mismatch, *which side moved since they last agreed* decides — a title edit (including undo) renames the file, while a **host-side rename** (another tab, the host's own UI, a changed `files` prop) is adopted as the document's new title rather than being reverted; when both moved at once, the document wins. The editor can only do this for the document it holds; a host that stores the other documents should mirror renames into them too (the example app does). Set `StudioFile.empty` and a blank file deletes straight away; anything else asks for confirmation first. `onFileCreate` receives an optional `StudioFileInit` (`{ name?, kind?, doc? }`): the menu's ＋ New file passes nothing, the welcome modal passes a name and — when JSON was inserted — a validated document to seed the file with. |
| `removedFiles` / `onFileRestore` | `StudioFile[]`, `(id) => void` | Deleted documents the host still holds. The menu grows a **Recently removed…** entry opening a recovery modal. |
| `onNavigateFile` | `(ref) => void` | Fired when a node url with the `file:` prefix (e.g. `file:Order flow`) has its ↗ clicked — resolve by id, then name, and switch documents. |
| `onSelectionChange` | `(sel) => void` | The canvas selection in **document terms** — ids bucketed by template section (`{ nodes, edges, zones }` here; `{ participants, messages, activations, fragments, notes }` on the sequence editor), so a host can mirror it, e.g. highlight the matching entries of a live JSON view (the example app does exactly this). Fires on mount too, so a host that remounts per file never keeps a stale selection. |
| `toolbarExtras` / `inspectorExtras` | `ReactNode \| (ctx) => ReactNode` | Slots for your own controls. |

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
each styled in its provider's brand palette with a role-appropriate icon and silhouette
(databases are cylinders, queues are pipes).

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
inspector. On a selected edge, **drag an endpoint handle** to pin exactly where
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

Providers are registry-extensible like everything else:

```jsx
registry={{ providers: { fly: { label: "Fly.io", color: "#8b5cf6" }, aws: { color: "#ff9d2e" } } }}
```

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
`overdue`, `hazardInk`/`hazardTape`) and two record tokens — `edgeColors` and `seqAccents` —
that fan out to per-entry CSS variables (`--as-edge-sky`, `--as-seq-database`).
**`LIGHT_THEME` now retunes all of them**: the fixed edge and sequence palettes were picked for
the dark canvas (sky `#38bdf8` sits at ~2.2:1 on a light page) and darken to legible
counterparts in light mode, on canvas and in every export — the interactive HTML's scrubber
accent follows the page's luminance too.

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
    icons: { lambda: ["M4 4h6l7 16h3", "M20 4h-5L8 20H4"] },  // 24x24 viewBox paths
    exporters: { terraform: myExporter, pdf: null },
    promptExtraRules: "- This org runs on AWS; prefer lambda for compute.",
  }}
/>
```

A registered kind shows up in the inspector dropdown **and** in the generated system prompt, so
the model can emit it too. `example/src/extensions.js` demonstrates all of it.

## Exports

PNG, PDF, SVG, template JSON, Content/Layout JSON (the split — see above), React Flow JSON,
Mermaid, and C4-PlantUML ship built in. The
image formats render from one emitter: `emitTemplate(template, registry, palette)` produces a
backend-neutral command list that `renderTemplateToCanvas` and `renderTemplateToSvg` both
replay — through the **same** edge geometry the screen uses — so PNG, PDF, and SVG can never
disagree with each other or the editor. The `palette` (see `ExportPalette`, `DARK_EXPORT_PALETTE`,
`LIGHT_EXPORT_PALETTE`) recolours an export without touching its layout; the editor passes one
derived from the active `theme`, so a light-mode app exports light images automatically.

Image exports draw zones behind everything, honour the active provider selection (hidden nodes
and their edges are omitted, and the crop tightens to what's visible), and stamp the legend into
the corner so the file explains its own colours. Mermaid can't express overlapping regions, so it
records the active selection as `%% zone:` comments and reserves subgraphs for groups.

A custom exporter returns a blob to download, or nothing if it delivered the result itself:

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
| **Routing** — curved / right-angle / straight | `meta.routing` sets the diagram default (Arrange ▾ → connector picker); `edge.routing` overrides per edge. Right-angle elbows are rounded |
| **Flow-chart kinds** — `decision` (diamond), `terminator` (stadium), `io` (parallelogram) | Insert ▾ or the kind picker; Mermaid exports each by its shape |
| **Language models** — `lm-small`, `lm-medium`, `llm` | One hue at three strengths, so the weight class is legible at a glance: a 1B router never looks like a frontier model. Provider-neutral — name the model in `description` ("Phi-3 mini", "Claude Opus 5"); use a cloud's own kind (`azure-openai`, `aws-bedrock`, `gcp-vertex-ai`) when the box is the hosting *service* |
| **Collapsible groups** | ▾ on a group collapses it to a chip; contents hide, their edges re-route to the chip, and the stored size survives expand. Never destructive — collapse is view state that rides the undo stack |
| **Tags + filter** | `node.tags`; the View ▾ tag filter dims non-matching nodes — dim only, never hide, so the filter can't touch what persists |
| **Doc links** | `node.url` renders an ↗ affix (a real link in read-only) |
| **Team ownership** | `node.team` renders a tag riding the node's edge, coloured stably per team name (same hue on screen and in image exports); View ▾ → Show team badges toggles them while editing |
| **Lifecycle status** | `node.status`: `proposed` (dotted) / `planned` (dashed) / `stubbed` (heavy construction dashes + faint hatch — scaffolding with no implementation) / `dark` (black/white hazard-tape outline — built and shipped but not yet enabled) / `active` (default, never stored) / `deprecated` (dimmed, salmon status text sharpening to red on hover/selection) / `retired` (dimmed + struck through). Every dulled stage brightens to full strength under the cursor so its label stays readable. Same conventions in image exports; C4-PlantUML gets `$tags` |
| **Version tag** | `meta.versionTag` ("v2.1", "2026-Q3 draft") renders as a corner notice — `meta.versionTagPosition` picks the corner; click it to edit, View ▾ → Set version tag… to create one. Stamped into image exports |
| **Lock** | `node.locked` / zone lock pins an element against drags and resizes |
| **Search** | ⌘K, matches id/label/description/kind/tags, Enter cycles and centres |
| **Snap & align** | Arrange ▾: snap-to-grid, align left/centre/right/top/middle/bottom (2+ selected), distribute (3+) |
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
| Participants | `participants[]` — `kind` (actor/service/database/queue/external), `team`, `status` | Header row; drag horizontally to reorder columns |
| Messages | `messages[]` — `style` (sync/async/reply), `tech`, self-messages (`from === to`), lost/found (`null` endpoint) | Horizontal arrows; **drag a label up/down to reorder time**; drag between headers to connect |
| Activation bars | `activations[]` — anchored to message ids | **Press-drag on a lifeline to add one**, resize its ends, Delete to remove |
| Fragments | `fragments[]` — loop/alt/opt/par/break with else branches | Frames with operator tabs; wrap the selected messages via Insert ▾ |
| Notes | `notes[]` — side, anchor message | Dog-eared cards; drag to re-side/re-anchor |

The document stores **no coordinates**: participant column = array order, message time = array
order, and spans anchor to message *ids* — so inserting a message inside a `loop` grows the
loop, diffs stay structural, and the whole document maps 1:1 onto Mermaid/PlantUML. Exports:
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
**✦ Copy schema** button. On an architecture file that button opens the `SchemaCopyModal`
described above — which clouds and which of their resources the copied contract should teach,
seeded with the open document's own — rather than copying blind; sequence files have no
provider vocabulary to scope, so they copy straight to the clipboard.

**Auto-save to the repo, while developing.** `npm run dev` mounts a small dev-only route
(`example/vite-plugin-templates.js`) that writes every open file to `templates/` at the repo
root, one plain `.json` per document, debounced. Renaming a file renames the JSON and deletes
the old one; deleting a file deletes it. They are ordinary templates — the same shape Import
and the paste box accept — so you can diff them, commit them, hand-edit them, or drop new ones
in, and they all appear under **Settings ▾ → Saved templates** (re-read each time the menu
opens). The route exists only in the dev server: a built app finds nothing there and carries on
with localStorage, which is still the app's own source of truth.

**AI is optional, per editor.** Pass the same `generate` function the architecture editor takes
(`createProxyGenerator` works unchanged — the sequence system prompt travels with each request)
and the Sequence tab gains the ✦ AI panel: a context box for describing who participates, how
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

**Compare** diffs the live document against a baseline — `diffTemplates(base, current)` matches
by id and ignores pure moves/resizes, so the diff is about structure, not tidying. On screen,
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
toolbar's **⏱ Timeline** button appears as soon as one element is dated. The cursor is a
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

**Interactive HTML** (Export ▾ → Interactive HTML, both editors) writes one self-contained
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

**Copy / paste** (`⌘C` / `⌘V`) travel as template JSON through the system clipboard, so a
fragment pastes into another diagram or another tab. Descendants come along with a copied
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

**Duplicate** (`⌘D`, or the ⧉ button in the inspector) is different by design: it happens in
the same document, so it carries the selection's **direct connections** — internal lines clone
between the copies, and boundary lines re-attach their cloned end to the copy while keeping the
original neighbour (`duplicateWithConnections` in the contract).

**Zones** copy too, with subject/ride-along asymmetry: a zone that rides along because a copied
node references it is *reused* by id when pasting into the same diagram (pasting a node from
"Cloud Region" must not spawn a second region), but a zone you select and copy is a **subject**
— it brings its member nodes and their internal edges, and paste always clones it under a fresh
id, re-zoning the copied members into the clone. `⌘D` / ⧉ on a zone duplicates the whole region
with its members and mirrors their boundary connections.

**Show hidden nodes** (View ▾) ghosts the nodes the active provider hides, so they stay
selectable and editable instead of being unreachable. Ghosts never appear in exports — an export
shows the active scenario.

The toolbar groups its actions into four dropdowns — **Insert** (node/group/text/zone),
**Arrange** (tidy, align, distribute, routing, snap), **View** (ghosts, tag filter), and
**Export** — all sharing one open-menu slot, so opening one closes the rest and a click
anywhere else closes them all. The inspector reads as captioned sections (Node · Style · On ·
Tags · Link) instead of an unbroken run of inputs.

## Keyboard

Press **`?`** for the full sheet (also in View ▾). Bindings follow Excalidraw's conventions
wherever this editor has the same concept, so muscle memory carries over.

| | |
|---|---|
| **Essentials** | `⌘Z` undo · `⇧⌘Z` redo · `⌘S` save · `⌘A` select all · `Delete` remove selection (cascades into groups) · `Esc` close panels, then leave a drilled level |
| **Clipboard** | `⌘C` · `⌘V` · `⌘X` cut · `⌘D` duplicate with connections · `⌥`-drag to drag a copy and leave the original |
| **Insert** | `N` node · `G` group · `T` text note · `Z` zone — all land at the canvas centre, exactly as the Insert menu does |
| **Arrange** | `←↑→↓` nudge 1px · `⇧`+arrows nudge 10px · `⌘⇧`+arrows align · `⌘G` wrap the selection in a container · `⌘⇧G` ungroup · `⌘⇧L` lock |
| **View** | `⌘=`/`⌘-`/`⌘0` zoom · `⇧1` fit · `⇧2` fit selection · `⌘'` snap to grid · `⌘K` search · `⌘⇧E` export PNG · `Space`-drag pan |
| **Timeline** | `←`/`→` step between stops, while scrubbing with nothing selected |

Three places the conventions could not be copied verbatim, and why:

- **`⌘K` is search, not link.** It predates this, is advertised in the search field, and works
  from inside any input. Links take `⌘⇧K`.
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
`M` message, `T` note, plus the essentials and zoom); its `?` sheet lists only those.

Mouse: drag from a node edge to connect. Drop a node onto a group to nest it, drag it out to
un-nest. Drag an edge label along its curve to slide it, or away from the curve to bend the line
itself. Drop a `.json` template file on the canvas to load it.

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
