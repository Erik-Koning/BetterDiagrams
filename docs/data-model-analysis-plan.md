# Data-model analysis: plan and specs

Status: **implemented** 2026-09-30 (proposal 2026-09-29) · scope: the architecture editor
(`ArchitectureStudio`), the contract (`@mosphere/better-diagrams/contract`), and the interactive
HTML export. See [Implementation status](#implementation-status) for what shipped where, and
where it departs from the specs below. The README's *Data-model analysis* section is the user
documentation.

## Implementation status

| | Contract | Editor | HTML export | Notes |
|---|---|---|---|---|
| G1–G6 | `fields.ts` (`storageType`, `nullable`, `description`, `cachedFieldRecords`), `lint.ts` (`fields`, `fix`), `lint-ignore.ts`, `csv.ts` | `analysis-sidebar.tsx` (one hook, one mask) | slice extended, parity test | — |
| F1 consistency | `key-usage.ts`, `type-families.ts` | Key usage: mixed badge, *Inconsistent only*, ways stored | bundled | — |
| F2 checks | `data-model-lint.ts` | Checks panel, Ignore, Fix | precomputed findings (capped at 5,000) | — |
| F3 impact | `impact.ts` | `ImpactPanel` | bundled | — |
| F4 SQL | `route-sql.ts` | SQL per route/key | bundled; dialect in `localStorage` | — |
| F5 schema compare | `schema-diff.ts` | `SchemaChangesPanel`, *Schema change report (HTML)* exporter | report is its own self-contained page | — |
| F6 structure | `structure.ts` — one `modelStructure()` + `summarizeStructure()` instead of four functions | `StructurePanel`, domain tint | precomputed `structure` | *Create groups from domains* became **Select** per domain + `⌘G`: wrapping scattered tables in frames at once would overlap them. |
| F7 neighbourhood | `graph.ts` `direction` | `NeighbourhoodPanel` | bundled | — |
| F8 governance | `dictionary.ts` | `GovernancePanel`, dictionary exporters | precomputed report; dictionary CSV written in the page | adds `untaggedFlows` (sensitive values reaching untagged columns through lineage) |
| F9 saved analyses | `analyses.ts`; `DiagramTemplate.analyses`; folder `overrides.json` | Save… in panels, **Analyses** menu, drift, ref `getAnalyses`/`openAnalysis` | Analyses panel (re-run in the page), `#/<level>?a=` links | No `localStorage` persistence of reader-made analyses — the link is the way to keep one. Key coverage opens read-only in the page. |
| F10 lineage | `lineage.ts`, `lineage-links.ts`; `DiagramTemplate.lineage`; folder `overrides.json` | *Import lineage…* (OpenLineage), *Trace lineage*, `LineagePanel`, row-to-row overlay (`LineageOverlay`) | bundled trace, overlay lines from row geometry | Assumptions below. |

**Follow-up (2026-10-01), from an audit at 1,000 tables:**

- **Domains:** tables joined to at least `max(10, 5%)` of the model are set aside as *shared*
  before clustering, and Louvain replaced label propagation. On 50 clusters plus two hub tables
  this goes from 1 domain to 50, each exactly one cluster, at modularity 0.98. A split no better
  than one domain falls back to one domain per connected piece.
- **Checks:**
  - `no-cycles` skips key lines (field-anchored, or with a `relation`).
  - `dm-key-type-mismatch` uses `keyResolver` (indexed) instead of scanning per reference.
  - All checks: 127 ms → about 15 ms per edit at 1,000 tables.
- **Loading a schema:** `importSqlDdl` (Postgres, MySQL, SQL Server, Snowflake, BigQuery,
  SQLite) and `importDbt` (manifest plus optional catalog), both through `buildTableModel`, into
  an editable document. Statements that aren't about tables are counted by kind rather than
  warned about one by one.
- **Data statistics:** `data.model.profile` / `forensics.json` → `dataProfile` gives
  `FieldRecord.profile`, grid and dictionary columns, and three declared-versus-observed checks.
- **Sensitivity hints:** `sensitivityHints` feeds `dm-untagged-sensitive` (with a `tag-field`
  fix) and `GovernanceReport.suggested`.
- **Lineage polish:**
  - Stale columns are marked "not in the model".
  - Editor lineage lines reach folded tables through `canvasReps`.

**Tested on real schemas (2026-10-02):** Sakila (Postgres, MySQL, SQL Server, SQLite scripts),
Pagila's `pg_dump`, Microsoft's AdventureWorks. This found and fixed:

- **SQL reader:**
  - a table swallowed when SQL Server omits `GO`;
  - later constraints in a comma-separated `ADD` dropped;
  - positional `MS_Description` arguments not read;
  - a byte-order mark;
  - `DELIMITER` blocks;
  - temporary tables made inside procedures;
  - partitions as separate tables (now folded into the parent, with their keys).
- **Domains:** the fixed degree threshold set aside AdventureWorks' `Product`, a domain
  centre. Shared tables are now recognised by how their keys spread across domains (5+
  neighbours, 3+ domains, none holding half; pieces that exist only around the table count as
  its home). Agreement with AdventureWorks' own schemas went from 80% to 87%, and the 50-cluster
  test model still splits exactly.
- **Sensitivity:** names must end with the personal word; `account_number` dropped; key columns
  included; credentials added. Precision on AdventureWorks went from 12 of 16 to 14 of 14.

**F10 assumptions** (the plan left these open): lineage is stored in the same document as its
own validated collection; OpenLineage `columnLineage` is the one importer (dbt and warehouse
APIs are left to a host adapter emitting OpenLineage-shaped JSON); datasets match tables by
entity name, label or id, also by the last dotted segment; a column the table does not list is
kept under the name the event gave; an import merges by link id (a re-import replaces, never
duplicates); a folder document keeps lineage in `.better-diagrams/overrides.json`, so a folder
re-import and a lineage import never overwrite each other. Impact over lineage is the trace's
downstream direction; sensitive propagation is `sensitiveLineage` (shown in Governance).

This document plans the next ten data-model analysis features — what an enterprise data
architect or analyst expects from a model explorer — with a spec for each, the shared
groundwork they need, and, for every feature, what the **interactive HTML export** needs so
the exported page keeps parity with the editor.

## Contents

1. [Where we are](#1-where-we-are)
2. [Principles](#2-principles)
3. [How the HTML export works, and the rules for adding to it](#3-how-the-html-export-works-and-the-rules-for-adding-to-it)
4. [Shared groundwork](#4-shared-groundwork)
5. Feature specs
   - [F1 Field consistency in Key usage](#f1-field-consistency-in-key-usage)
   - [F2 Data-model checks](#f2-data-model-checks)
   - [F3 Impact analysis](#f3-impact-analysis)
   - [F4 SQL from a route](#f4-sql-from-a-route)
   - [F5 Column-level schema compare](#f5-column-level-schema-compare)
   - [F6 Hubs, bridges and domains](#f6-hubs-bridges-and-domains)
   - [F7 Neighbourhood focus](#f7-neighbourhood-focus)
   - [F8 Data dictionary and governance](#f8-data-dictionary-and-governance)
   - [F9 Saved analyses](#f9-saved-analyses)
   - [F10 Column lineage](#f10-column-lineage-design-only)
6. [Sequencing](#6-sequencing)
7. [Risks](#7-risks)
8. [Definition of done](#8-definition-of-done)

---

## 1. Where we are

| Capability | Where | Notes |
|---|---|---|
| Field records (rows ∪ data-bag fields) | `contract/fields.ts` — `fieldRecords`, `documentFieldRecords`, `dataFields`, `edgeFieldIds` | One definition of "a field" and of "an edge is anchored at a field". No `description`, no raw storage type (a reference's `type` reads `→ Account`), `required` only (no tri-state nullability). |
| Keys and references | `keyFields`, `referencedKey`, `referencesTo`, `keyReferences`, `keysBetween` | References panel (`ReferencePanel.tsx`), row menu. |
| Graph search | `contract/graph.ts` — `shortestPath(s)`, `allSimplePaths`, `neighbourhood`, `fieldPaths`, `between`, `reachableFrom`, `keyFrequency` | `neighbourhood` has no UI. `GraphOptions` has `undirected` but no `direction: "in"`. |
| Paths between pins | `react/field-routes.ts` (`computeRouteView`, `litRoutes`), `FieldPathPanel.tsx` | Routes, hop keys, keys most routes use, keys joining pins, corridor. |
| Key coverage | `contract/coverage.ts`, `CoveragePanel.tsx` (right side) | Per-table keys, reach over their lines, minimal key cover. |
| Key usage | `contract/key-usage.ts`, `KeyUsagePanel.tsx` (left sidebar) | Field names across tables, share of tables, any/all, targets. |
| Relationship kinds, cardinality | `contract/relations.ts` (`RELATION_KINDS`), `contract/geometry.ts` (`cardinalityMarker`), `contract/junctions.ts` | Composition/aggregation/reference/hierarchy/polymorphic/generalization. |
| Checks | `contract/lint.ts` (`lintTemplate`, `BUILTIN_LINT_RULES`) | Architecture rules only: `no-orphans`, `no-cycles`, `external-data-access`, `missing-owner`, `unlabeled-cross-team`, `deprecated-dependency`. Findings name nodes/edges, not fields. |
| Compare | `contract/diff.ts` (`diffTemplates`), `DiffCanvas.tsx` | Matches by id; a changed table reports `fields` as ONE changed property — not which columns. |
| Data-model import | `contract/folder/dialects/datamodel/*` | Nodes: `data.model.{shape,name,label,kind,namespace,recordCount,fieldsTotal,fieldsTruncated,fields[],fieldMeta,...}`. Edges: `relation` + `data.model.{field,targetField,kind,relationshipName,referenceTo,required,cascadeDelete,deleteConstraint,visible,business}`. Field data: `type`, `displayType`, `primaryKey`, `nullable`, `unique`, `externalId`, `formula`, `visible`, `createable`, `updateable`, `tags`, `relationship`. Tables past `MAX_NODE_FIELDS` are truncated (`fieldsTruncated`). |
| Interactive HTML export | `react/html-export.ts`, `react/html-explorer.ts`, `react/html-explorer-runtime.ts` (bundled to `html-explorer-runtime.generated.ts`), `exporters.ts` (`htmlExplorerData`) | Search, pins, paths, references, key usage, field grid, menus — the editor's own analysis, bundled. See §3. |

The gaps an expert notices first: Checks says nothing about schema quality; Compare cannot
say which columns changed; nothing answers "what breaks if I change this?"; there is no
dictionary/governance output; analyses cannot be saved or shared.

---

## 2. Principles

These are the codebase's existing rules, restated because every feature below leans on them.

1. **Contract first.** Every analysis is a pure, zero-dependency function in `src/contract/`
   over the structural slice it needs (`FieldDocument` / `GraphDocument`), with its own unit
   tests. React panels and the HTML page are presentation over it.
2. **One definition.** "A table" is `storesFields` (coverage.ts). "A field" is a
   `FieldRecord`. "Anchored at a field" is `edgeFieldIds`. "What stands for a node on this
   level" is `representatives` (path-view.ts). New features reuse these, never restate them.
3. **View state is not document content.** Pins, picks, panel state and masks never enter
   the document, undo, or `onChange`. They are mirrored to hosts (ref methods + `on…Change`
   props), like `getPins`/`onPinsChange`. The one deliberate exception proposed here is
   *saved* analyses (F9), which are content by choice.
4. **Honest results.** Anything bounded says so (`truncated`), anything inferred says so
   ("possible rename", "looks like a reference"), and tables whose field list was truncated
   by the importer (`data.model.fieldsTruncated`) are reported as incomplete, never silently
   counted as complete.
5. **Scale.** Target models: 1,000+ tables, 50k+ fields. Anything that runs on every commit
   (lint) must be linear in fields + edges and memoised per template. Anything search-like is
   budgeted and reports truncation.
6. **Left sidebar.** Analysis panels live in the left sidebar slot (`.as-panel`), one at a
   time, closing each other (see `openUsagePanel` in `ArchitectureStudio.tsx`). Key coverage
   is the one right-side panel; it closes Key usage when opened and vice versa.

---

## 3. How the HTML export works, and the rules for adding to it

Read this before touching the export side of any feature.

### 3.1 The moving parts

- **`htmlExplorerData(template, registry, palette)`** (`exporters.ts`) builds what the page
  reads (`HtmlExplorerData` in `html-explorer.ts`):
  - `doc` — a **slice** of the document from `explorerDocument()`: node id/label/kind/
    description/tags/parentId/fields, and from `data` only
    `model.{fields,fieldMeta,shape,name}` and `fields`; edges id/source/target/direction/
    startField/endField and `data.model.{field,targetField}`. Everything else in a `data`
    bag is deliberately left out of a file that may be mailed around.
  - `levels` — per page level (`""` root + one per drillable node), what that level's SVG
    draws (`drawnElements` in draw.ts): node ids and `[edgeId, source, target]` as drawn.
  - `homes` — `focusPath` per nested node, for "go to the level that shows it".
  - route colours and the highlighter colour.
- **The runtime** (`html-explorer-runtime.ts`, `mountExplorer(doc, data)`) is plain DOM,
  bundled by `scripts/build-explorer-runtime.mjs` (Vite lib/IIFE, minified) into
  `html-explorer-runtime.generated.ts`. It imports contract code directly — that is the
  whole point: the page runs the editor's analysis, not a copy.
  - **Freshness:** the generated file records its input modules and a sha256 of them;
    `html-explorer.test.ts` fails while it is stale. After editing any input, run
    `npm run build:explorer -w @mosphere/better-diagrams`.
  - **Size:** ~53 KB today (9 modules). `DIAGRAM_SYSTEM_PROMPT` is `/* @__PURE__ */` so the
    prompt text tree-shakes out — keep top-level contract statements pure or annotated.
- **Page chrome:** `html-export.ts` composes CSS/markup hooks from `html-explorer.ts`
  (`explorerCss`, `explorerSearchMarkup` incl. `#bd-usagebtn`, `explorerStripMarkup`,
  `explorerOverlayMarkup`, `explorerMenuMarkup`, `explorerScripts`). The multi-level page
  adds a navigator; explorer ↔ navigator talk by events (`bd:show` out, `bd:view` back).
- **Runtime conventions** (html-explorer-runtime.ts):
  - One left sidebar `#bd-panel`; `state.panel` is the union of panels
    (`"paths" | "refs" | "usage"` today); `renderPanel()` routes to `render…()`.
    While it is open the body carries `bd-x-sidebar` and the stage reserves its width.
  - `paint()` redraws marks on the current level: dim masks (`bd-x-dim`), row marks
    (`bd-x-match`), rings, route overlays (`data-route`) and key badges. A mask is a set of
    **document** node ids widened to stand-ins with `keptOnCanvas`.
  - `navigate(id)` switches level if needed, selects, reveals; `setMarks()` marks rows.
  - Menus: `nodeMenu`, `fieldMenu` (row click / right-click). Escape chain in the window
    capture listener. Clipboard via `copy()` (with `execCommand` fallback). Downloads via
    Blob + `a[download]` (works on `file://`).
- **Tests:** `html-explorer.test.ts` (data, slice parity, freshness, page composition),
  `html-explorer-page.test.ts` (writes the real exported page into a jsdom iframe and runs
  its own scripts — `openPage()` helper), e2e in `e2e/fields.spec.ts` (export from the
  example app, open the file in Chromium).

### 3.2 Rules for adding a feature to the page

1. **Precompute or bundle?**
   - **Precompute at export time** when the answer needs no reader input (checks, hubs,
     domains, governance summary, dictionary), when it depends on **host functions** (a
     host's `registry.lintRules` are functions — they cannot be bundled into the page), or
     when the result is small. Put it on `HtmlExplorerData` and render it.
   - **Bundle** when the answer depends on what the reader picks (a subject table, a route,
     a depth) and precomputing every input would be quadratic or worse (impact from every
     table, SQL for every route). Import the contract function in the runtime and rebuild.
2. **New document data → extend the slice** in `explorerDocument()` and extend the parity
   test ("answers every question the analysis asks the same as the whole document") so the
   slice can never drift from what the contract reads. Keep the "only what analysis reads"
   rule; never copy whole `data` bags.
3. **UI:** add a `state.panel` variant, a `render…()` function, an entry point (header
   button hidden when not applicable, node/field menu item, or ⋯ menu), a mask function
   consulted by `paint()`, and an Escape-chain entry. One panel at a time.
4. **Keep formatting shared.** A React panel and the page's DOM panel for the same analysis
   must say the same thing. Put label/summary/format helpers (e.g. "44% · 4 of 9 tables",
   variant summaries, badge text) in a pure module both import, not in two copies.
5. **Budgets.** Add a size assertion test (`EXPLORER_RUNTIME.length < 120_000`) before the
   bundle grows past ~80 KB; watch the embedded JSON for large models (a 300-table model
   exports at ~2 MB today, most of it SVG).
6. **No network, no dependencies.** No CDN, no d3, no CodeMirror in the page. `clipboard`,
   `localStorage` and downloads are wrapped in try/catch and degrade quietly.
7. **Test it the way it ships:** a jsdom page test via `openPage()` and an e2e step.

---

## 4. Shared groundwork

Do these first; several features depend on them.

### G1 Richer field records — `storageType`, `nullable`, `description`

`FieldRecord` (fields.ts) gains:

```ts
interface FieldRecord {
  // …existing
  /** The stored type as the source names it — never the reference arrow ("→ Account"). */
  storageType?: string;
  /** Tri-state: true/false when the source said, absent when it didn't. */
  nullable?: boolean;
  /** The field's documentation, when the source carries it. */
  description?: string;
}
```

- `storageType`: data field `type` (not `displayType`) when present; else a row's `type`
  unless it is a display arrow (`/^→/`).
- `nullable`: data field `nullable`; else `!row.required` only when the row says `required`.
- `description`: add `description?: string` to `DataField` coercion (`coerceDataField`) and
  to `NodeField` (schema + `validateTemplate` + the LLM prompt's field section). The
  datamodel importer maps `description`/`inlineHelpText` into it.
- Hint: purely additive; `fieldRecords` callers are unaffected. Extend
  `field-records.test.ts`. The HTML slice already carries `data.model.fields` whole, so
  descriptions ride along once the importer writes them; rows need nothing new.

### G2 Field-level findings

`LintIssue` (lint.ts) gains `fields?: FieldRef[]`. The studio's `jumpToFinding` marks those
rows (`setHighlightFields`) after navigating. Field tags honour `lint-ignore` /
`lint-ignore:<rule>` the way node tags do (`lintIgnored`). A finding may also carry
`fix?: { label: string; kind: string; payload: unknown }` that only the editor acts on (F2).

### G3 One active analysis mask

The studio currently chains masks: `coverageMask ?? usageMask ?? routeView?.keep`. With
impact, neighbourhood, structure and checks, generalise to one value computed from the
active sidebar panel:

```ts
interface AnalysisMask { keep: ReadonlySet<string>; keepEdges: ReadonlySet<string> | null }
```

Each panel exposes `mask(): AnalysisMask | null`; `dimmedIds`/`routeKeepEdges` read the
active one (coverage still wins while open, as today). Mirror this in the runtime: one
`activeMask()` consulted by `paint()` instead of per-feature branches.

### G4 Table export helper

`field-grid.ts` has `toCsv(records, cols)` for field records. Generalise to
`toCsvRows(header: string[], rows: string[][])` (RFC 4180, CRLF) in a contract-level module
so every panel ("tables using them", impact list, findings, dictionary) downloads the same
way — in the editor via the host `download` hook, in the page via Blob.

### G5 Export slice extensions

Features F3/F4/F8/F9 read document data the slice drops today. Add, in one change, with the
parity test extended:

| Where | Add | Needed by |
|---|---|---|
| edge | `relation`, `startLabel`, `endLabel` | F3 cascade by kind, F4 cardinality |
| edge `data.model` | `kind`, `required`, `cascadeDelete`, `deleteConstraint`, `relationshipName`, `referenceTo` | F3, F4, F2 (precomputed anyway) |
| node | `team`, `status` | F8 owners, F2 messages |
| node `data.model` | `label`, `namespace`, `recordCount`, `fieldsTruncated` | F4 table names, F6 weighting, F8, honesty (§2.4) |
| document | `analyses` (F9) | F9 |

### G6 Memoised whole-document records

`documentFieldRecords(doc)` is linear, but checks run on every committed edit and several
panels read it. Cache it per template identity (`WeakMap<DiagramTemplate, Map<…>>` in the
studio, or a tiny memo inside fields.ts keyed on the `nodes`/`edges` array identities) so a
commit computes it once for all consumers.

---

## F1 Field consistency in Key usage

**Size:** S · **Depends on:** G1

### Problem

The same column name with different types or nullability across tables — `tenant_id` as
`uuid` in 40 tables and `varchar(36)` in 2 — breaks joins, forces implicit casts, and is
the most common silent defect in enterprise schemas. Key usage already groups by name; it
should say when a name is inconsistent.

### User stories

- "Show me every field name that has more than one type."
- "For `tenant_id`, which tables deviate, and how?"
- "Is `created_at` nullable everywhere?"

### Behaviour (editor)

- Results and picked bars show a **mixed** badge when a name has more than one type family
  or mixed nullability; hover title lists the variants.
- A picked name expands (disclosure) to its **variants**: `uuid · 40 tables`,
  `varchar(36) · 2 tables`, `untyped · 1 table`. Clicking a variant dims the canvas to those
  tables and lists them.
- New checkbox **Inconsistent only** beside *Keys only*.
- Panel footer line when inconsistencies exist: "7 names have inconsistent types — show".

### Contract

```ts
// contract/key-usage.ts
export interface FieldVariant {
  /** Normalised family ("varchar"), or "untyped". */
  family: string;
  /** The spellings seen, e.g. ["VARCHAR(36)", "varchar(36)"]. */
  types: string[];
  nullable: boolean | "mixed" | "unknown";
  tables: Array<{ nodeId: string; fieldId: string }>;
}
export interface FieldUsage {
  // …existing
  variants: FieldVariant[];
  /** One type family and one nullability across every table that states them. */
  consistent: boolean;
}
export function normalizeType(raw: string, aliases?: Record<string, string>): { family: string; params?: string };
export function searchFieldUsage(index, query, opts: { keysOnly?: boolean; inconsistentOnly?: boolean });
```

- `normalizeType`: lowercase, trim, collapse whitespace, split `name(params)`; an alias map
  folds synonyms (`int|integer|int4→integer`, `bool→boolean`, `timestamptz→timestamp with
  time zone`, `string|text|varchar→text` only when the host opts in). Default consistency
  compares **families**; option `strict: true` compares params too (`varchar(36)` vs
  `varchar(255)`).
- Untyped fields never make a name inconsistent; they are shown as `untyped`.
- Reference fields compare their own storage type (G1), not the `→ Target` display.

### Edge cases

Truncated tables (fieldsTruncated) → variant counts marked "at least"; case-variant names
(`AccountId`/`accountid`) already group — show spellings in the variant tooltip.

### Tests / acceptance

- normalizeType table tests (params, aliases, whitespace, case).
- `fieldUsage` variants on a fixture with deliberate drift; `inconsistentOnly` search.
- Panel test: mixed badge, variant disclosure, variant click dims.

### HTML export

- **Bundle:** nothing new — `key-usage.ts` is already in the runtime; variants come with it.
  Rebuild the runtime.
- **Slice:** already carries `data.model.fields[].type/nullable` and row `type`; G1 is the
  only prerequisite.
- **Page UI:** extend `fillUsage()` in the runtime with the mixed badge, variant disclosure
  and *Inconsistent only* checkbox. Put the variant summary strings in a shared formatter
  (§3.2 rule 4) so KeyUsagePanel.tsx and the page agree.
- **Tests:** add a case to the `describe("key usage")` block in `html-explorer-page.test.ts`.

### Open questions

Should the alias map be registry-configurable (`registry.typeAliases`) so a Snowflake shop
and a Postgres shop get different folding? Recommended: yes, with a sensible default.

---

## F2 Data-model checks

**Size:** M · **Depends on:** G1, G2, G6 (and F1's `normalizeType`)

### Problem

Checks today are architecture rules. A data reviewer needs schema-quality findings, each
one clickable to the table and the row.

### Rules

All rules consider tables only (`storesFields`), so architecture documents get no noise.
Ids are namespaced `dm-…`. Each finding carries `nodeIds` and, where it concerns a column,
`fields` (G2).

| Id | Default | Detects | Notes / hints |
|---|---|---|---|
| `dm-no-primary-key` | warning | A table with no `pk`/`pfk` field record | Composite keys (`pfk`) count. Views/enums are not tables already. |
| `dm-undeclared-reference` | warning | A field shaped like a reference (`<stem>_id`, `<Stem>Id`, `<stem>_fk`; patterns configurable) whose stem resolves to a table (entity name via `nameIndex`, label, or id; singular/plural- and case-insensitive) and whose record has no `fk` targets | Skip the table's own key (`customers.customer_id` when it is the PK). **Quick fix (editor):** "Draw reference" → one commit adding an edge with `startField`/`endField` (target key via `referencedKey`) and `relation: "reference"`. |
| `dm-key-type-mismatch` | error | A reference's `storageType` family ≠ the family of the key it lands on (`referencedKey`) | Skip when either side is untyped. |
| `dm-unresolved-reference` | warning | `relationship.referenceTo` names nothing in the model and no edge draws it | Edges into external stubs (`shape: "external"`) are **info**: "points outside the model". |
| `dm-optional-composition` | warning | A composition (edge `relation` or `data.model.kind`) whose key is nullable (`data.model.required === false` or field `nullable`) | A composed child must name its parent. |
| `dm-duplicate-name` | warning | Two fields in one table whose names differ only by case/underscores (`AccountId`, `account_id`) | |
| `dm-inconsistent-type` | info | F1's inconsistency, one finding per name listing the deviating tables | Reuses `fieldUsage`. |
| `dm-polymorphic-reference` | info | A reference with more than one target (`referenceTo.length > 1`) | Joins need a discriminator (feeds F4). |
| `dm-truncated-fields` | info | `data.model.fieldsTruncated` | "Analyses on this table see only the first N fields." |
| `dm-naming` | off by default | Table/column names that break a configured convention, or (majority mode) the model's own majority convention | Org-specific: opt-in via factory options. |

Island tables are already reported by `no-orphans` (it checks every leaf node, and a table
is a leaf) as "has no connections". Check that the two rule sets never double-report; if
that wording is wrong for tables, let `no-orphans` skip tables and add `dm-island-table` with
the data wording ("no key points in or out").

### Configuration

```ts
export function dataModelLintRules(opts?: {
  referencePatterns?: RegExp[];          // default: /_id$/i, /Id$/, /_fk$/i
  typeAliases?: Record<string, string>;  // shared with F1
  naming?: { table?: RegExp; column?: RegExp } | "majority";
  severity?: Partial<Record<string, LintSeverity | "off">>;
}): Record<string, LintRuleDef>;
```

`BUILTIN_LINT_RULES` includes the defaults; hosts override through `registry.lintRules`
exactly as today.

### UI (editor)

The Checks dropdown cannot hold 800 findings. Add a **Checks panel** in the left sidebar
(opened from the Checks menu's "Show all" and automatically when count > ~20): grouped by
rule with counts, severity filter chips, search box, each finding a jump (navigate + mark
rows), per-finding "Ignore" (adds `lint-ignore:<rule>` to the node or field tags — one
commit) and quick fix when present, and **Download CSV** (G4).

### Performance

Lint runs on every committed edit. Every rule must be O(fields + edges) over one cached
`documentFieldRecords` (G6); the undeclared-reference stem lookup is one prebuilt map of
normalised table names. Budget: < 30 ms on 1,000 tables / 50k fields.

### Tests / acceptance

One fixture per rule (positive and negative), ignore tags on nodes and fields, severity
overrides, the quick fix producing a valid edge, a perf test on a synthetic 1,000-table model
(skip in CI if flaky; assert linear growth instead).

### HTML export

- **Precompute**, don't bundle: `lintTemplate(template, registry.lintRules)` at export time
  (host rules are functions and can't run in the page) → `HtmlExplorerData.findings:
  LintFinding[]` (with `fields`). Cap at ~5,000 with a `findingsTruncated` count.
- **Page UI:** a **Checks (N)** header button (hidden when N = 0) → `state.panel = "checks"`
  panel grouped by rule, severity filter, search, each finding a jump using the existing
  `navigate()` + `setMarks()`; Download CSV via Blob. No quick fixes or ignores (the page
  cannot write the document).
- **Mask:** none by default; optional "dim to tables with findings" toggle via G3.
- **Tests:** page test that a precomputed finding renders, jumps and marks its row.

### Open questions

Default severity of `dm-undeclared-reference` on legacy schemas can be very noisy — ship as
warning, or info with a count summary? Recommended: warning, grouped, with the quick fix.

---

## F3 Impact analysis

**Size:** M · **Depends on:** G3, G4, G5 (export)

### Problem

"Can we drop `Account.Id`?" / "What depends on `Orders`?" The references panel answers one
hop; analysts need the transitive answer, including what a delete would cascade into and
what would block it.

### Semantics

- An FK edge `source → target` means **source depends on target**.
- **Dependents** of T: tables with a key path leading to T (walk edges in reverse).
  **Dependencies** of T: walk forward.
- A **field subject** (`T.Id`) restricts the **first hop** to edges landing on that field
  (`edgeFieldIds(e).end`, or the implicit key — same rule as `referencesTo`); later hops are
  table-level.
- **Cascade:** an edge cascades when `data.model.cascadeDelete` is true or its kind is
  `composition`. The cascade set is what is reachable over cascading edges only ("deleting a
  Customer deletes Orders → OrderLines").
- **Blockers:** edges with `data.model.deleteConstraint` of `restrict`/`no action` block a
  delete of the subject; list them.
- `via: "keys"` (default) walks only key edges; `via: "all"` includes non-key lines
  (architecture edges) for mixed documents.

### Contract

```ts
// contract/impact.ts
export interface ImpactOptions {
  direction?: "dependents" | "dependencies";   // default dependents
  maxDepth?: number;                           // default unbounded (linear anyway)
  via?: "keys" | "all";
  isTable?: (n: FieldDocument["nodes"][number]) => boolean;
}
export interface ImpactNode {
  id: string;
  depth: number;
  /** The first (shortest) hop that reached it — the "why". */
  via: { edgeId: string; from: string; field?: string };
  cascade: boolean;      // reached over cascading edges only
  required: boolean;     // the key on its via hop is required
}
export interface ImpactResult {
  subject: Pin;
  nodes: ImpactNode[];           // BFS order
  byDepth: string[][];
  edges: string[];
  cascade: string[];
  blockers: Array<{ edgeId: string; from: string }>;
  outsideModel: string[];        // external stubs reached
}
export function impactOf(doc: FieldDocument, subject: Pin, opts?: ImpactOptions): ImpactResult;
/** The chain from the subject to one impacted table, for highlighting. */
export function impactChain(result: ImpactResult, nodeId: string): GraphWalk;
```

BFS over a reversed adjacency (G-hint: add `direction?: "out" | "in" | "both"` to
`GraphOptions` in graph.ts rather than building a second adjacency builder). Record the first
`via` per node; `impactChain` walks `via` back to the subject. Cycles (hierarchies,
self-references) are handled by the visited set; a self-reference is reported once as such.

### UI (editor)

- Entry: node menu **Show impact**, field menu **Show impact** (on keys), ref
  `openImpact(subject)`.
- Left sidebar **Impact** panel: subject chip (jump), direction segment
  (Dependents/Dependencies), depth (1 · 2 · 3 · All), *Keys only* toggle; headline
  "23 tables depend on Account.Id — 4 by cascade, 2 blockers"; list grouped by depth, each
  row "Contact · via Contact.AccountId" with cascade/required badges; hovering a row lights
  its chain as a transient path (`walkToPath` + `buildPathGlowIndex`, bright); canvas dims to
  the impacted set (G3); Download CSV.
- View state mirrored like the others (`getImpact`/`onImpactChange` if hosts need it).

### Tests / acceptance

Fixture with a hierarchy (self-reference), a cascade chain, a restrict blocker, a polymorphic
reference, an external stub; field vs table subject; direction; depth caps; chain
reconstruction; panel test for dimming and chain highlight.

### HTML export

- **Bundle** `impactOf`/`impactChain` (pure BFS; graph.ts is already in the bundle).
- **Slice (G5):** edge `relation`, `data.model.{kind,required,cascadeDelete,deleteConstraint}`.
- **Page UI:** `state.panel = "impact"`; node menu and field menu get **Show impact**
  (`nodeMenu()`/`fieldMenu()` in the runtime); panel mirrors the editor's; chain hover uses
  the existing route overlay painter — **refactor `paint()`'s route block into
  `paintWalks(walks, { bright })`** so routes and impact chains share it.
- **Mask:** impacted set via G3's `activeMask()`.
- **Tests:** page test — show impact on a table, depth change, chain overlay present.

---

## F4 SQL from a route

**Size:** S–M · **Depends on:** G5 (export)

### Problem

Analysts found the route; now they need the query. Routes already carry each hop's key; the
join chain is mechanical — except fan-out, which is where analysts get burned.

### Contract

```ts
// contract/route-sql.ts
export type SqlDialect = "ansi" | "postgres" | "snowflake" | "bigquery" | "mysql" | "tsql";
export interface RouteSqlOptions {
  dialect?: SqlDialect;                 // default ansi
  join?: "inner" | "left" | "auto";     // auto: INNER when the key is required and the hop walks child→parent, else LEFT
  aliases?: "short" | "table";          // t0,t1… or table-initials, deduped
  select?: "star" | "keys";             // t0.* or each table's key
  tableName?: (node) => string;         // default: data.model.name ?? label ?? id
}
export interface RouteSqlWarning {
  hop: number;
  kind: "fan-out" | "double-fan-out" | "polymorphic" | "no-key" | "untyped-join";
  message: string;
}
export function routeSql(doc: FieldDocument, walk: GraphWalk, opts?: RouteSqlOptions): {
  sql: string;
  warnings: RouteSqlWarning[];
  tables: Array<{ alias: string; nodeId: string; table: string }>;
};
```

- Each hop: edge `e` between `walk.nodes[i]` and `walk.nodes[i+1]`; condition from
  `edgeFieldIds(e)`; a missing end resolves through `referencedKey`. Walking against the
  edge flips the ON sides.
- **Multiplicity per hop:** walking FK side → key side is to-one; key side → FK side is
  to-many, unless the FK field is `unique` (one-to-one) or the edge's end labels say
  otherwise (`cardinalityMarker(startLabel/endLabel)`). One to-many hop → `fan-out` info;
  two or more → `double-fan-out` warning ("rows multiply at hops 2 and 3 — aggregate first
  or use EXISTS").
- Polymorphic references (`referenceTo.length > 1`) → emit a commented discriminator
  placeholder and a `polymorphic` warning.
- Identifier quoting per dialect (`"x"`, `` `x` ``, `[x]`); only quote when needed.

### UI (editor)

Each route row and each "Keys joining the pins" row in `FieldPathPanel` gets an **SQL**
button → popover: dialect select, join style, the SQL (monospace, selectable), warnings
list, **Copy**. Dialect/join preference is view state (remember per session).

### Tests / acceptance

String tests per dialect; flipped hop; missing endField; unique FK (no fan-out); two to-many
hops; polymorphic; aliases dedupe; a table name with spaces quoted.

### HTML export

- **Bundle** `routeSql` (pure string code, small).
- **Slice (G5):** `data.model.name/namespace` (table names), edge `startLabel`/`endLabel`,
  edge `data.model.required`; row/data `unique` already present.
- **Page UI:** in `renderPaths()`, add an **SQL** button per route row and per direct-key
  row → a small modal (reuse the `#bd-grid` modal container styles or add `#bd-sql`), with
  dialect select and **Copy** via the runtime's existing `copy()`. Persist the dialect in
  `localStorage` (namespaced key, try/catch).
- **Tests:** page test that the SQL modal shows the expected JOIN chain for the bakery route
  Bread → Recipe → Person.

---

## F5 Column-level schema compare

**Size:** M · **Depends on:** G1, G4

### Problem

Migration review: "what changed between these two versions of the model, and what will
break?" Compare mode today matches by id and reports `fields` as one changed property.

### Contract

```ts
// contract/schema-diff.ts
export interface FieldSnapshot { name: string; storageType?: string; nullable?: boolean; key?: FieldKey; unique?: boolean; references: string[] }
export type ChangeImpact = "breaking" | "caution" | "safe";
export interface ColumnChange {
  kind: "added" | "removed" | "changed" | "renamed";
  nodeId: string;
  fieldId: string;               // in `next` (or `base` for removed)
  from?: FieldSnapshot;
  to?: FieldSnapshot;
  changes?: Array<"type" | "nullable" | "key" | "unique" | "references" | "label" | "formula" | "description">;
  impact: ChangeImpact;
  reason: string;                // "type varchar → integer", "now required", …
  /** Renames are inferred: 0..1. */
  confidence?: number;
}
export interface SchemaDiff {
  tables: { added: string[]; removed: string[]; renamed: Array<{ from: string; to: string; confidence: number }> };
  columns: ColumnChange[];
  references: { added: KeyLink[]; removed: KeyLink[] };
  summary: Record<ChangeImpact, number>;
}
export function schemaDiff(base: FieldDocument, next: FieldDocument, opts?: { typeAliases?: Record<string, string>; renameThreshold?: number }): SchemaDiff;
```

- **Matching:** tables by node id, then by `data.model.name`; columns by field id, then
  name (case-insensitive).
- **Renames (inferred):** within a table, a removed + added pair with the same type family,
  key and nullability and name similarity ≥ threshold (normalised Levenshtein, or equal after
  stripping case/underscores) → `renamed` with confidence. Tables: column-set Jaccard ≥ 0.8.
- **Impact rules:** removed column/table, type family change, length narrowing, PK change,
  reference target change → breaking; nullable→required, added required column → caution
  (writers break; defaults are not modelled); required→nullable → caution (readers);
  added nullable column, label/description change → safe.

### UI (editor)

In Compare mode, a left-sidebar **Schema changes** panel: summary chips
(breaking/caution/safe, clickable filters), grouped by table, each change a jump that marks
the row; removed columns (absent from the new canvas) are listed with a "removed" style and a
"show in base" action if the compare overlay supports it. **Download report** (Markdown +
CSV) from the panel head. Hint: `ExportContext` has no base document — the report button
lives in the panel (which has both), not the Export menu, or `ExportContext` gains
`diffBase?`.

### Tests / acceptance

Fixtures for every impact rule, rename inference (true positive, and a near-miss that must
not be a rename), table rename, reference add/remove, alias-folded types not reported as
changes.

### HTML export

- The interactive page shows one document. **Recommended:** a separate exporter,
  **"Schema change report (HTML)"**, offered only in Compare mode: **precompute**
  `schemaDiff` at export time and render a static page (summary, filters, grouped tables) —
  a small hand-written script for filtering, no need to bundle `schemaDiff`. Reuse the page
  palette/CSS tokens from `html-export.ts`.
- Optional later: embed a changes panel in the normal explorer page when exported from
  Compare mode (`HtmlExplorerData.changes`, precomputed; panel with jumps into the current
  document).
- **Tests:** exporter produces a page with the expected counts; hostile names escaped.

---

## F6 Hubs, bridges and domains

**Size:** M · **Depends on:** G3

### Problem

At 1,000 tables nobody reads the whole diagram. Architects need the structure: which tables
everything hangs off (hubs), which ones hold the model together (bridges), and which natural
domains exist — for data-mesh ownership, service boundaries, and spotting misplaced tables.

### Metrics (key edges, undirected unless noted)

- Degree in/out (directed).
- **Betweenness centrality** (Brandes, O(V·E) unweighted). Above ~2,000 tables sample k
  sources (deterministic: evenly spaced in document order) and mark `approximate`.
- **Articulation points and bridges** (Tarjan, O(V+E)).
- **Connected components** (islands).
- **Domains:** label propagation with deterministic tie-breaks (document order), or Louvain
  if quality demands it; report modularity. Label each domain by its most central table.
- **Misplaced tables:** a table whose key edges mostly land in a different declared group
  (the importer's bands/groups) than its own.

### Contract

```ts
// contract/structure.ts
export interface TableMetrics { degreeIn: number; degreeOut: number; betweenness: number; articulation: boolean }
export function tableMetrics(doc: FieldDocument, opts?: { sampleAbove?: number }): { metrics: Map<string, TableMetrics>; approximate: boolean };
export function modelBridges(doc: FieldDocument): { articulation: string[]; bridges: string[] };
export function suggestDomains(doc: FieldDocument, opts?: { maxIterations?: number }): {
  domains: Array<{ id: string; label: string; tables: string[]; internalEdges: number; externalEdges: number }>;
  modularity: number;
};
export function misplacedTables(doc: FieldDocument): Array<{ nodeId: string; group: string; pullsToward: string; share: number }>;
```

### UI (editor)

View → **Model structure** (left sidebar), three tabs:
- **Hubs** — ranked list with a bar (betweenness) and degree; hover dims to the hub's
  neighbourhood (F7's function).
- **Bridges** — articulation tables and bridge keys; "removing this splits the model into 3".
- **Domains** — domain list with sizes and coupling; toggle **Colour tables by domain** (a
  display pass tint, not a document change); action **Create groups from domains** (a
  document change, one undoable commit, opt-in); misplaced tables list.

### Performance

Brandes on 1,000 tables / 3,000 edges is ~3M operations — synchronous is fine; above the
sample threshold, sample. Run only while the panel is open, memoised on `structureSignature`.

### Tests / acceptance

Small graphs with known betweenness; a barbell graph (one bridge); deterministic domains on
two dense clusters joined by one edge; misplaced table fixture.

### HTML export

- **Precompute** at export time (no reader input): `HtmlExplorerData.structure = { hubs
  (top 50 with metrics), articulation, bridges, domains (ids → tables, labels), misplaced }`.
  O(n) JSON; no algorithms in the bundle.
- **Page UI:** a **Structure** entry (⋯ menu or header button, shown for ≥ 2 tables) →
  `state.panel = "structure"` with the three tabs; domain tint via `decorate()` (outline
  stroke in the domain colour) — pick colours from the export palette's edge colours so
  light/dark pages stay legible.
- **Tests:** page test that hubs list renders from embedded data and a domain toggle tints
  groups.

---

## F7 Neighbourhood focus

**Size:** S · **Depends on:** G3

### Problem

"Show me Orders and everything within two joins; fade the rest." Essential past a few hundred
tables, and the building block for F6 hover previews.

### Behaviour (editor)

- Node menu **Focus neighbourhood** (also multi-select → union).
- A compact left-sidebar **Neighbourhood** panel: focus chips, depth `1 · 2 · 3`, direction
  `Both · Out · In`, *Keys only*, list by distance with counts, **Refocus here** on each
  table; canvas dims beyond the set (G3). Option **Hide the rest** as a display pass (like
  the timeline's hide mode), never a document change.

### Contract

`neighbourhood(doc, from, depth, opts)` exists in graph.ts. Add
`direction?: "out" | "in" | "both"` to `GraphOptions` (shared with F3) and use
`edgeFilter: (e) => !!edgeFieldIds(e).start` for *Keys only*.

### Tests / acceptance

Direction in/out/both; keys-only filter; multi-source union; drilled level shows stand-ins
bright (`keptOnCanvas`).

### HTML export

- **Bundle:** import `neighbourhood` in the runtime (graph.ts is already bundled; the
  function currently tree-shakes out — cost ≈ 1 KB).
- **Page UI:** node menu **Focus neighbourhood**; `state.panel = "neighbourhood"`; mask via
  G3; depth/direction controls re-run in the page.
- **Tests:** page test — focus Bread depth 1 dims Person, depth 2 does not.

---

## F8 Data dictionary and governance

**Size:** M · **Depends on:** G1 (`description`), G4, G5 (export)

### Problem

Enterprise reviews want the model as a document (every table and field, documented), and
governance numbers: how much is documented, who owns what, where personal data lives and
what can reach it.

### Dictionary

```ts
// contract/dictionary.ts
export interface DictionaryTable {
  nodeId: string; name: string; label: string; description?: string;
  owner?: string;            // node.team
  status?: string;
  recordCount?: number;
  truncated: boolean;
  fields: FieldRecord[];
}
export function dataDictionary(doc: FieldDocument, opts?: { isTable? }): DictionaryTable[];
export function dictionaryMarkdown(tables: DictionaryTable[]): string;   // a section per table, a field table each
export function dictionaryCsv(tables: DictionaryTable[]): string;        // one row per field (G4)
```

Exporters `dictionary-md` and `dictionary-csv` (`fullDocument: true`). Hint: `ExporterDef`
has no availability predicate; add `available?: (template) => boolean` so these appear only
for documents with tables (or ship them as an opt-in `DATA_MODEL_EXPORTERS` set, like
`FOLDER_EXPORTERS`).

### Governance

```ts
export interface GovernanceReport {
  documentation: { tablesWithDescription: number; fieldsWithDescription: number; fieldsWithLabel: number; total: { tables: number; fields: number } };
  ownership: { tablesWithOwner: number; byOwner: Array<{ owner: string; tables: string[] }> };
  sensitivity: { tagged: Array<{ tag: string; fields: FieldRef[] }> };
  /** Tables that can reach a sensitive field within N key hops — for access reviews. */
  exposure: Array<{ nodeId: string; nearest: FieldRef; hops: number }>;
  incomplete: string[];   // truncated tables
}
export function governanceReport(doc: FieldDocument, opts?: { sensitiveTags?: string[]; exposureDepth?: number }): GovernanceReport;
```

- **Tag convention** (document it in the README and the LLM prompt): `pii`,
  `pii:<category>` (`pii:email`, `pii:government-id`), `sensitive`, `confidential`,
  `retention:<period>`. Field tags already exist and already feed the View menu's tag filter.
- **Exposure:** `reachableFrom` from every table holding a sensitive field, over key edges,
  bounded by `exposureDepth` (default 2).

### UI (editor)

View → **Governance** (left sidebar): four sections with percentage meters (reuse
`.as-coverage__stat`), each number clickable to the list behind it; **Download dictionary**
(Markdown / CSV) in the panel head.

### Tests / acceptance

Dictionary snapshot on the bakery model; Markdown escapes pipes/newlines in descriptions;
governance counts; exposure depth.

### HTML export

- **Dictionary in the page:** a **Download dictionary (CSV)** item in the ⋯ menu,
  generated in the page from the slice. **Bundle** `dataDictionary` + `dictionaryCsv`
  (small) or precompute the CSV string at export (simpler, but doubles field data in the
  file — prefer bundling for large models).
- **Governance:** **precompute** `governanceReport` at export (static) →
  `HtmlExplorerData.governance`; a **Governance** panel renders it; list items jump.
- **Slice (G5):** node `team`, `status`, `data.model.{label,recordCount,fieldsTruncated}`;
  field `description` via G1 (rides in `data.model.fields`).
- **Tests:** page test — CSV download produces a Blob with the header row; governance panel
  numbers match the precomputed report.

---

## F9 Saved analyses

**Size:** S–M · **Depends on:** F3/F7 for their kinds; G5 (export)

### Problem

An analysis is only useful if it can be kept, shared and re-run after the model changes —
"re-run last quarter's tenant-key audit".

### Model

```ts
// contract/analyses.ts
export type SavedAnalysis = {
  id: string;
  title: string;
  note?: string;
  created?: string;                // ISO date
  /** What it said when saved, to show drift on re-run ("was 44%, now 51%"). */
  snapshot?: { headline: string; value?: number };
} & (
  | { kind: "paths"; pins: Pin[]; undirected: boolean; mode: "between" | "reachable" }
  | { kind: "usage"; names: string[]; match: "any" | "all"; includeTargets: boolean }
  | { kind: "coverage"; keys: FieldRef[]; scope: CoverageScope }
  | { kind: "impact"; subject: Pin; direction: "dependents" | "dependencies"; maxDepth?: number; via: "keys" | "all" }
  | { kind: "neighbourhood"; from: string[]; depth: number; direction: "out" | "in" | "both" }
);
```

- **Storage:** a validated top-level `analyses?: SavedAnalysis[]` on `DiagramTemplate`,
  mirroring `paths` (validated strictly, pruned of node/field references that vanish,
  deleted with their nodes). Not `meta` — `meta` is free-form and unvalidated. Add
  `analyses` to diff.ts's non-architecture fields so saving one is not a "change" in Compare.
- It is **content by choice** (the one exception to §2.3): saving is an explicit action that
  enters undo and `onChange`; opening one restores **view state** and does not.

### UI (editor)

- Every analysis panel head gets **Save…** (title + note).
- Toolbar **Analyses** menu: saved list (open, rename, delete, re-run with drift badge).
- Ref: `getAnalyses()`, `openAnalysis(id)`; the view-state APIs that exist already
  (`setPins`, `setUsageKeys`, `setCoverageKeys`) are what `openAnalysis` calls.

### Tests / acceptance

Validation (unknown kind dropped, dangling refs pruned), save/open round trip per kind,
drift badge, undo of a save, diff ignores `analyses`.

### HTML export

- **Slice (G5):** carry `analyses`. The page lists them under an **Analyses** header menu;
  opening one sets the runtime `state` (pins, usage picks, panel) and calls `renderAll()`.
- **Reader-made analyses** (the page can't write the file): encode the current state in the
  URL fragment so a hosted copy can be linked — `#/<level>?a=<base64url(json)>`.
  **Hint:** the navigator matches `byHash[location.hash]` exactly (html-export.ts); change it
  to split on `?` first, and have the explorer read/write only the query part with
  `history.replaceState` (no `hashchange` loop). Optionally persist to `localStorage` keyed
  by a document fingerprint (title + hash of node ids) — `file://` pages can share storage
  across files in Chromium, so namespace keys; wrap in try/catch.
- **Tests:** page test — opening an embedded analysis restores the usage picks and the
  percentage; a fragment with `?a=` restores state on load; level deep links still work.

---

## F10 Column lineage (design only)

**Size:** L · **Depends on:** a new importer; F3 for impact over lineage; F8 for exposure

### Problem

"Where does `revenue_usd` come from?" is the biggest enterprise ask, but it needs sources the
tool does not read today.

### Inputs (pick one to start)

- **OpenLineage** events with the `columnLineage` facet (tool-agnostic; recommended first).
- **dbt** `manifest.json` + `catalog.json` (model-level lineage free; column-level needs SQL
  parsing — out of scope in JS unless the manifest already carries it).
- Warehouse lineage APIs (Snowflake `ACCESS_HISTORY`, Unity Catalog) via a host-side
  adapter that emits OpenLineage-shaped JSON.

### Model

A separate collection, not FK edges (lineage is not a relationship and must not pollute
route/coverage/impact graphs):

```ts
lineage?: Array<{ id: string; from: FieldRef; to: FieldRef; transform?: string; job?: string }>;
```

### Analyses and UI

Upstream/downstream column trace (BFS over lineage), impact of changing a source column
(F3 over lineage), sensitive-data propagation (F8 exposure over lineage). Field menu
**Trace lineage** → left panel tree; lineage drawn as **overlay** lines between rows (not
document edges).

### HTML export

Slice gains `lineage`; bundle the trace (BFS). Overlay lines between rows: row geometry is
already in the page (`rect.bd-row` x/y/width/height inside each node group) — compute
absolute positions with `getCTM()` and draw into a top-level overlay `<g>` per level; rows on
other levels resolve to stand-ins via `representatives`.

### Open questions

Storage and validation of `lineage`; how a folder import and a lineage import merge; whether
lineage belongs in the same document at all or a linked one.

---

## 6. Sequencing

| Milestone | Contents | Why this order |
|---|---|---|
| **M0 Groundwork** | G1, G2, G3, G4, G6; G5 as each export feature needs it | Unblocks everything; all additive. |
| **M1 Quick wins** | F1 consistency, F7 neighbourhood, F4 SQL | Small, visible, reuse existing panels and bundle. |
| **M2 Audit** | F2 checks (+ Checks panel), F3 impact | Turns "explore" into "audit"; the most-asked questions. |
| **M3 Change** | F5 schema compare (+ report exporter), F8 dictionary & governance | Review and documentation workflows. |
| **M4 Structure & reuse** | F6 hubs/bridges/domains, F9 saved analyses | Scale and repeatability. |
| **Later** | F10 lineage | Needs an input format decision first. |

Each feature ships editor + contract + HTML export together (§8), or states explicitly which
part is deferred.

---

## 7. Risks

- **Noise.** Undeclared-reference and naming rules can flood legacy schemas. Mitigate:
  grouping, severity config, quick fixes, ignore tags, and a count-first panel.
- **Inference mistakes.** Renames, undeclared references and domains are guesses. Label them
  as such (confidence, "looks like"), never auto-apply.
- **Bundle growth.** Each bundled analysis grows every export. Enforce the size test (§3.2),
  prefer precomputing static answers, keep top-level contract code pure.
- **Slice drift.** Every new field read by an analysis must be added to `explorerDocument`;
  the parity test is the guard — extend it with each feature.
- **Two UIs per panel.** React and page DOM panels can diverge in wording and behaviour.
  Shared formatters (§3.2 rule 4) and page tests that assert the same headline strings as the
  React tests.
- **Truncated imports.** Tables over `MAX_NODE_FIELDS` make every count a lower bound. Every
  panel surfaces `fieldsTruncated` tables rather than hiding them.

---

## 8. Definition of done

For each feature:

- [ ] Contract module(s) with unit tests, exported from `contract/index.ts`, pinned in
      `api-surface.test.ts`.
- [ ] Editor panel/menu entries; view state mirrored to hosts where it is state (ref method +
      `on…Change` prop, slot context); Escape order; sidebar exclusivity.
- [ ] Component tests (`@vitest-environment jsdom`) through `ArchitectureStudio`.
- [ ] HTML export: precompute-or-bundle decision recorded in the PR; slice extended with a
      parity test; runtime rebuilt (`npm run build:explorer`); page test via `openPage()`.
- [ ] E2E step in `e2e/fields.spec.ts` (editor and exported page).
- [ ] README section (Fields beyond the rows / Interactive HTML) updated.
- [ ] Performance checked on a synthetic 1,000-table model.
