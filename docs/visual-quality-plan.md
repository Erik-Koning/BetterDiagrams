# Visual quality: plan

Status: **phase 1 implemented** 2026-11-09 (proposal 2026-11-09) · scope: the auto-placer, the
layout linter and the router (`contract/autoplace.ts`, `arrange.ts`, `layout-lint.ts`,
`route-lines.ts`), how lines and boxes are drawn (`react/edges.tsx`, `react/draw.ts`, the HTML
explorer), the schema and the AI prompt.

## Implementation status

**Phase 1 (measuring)** shipped:
- `npm run gallery` (`scripts/gallery/`) with `compare`, `variants`, `pairs`, `pick` and `fit`.
- The gallery itself: 23 documents, which are the 15 fixtures, 4 anonymised real documents
  (`gallery/real/`) and 4 seeded stress graphs. `gallery/real/data-model.json` lost its row
  anchors when it was anonymised and had them restored on 2026-11-09, after both rounds: its 10
  recorded picks were made on pictures drawn box to box.
- Recorded picks in `gallery/picks.jsonl`, with the arranged documents they compare in
  `gallery/docs/`, so any later linter can be re-fitted to them.
- Seven new rules (`shallow-crossing`, `close-lines`, `line-hook`, `curve-bulge`,
  `ambiguous-words`, `crowded-ends`, `too-dense`).
- The bent score curve, the counts beside the score, and `metrics.zoom`.

What the first data says:

| | |
|---|---|
| Picks | 216: two rounds of six no-context reviewers over the same 90 pairs of arrangements (136 drawn) |
| Reviewers agreeing with each other | 92% over 180 shared pairs. Re-judged by fresh reviewers, 102 of 108 picks came out the same |
| The linter's cost agreeing with them | 72% before this phase. Now 77% on round one, and 82% on round two (pictures at screen size) |
| The score agreeing with them | 65% before; 71% now |
| Fitted weights | +1 point overall, and not stable across regularisation, so **not adopted**: `fit` prints them for the next round |
| Best fit against the other arrangements | won 81% of the comparisons it was in; Grid won 25% |
| What readers named | size 91 times, crossings 72, tangles 73, direction 51, crowded ends 36, labels 30 |

Departures from the plan:
- **Legibility moved into the linter's cost.** The placer used to add it on its own; now both, and
  the gallery, measure one thing. That raised agreement from 72% to 77% on its own.
- **The score still ignores size.** A score that counts how small the words get (8 points per
  halving) agrees with readers 79% of the time against 71%, but it marks a long chain down for being
  long. That runs against "no shape, no size forced", so it is left for a decision. A `too-small`
  finding was tried and dropped for the same reason.
- **Pairs are shown one above the other at screen size.** Side by side, each picture was shrunk to
  two thirds, which made size look worse than it is. Only 6 of 108 picks changed, but the format is
  the fairer one.
- **82% is not a clean held-out figure.** Round two judged the same pairs whose first round prompted
  the legibility change. Phase 2's before-and-after pairs will be new.

## Contents

