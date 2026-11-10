# Directed flow: an Arrange mode that trades crossings against direction

Status: plan, 2026-11-09. Nothing here is built.

## What it is

A fifth Arrange mode, **Directed flow** (`settings.arrange: "directed"`). One click arranges the
diagram so that, in this order of importance:

1. lines don't cross or run on top of each other,
2. everything reads one way: lines enter a box on its "in" side and leave on its "out" side, boxes
   that only send sit at the start, boxes that only receive sit at the end,
3. the rest of what makes a picture look organised (below) is as good as it can be without giving
   up 1 or 2.

It has two controls, stored in `settings.directed`:

- **Priority**: a five-stop slider from *Fewest crossings* to *Strictest direction*. Default one
  stop toward crossings (crossings weigh 3× direction).
- **Method**: *Best of all* (default), or one of the four engines below by name, so each can be
  looked at on its own.

## How it differs from what exists

`untangle` and the auto-placer's `layered` family are both the classic pipeline: pick a direction
for every line first, rank, then reduce crossings within that fixed ranking. Direction is decided
before crossings are ever counted, so the two can't be traded. A back-edge that would remove five
crossings is never considered. This mode makes that trade the centre of the algorithm.

## The objective

One number, lower is better, computed on the drawn picture by `lintLayout`'s scene (so it measures
what is on screen, like every other rule):

```
J = wX · (crossings + overlaps)  +  wD · direction  +  Σ wi · secondary_i
wX / wD = 9, 3 (default), 1, 1/3, 1/9 for the five Priority stops
```

### Metrics

Already measured (reused as they are): crossings, shallow crossings, lines on top of each other,
lines running close, line through box, box overlap, words collisions, hooks, detours, long lines,
near-alignment, uneven spacing, legibility (fit zoom), container looseness.

New, each a pure function of the scene with a unit test:

| Metric | Definition | Source |
|---|---|---|
| **Flow consistency** | 1 − (length of line travelling against the main axis ÷ total line length) | Purchase 2002 "consistent flow" |
| **Backward lines** | count of lines whose target is upstream of its source; cycles forgive their one necessary back-edge | Eades–Lin–Smyth 1993 (feedback arc set) |
| **Port discipline** | share of line ends on the right side: in-ends on the upstream face, out-ends on the downstream face | port constraints, ELK Layered |
| **Source/sink placement** | share of pure sources in the first rank and pure sinks in the last | Gansner et al. 1993 (dot `rank=min/max`) |
| **Crossing angle** | mean deviation of crossings from 90° | Huang, Eades, Hong 2014 (RAC) |
| **Angular resolution** | smallest angle between two lines at one box, normalised by degree | Purchase 2002 |
| **Bends** | bends per line | Tamassia 1987 |
| **Spine straightness** | deviation of the longest path from a straight line | Ware et al. 2002 (path continuity) |
| **Stress** | Σ (drawn distance − graph distance)² / graph distance², scale-fitted | Gansner, Koren, North 2004 |
| **Rank evenness** | variance of gaps between ranks and of box count per rank | — |
| **Symmetry** | share of boxes with a mirror partner about the main axis, within tolerance | Purchase 1997 |
| **Group compactness** | each group's contents' hull ÷ the group's area, and lines leaving a group through one face | — |
| **Stability** | mean box displacement from the picture before, after the best rigid alignment | Misue et al. 1995 (mental map) |

Evidence for the ordering: Purchase's experiments found crossings hurt reading by far the most,
then bends, with flow and symmetry behind; our own 216 picks put size first and crossings next.

## The four engines

All take the same graph and weights and return positions; the router that exists draws the lines.

**A. Layered with a trade (LT).** The Sugiyama pipeline, but direction is negotiable.
1. Order by Eades–Lin–Smyth; rank by network simplex (replacing today's coordinate-descent
   stand-in) with sources pinned first and sinks last.
2. Order ranks with barycentre + transpose sweeps (exists).
3. **New:** local search over three moves, accepted when J falls: move a box one rank, reverse a
   line (it becomes a back-edge), or put two connected boxes in one rank (a flat line). Each is
   priced by wD and paid for in crossings saved at wX. Counting crossings between two ranks is
   O(E log V) with a Fenwick tree (Barth, Mutzel, Jünger 2002), so thousands of moves are cheap.
4. Brandes–Köpf coordinates so long lines run straight.

**B. Planar first (PF).** Upward planarization (Chimani, Gutwenger, Mutzel, Wong 2010), simplified:
insert lines one at a time into a crossing-free upward drawing, each along the route that crosses
least, a crossing becoming a dummy box; then rank the result. Known to beat Sugiyama on crossings
by a wide margin because ranks don't exist until the crossings are settled. The line weight for
"allowed to go backward" is wD.

**C. Stress with direction (SD).** Stress majorization with a separation constraint per line,
"target is at least one gap downstream of source" (Dwyer & Koren 2005, DiG-CoLa), solved by
gradient projection; constraints of lines the Priority has let go are dropped. Best on meshes
where ranks are a fiction; gives symmetric, evenly spaced pictures.

**D. Anneal (AN).** Take the best of A–C and anneal J directly (Davidson & Harel 1996) with moves
at the box level: swap two boxes in a rank, shift a rank, mirror a subtree, slide a group. Short
schedule, seeded, deterministic. This is the polish, and the only engine that sees every secondary
metric.

**Best of all** runs A, B, C, anneals the two cheapest, and keeps the lowest J. Groups and zones
are handled as the auto-placer does now: each container is laid out inside-out as its own graph
with the same engine, then placed as one box; locked things are fixed points.

Budget: 300 ms at 60 boxes, 2 s at 200, hard stop with the best so far. Above 300 boxes only A runs.

## Where it goes

- `contract/directed/metrics.ts`, `rank.ts` (network simplex, crossing counter), `engine-*.ts`,
  `index.ts` exporting `directedLayout(template, options)`.
- `schema.ts` / `json-schema.ts`: `"directed"` in `ARRANGE_MODES`; `settings.directed:
  { priority?: -2..2, method?: "best"|"layered"|"planar"|"stress"|"anneal" }`.
- `layout.ts`: `autoLayout` dispatches the mode. `arrange.ts`: `layoutCandidates` offers one card
  per method so the Layout panel compares them.
- `ArchitectureStudio.tsx`: Arrange ▸ *Directed flow*, with Priority and Method under it; the same
  two controls in the Layout panel. One undo step each, like the other modes.
- `bd-layout place --mode directed --priority n --method m`.
- The new metrics are added to `LayoutReport.metrics` (numbers, not findings), so they cost
  nothing in the score until readers say they should.

## Build order

Each step is one PR, merged after CI, no version bump.

1. **Metrics.** The table above, with tests, plus `npm run gallery -- metrics` printing them for
   every gallery document under every existing arrangement. This is the baseline to beat.
2. **Engine A** end to end behind the mode, with the Priority slider. First pictures.
3. **Engines B and C**, each selectable. Compare all three on the metrics table.
4. **Engine D and Best of all.** Tune secondary weights against the 216 picks plus new ones.
5. **Review loop** (below) until the bar is met.
6. **Text**, as its own step: labels sized and placed for the result (wrap, grow to fit, label
   slots on straight stretches). Scored again with words on.

## Testing

**Unit:** each metric on hand-made cases; each engine: nothing lost, nothing overlapping, groups
hold their boxes, locked boxes don't move, same input gives the same output; Priority at one end
never has more crossings than at the other, and at the other never more backward lines.

**Measured:** on the 23 gallery documents plus 12 new directed ones (pipelines, a DAG with
shortcuts, a cycle, fan-in/fan-out, two-way traffic, a mesh), every method must have no more
crossings than `untangle` and no lower flow consistency than `layered` at the default Priority.
That is the claim the mode makes; if a method can't meet it, it is dropped from the menu.

**Seen (Playwright):** `npm run gallery -- variants` already draws each arrangement in the real
studio on an isolated server. Add `--words off` (labels hidden) so layout can be judged alone.

**Blind review.** Three fresh agents per round, no context, no code, one picture at a time at
screen size, a fixed rubric (crossings, direction, spacing, alignment, grouping; 1–10 each and
overall). A method passes when the median overall is ≥ 8 on at least 80% of documents and never
below 6. Pairs against today's Best fit are recorded as picks, which is the sturdier measure.

## Defaults I've assumed

- The mode is added beside the others; Best fit stays the default until Directed flow wins the
  pairs.
- Main direction is left-to-right unless the document has chosen one; data models stay sideways.
- First scoring is with words off, as you suggested; text is step 6.
- "Play rate" in the request is read as Playwright.

## Risks

- **The 8/10 bar.** Five blind reviews of the auto-placer on 2026-11-07 stuck at 6/10, and
  reviewer noise was as large as the gains. Absolute scores from agents are capped by the rubric
  and by dense documents that no arrangement makes pretty. Mitigation: fixed rubric, median of
  three, words off first, and report pairs won alongside the score. If a document can't reach 8
  under any method after two rounds, it is listed with the reason rather than tuned forever.
- **Engine B is the hardest to write well.** If the simplified version doesn't beat A on
  crossings after one iteration, it is cut and noted.
- **Time.** Annealing is bounded by the budget, not by convergence; big documents get engine A.
- **Unrelated work in the tree.** The audit fixes are uncommitted; they should be committed
  before step 1 so the baseline is measured on fixed code.