1. [Where we are](#1-where-we-are)
2. [Principles](#2-principles)
3. [Decisions taken by default](#3-decisions-taken-by-default)
4. [Phase 1: measuring](#phase-1-measuring)
5. [Phase 2: emphasis and spacing in the drawing](#phase-2-emphasis-and-spacing-in-the-drawing)
6. [Phase 3: intent from the author and the AI](#phase-3-intent-from-the-author-and-the-ai)
7. [Phase 4: a router that groups lines](#phase-4-a-router-that-groups-lines)
8. [Phase 5: moving boxes to help the lines](#phase-5-moving-boxes-to-help-the-lines)
9. [Phase 6: drawing less](#phase-6-drawing-less)
10. [Order, checks and risks](#10-order-checks-and-risks)

## 1. Where we are

- PR #26 shipped the auto-placer (`autoPlace`, `polishLayout`, `arrangeBest`, `layoutCandidates`), the
  layout linter (`lintLayout`), the Layout panel and `bd-layout`.
- **Blind reviews plateaued at 6/10 after five rounds.** The round means were 6.07–6.6. Simple
  shapes score 8–9, `dataModel` 4 and `largeSystem` 3. The gain from one round to the next was
  about as big as reviewer noise.
- **The linter disagrees with readers.** It scored `nestedGroups` 100 where a reviewer gave 5,
  `webApp` 99 where one gave 6, and `dataModel` 98 where one gave 4. It doesn't measure:
  - shallow crossings
  - lines running close alongside each other
  - lines that double back near their ends
  - bulging curves
  - labels that could belong to either of two lines
- **Real documents score 0.** `refdocs` has 32 crossings and 13 cut-off labels. The findings
  are real, but a score pinned at 0 can't tell 30 problems from 300.
- **Open-source engines** (spike, 2026-11-07):
  - **libavoid** routes cleanly on a good placement but can't rescue a bad one.
  - **ELK** placed `largeSystem` better, but started the flowchart at the bottom right.
  - **MSAGL** did worst, though my test of it was crude.
- **Speed on real documents:** Arrange takes at most 377ms, Polish 87ms and lint 6ms.

## 2. Principles

1. **Separate rules from preferences.** The rules:
   - A box stays in its group or zone.
   - Locks hold.
   - Boxes don't overlap.
   - Lines don't run through boxes.

   Everything else is a cost. A move that breaks a rule is never tried. Membership is a rule but
   position isn't, so a group can change sides.
2. **Use one score, measured on the drawn picture and calibrated against readers.** Searching
   harder against a score readers disagree with makes pictures worse while the number rises.
3. **Each party contributes what it knows.** The author or AI model says what matters, the
   algorithm handles geometry, and readers judge. The author's intent and the readers' judgement
   both need a channel into the system.
4. **Decide coarse to fine, with feedback.** Settle where groups sit, then who's beside whom,
   then coordinates, lines and labels. Early stages use cheap estimates; finalists are scored
   fully drawn.
5. **Keep the picture stable.** A familiar picture that's slightly worse beats a better one
   people must re-learn after every edit.
6. **Add no runtime dependencies to `contract/`, and keep `autoLayout` synchronous.**

## 3. Decisions taken by default

Say if you want any of these otherwise.

| | Default |
|---|---|
| D1 Real documents in the gallery | Anonymised copies under `gallery/real/` at the repo root, which isn't shipped in the npm package: labels become kind + number, descriptions are dropped, structure and sizes stay. If you'd rather not commit them, they stay local and gitignored. |
| D2 When the linter is good enough | It agrees with readers' picks on at least 80% of held-out pairs. |
| D3 When a phase is done | It wins at least 70% of pairwise picks against `main` on the gallery, adds no lint errors (overlap, line through a box, spilling out of a container), and stays within its speed budget. |
| D4 Intent fields | `emphasis` on boxes (`"key"` \| `"minor"`) and on lines (`"main"` \| `"minor"`). `secondary: true` stays valid and means `"minor"`. |
| D5 AI fixing the layout | A **Fix with AI** button in the Layout panel when AI is set up. Never automatic. |
| D6 Router | Written in TypeScript in `route-lines.ts`, from the published method (Wybrow, Marriott and Stuckey on orthogonal connector routing). libavoid is used only in the gallery as the bar to beat, installed in its own folder rather than as a dependency. MSAGL is retested first with proper path extraction; it's MIT, so a good result reopens the question of using it directly. |
| D7 The setting for grouped lines | A new `layout.lines` setting: `"auto"` \| `"separate"` \| `"side-by-side"` \| `"merged"`, default `"auto"`. `layout.ends` stays and still controls where lines meet a box. |
| D8 Motion | Arrange, Polish and gallery picks animate over 250ms. Animation is off with `prefers-reduced-motion`, in exports and under test. |
| D9 Score display | A curve that never pins at 0, such as 100·e^(−cost/k), with problem counts beside it. |
| D10 Shipping | One PR per phase, merged to `main` after CI, with no version bump. 0.2.0 is your call. |

## Phase 1: measuring

**Problem.** We can't reliably tell better from worse. The linter disagrees with readers, 1–10
ratings are noisy, and the screenshot harness lives in a session scratchpad.

**Build.**

1. **`scripts/gallery.mjs`** renders the gallery twice, once at a git ref and once from the
   working tree, in the real studio.
   - It writes PNGs, a metrics JSON and an HTML contact sheet, with no Python.
   - It uses an isolated dev server: a spare port, `BD_TEMPLATES_DIR` in a temp folder, an
     empty `BD_LINKED_DIRS` and a fresh `TMPDIR`.
   - Run it with `npm run gallery -- compare --base main`.
2. **The gallery documents:**
   - the 15 fixtures in `arrange.fixtures.ts`
   - real documents (D1)
   - seeded random stress graphs
3. **`scripts/gallery-review.mjs`** prepares pairs in random A/B order with a reviewer prompt.
   - The reviewers are no-context agents, plus you when you want.
   - Each picks the one they'd ship and tags a reason: crossings, tangles, crowded ends,
     labels, frames, spacing, shape or size, or other.
   - Picks are appended to `gallery/picks.jsonl`.
4. **New lint rules:**
   - shallow crossing (under 30°)
   - lines running close alongside each other (within ~8px for over 60px)
   - a line that doubles back within ~30px of its end
   - a curve that bulges well outside its ends' bounding box
   - a label nearer another line than its own
   - more line ends on a side than its length fits at ~12px apart
   - too much for one view (fit zoom under 0.5 and over ~1.5 lines per box)
5. **Weights fitted to the picks.** A logistic fit on the differences in each rule's count,
   with fixed floors for the error rules so the fit can't make them cheap.
6. **The score display (D9).**

**Done when:** D2 holds on held-out picks, and lint stays under 10ms at 60 boxes.

## Phase 2: emphasis and spacing in the drawing

**Problem.** Every box and line has the same weight, so nothing leads the eye. Spacing doesn't
show structure, and arranged boxes can cut off their own labels.

**Build.**

1. **Three line weights:** main (heavier), normal, and minor (thinner, at about 60% contrast).
   - Until Phase 3, the main path is the one `markChains` already finds.
   - This applies to the canvas (`edges.tsx`), the exports (`draw.ts`) and the HTML explorer
     (rebuild the runtime).
2. **A legend for line meanings,** extending the zone legend. It shows only when a document
   gives line colours or dashes more than one meaning.
3. **A spacing ladder:** boxes inside a group sit closest, then siblings, then groups, then
   separate pieces, each step about 1.5× the last.
4. **Grid snapping:** arranged positions snap to the canvas's 12px grid.
5. **Text that fits:** Arrange and Polish leave no cut-off labels, using `growToFit`.
6. **Motion and stability:** animated changes (D8), and Polish pays a cost for moving a box far
   from where it was.

**Done when:** D3 holds, and no label is cut off after Arrange on any gallery document.

## Phase 3: intent from the author and the AI

**Problem.** The placer can't tell what matters. Models are good at meaning and bad at
coordinates, but we ask them for coordinates.

**Build.**

1. **`emphasis` (D4):**
   - validation, the JSON schema and the API report
   - stored with the document's content, not its presentation
   - the folder format
2. **An Emphasis control** in the inspector, for boxes and for lines.
3. **The system prompt** asks for the main path and for key and minor elements, not positions.
4. **The placer:**
   - It keeps the main path straight and central.
   - Minor lines don't shape the layout, as `secondary` lines don't today.
   - Key boxes are emphasised in the drawing, not made bigger.
5. **Conventions by kind,** as a cost term that the flow can override: people and clients
   first, databases last, external services at the edge.
6. **Fix with AI (D5):** the panel sends its findings as structured text in a refine turn.

**Done when:** D3 holds, `emphasis` survives a save and reload, and older documents arrange
exactly as before. We also verify that older versions drop the new fields without error.

## Phase 4: a router that groups lines

**Problem.** Lines are routed one at a time. Lines going the same way are neither grouped nor
spaced as a set, and too many ends crowd one spot.

**Build.**

1. **Two passes in `route-lines.ts`:**
   - **Route:** route each line on an orthogonal visibility graph. The cost counts length,
     bends and crossings with lines already placed; running through a box is forbidden. Then
     rip up and re-route the worst lines.
   - **Space out:** lines that share a corridor are spaced evenly, in an order where they don't
     cross each other.
2. **Grouping (D7):**
   - **Merged trunks:** lines fanning out of one box, or into one box, with matching style.
   - **Side-by-side runs:** lines between the same two areas.
   - Never many-to-many: that hides what connects to what.
3. **Style per diagram,** chosen by the score in `"auto"`: curves when sparse, elbows when
   dense, straight spokes for hubs and rings.
4. **Labels:** one label per trunk, placed on a straight run.
5. **Table rows:** lines landing on the same row merge into one trunk with one end marker when
   their markers match. This replaces squeezing them inside the row (`spreadSharedRows`).
6. **libavoid in the gallery** as the benchmark (D6).

**Done when:**
- D3 holds.
- On the gallery, no line runs through a box, and crossings are at or below libavoid's on the
  same placement.
- Routing stays under 150ms at 60 boxes, and folder import stays within its 2s budget.

## Phase 5: moving boxes to help the lines

**Problem.** Boxes are placed once and never moved to make the lines better.

**Build.**

1. **A local search after `autoPlace`.** It tries these moves, never breaking a rule:
   - swap two boxes in a rank
   - move a box one rank
   - mirror a group
   - move a group to another side of its neighbours
   - change a group's inner direction
2. **Two-stage evaluation:** a cheap estimate (straight-line crossings plus length) filters the
   moves, and only the best few are routed and linted in full.
3. **Budgets:** about 300ms in the studio, and more with `bd-layout --effort high`. The search
   is seeded, so it's repeatable.
4. **Arrange uses every move;** Polish uses only swaps and nudges, plus the stability cost.

**Done when:** D3 holds, and `largeSystem`, `dataModel` and `nestedGroups` each win at least 70%
against the end of Phase 4.

## Phase 6: drawing less

**Problem.** The worst diagrams are too dense for any arrangement to rescue.

**Build.**

1. **A "too much for one view" finding** with one-click fixes:
   - collapse the group with the most lines inside it, with its outside lines merged and counted
   - or open the focus view
2. **The focus view:** everything more than one step from the selection is dimmed, reusing the
   existing neighbourhood analysis.

**Done when:** D3 holds on the dense gallery documents, and collapsing or expanding undoes in
one step.

## 10. Order, checks and risks

**Order.**
- Phase 1 comes first, because every other phase is judged by it.
- Phases 2 and 3 can run side by side once the gallery script exists.
- Phase 4 comes before Phase 5; otherwise the search learns to work around the router's faults.
- Phase 6 can come any time after Phase 1.

**Every PR runs:**
- typecheck, unit tests and e2e (isolated port and `TMPDIR`), the build and `api:check`
- `build:explorer` after edits to geometry, schema or shapes
- `smoke-cli` when the CLI changes
- the extension's typecheck, tests and webview tests
- before-and-after gallery pairs attached to the PR
- a CHANGELOG entry under Unreleased, and a README update when behaviour changes

**Risks.**

| Risk | Mitigation |
|---|---|
| Agent reviewers agree with each other more than with people | Mix in 10 pairs per phase for you to pick. |
| Weights fitted to few picks overfit | Hold out a set of picks for testing, and keep the error rules' floors. |
| The new router is slow on large documents | Budgets, with a fallback to the current router. |
| Animation makes e2e flaky | Animation is off under test. |
| Fix with AI spends tokens unasked | It only runs when clicked. |
