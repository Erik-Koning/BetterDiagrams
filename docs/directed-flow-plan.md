# Directed flow: an Arrange mode that trades crossings against direction

Status: steps 1, 2 and three rounds of step 5 built 2026-11-10 (the measures; the mode with its
ranked engine and its controls; three blind reviews and what they led to). The reviewers' bar is
not met: see "three blind reviews" below. Engines B and C (steps 3 and 4) and the text step (6) are
not built.

## Where it stands

**Step 1, measuring.** `measureFlow` and `layoutStability` (`contract/directed/metrics.ts`), and
`npm run gallery -- metrics`, which prints them for every gallery document in every arrangement.
The gallery has twelve more documents (`flow-*` in `scripts/gallery/corpus.mjs`), each one shape a
flow takes.

The baseline, over all 35 documents (counts are totals, shares are means):

| Arrangement | Crossings | Lines on lines | Through a box | Backward (unavoidable) | With the flow | Ports |
|---|---|---|---|---|---|---|
| Best fit (today's default) | 252 | 70 | 1 | 38 (11) | 0.87 | 0.85 |
| Untangle | 363 | 102 | 244 | 49 (11) | 0.85 | 0.88 |
| Left to right (old) | 388 | 122 | 337 | 48 (11) | 0.85 | 0.89 |

Best fit is the one to beat, not Untangle: it already crosses less. Where it loses is flows with
shortcuts past a stage: 11 crossings on `flow-shortcuts` where Untangle draws 1, 8 against 2 on
`flow-long-skip`, 11 against 6 on `flow-mesh`. It picks a direction by how large the words come out,
and pays for that in crossings, which is the trade this mode is for.

**Step 2, the mode.** `settings.arrange: "directed"` (Arrange ▸ *Directed flow*, a card in the
Layout panel's gallery, `bd-layout place --mode directed`), with a Priority slider and a Method
choice in the menu and the panel (`settings.directed`). Methods: `layered`, `anneal`, `best` (the
better of those two), and `stress`, by name only (see "Engine C" below).

What is in it:
- **The ranking search** (`directed/ranking.ts`): cost = crossings + lines backward + ranks skipped,
  at the priority's rate; one box moved at a time to a rank beside a neighbour, or to a new rank
  between two; a move past a neighbour turns their line round. Seeded from the reader's order, the
  order with fewest lines backward, and a pass priced for crossings above all. Annealing is the
  same moves, allowed to get worse.
- **A main line turned round costs double** a return line running back. Without it the search
  starts a loop from its middle to save one backward line, and the flow reads inside out.
- **Arcs as a book embedding** (`directed/arcs.ts`): lines that skip down a column or run back are
  given sides and depths together. Every split is tried up to 12 arcs; past that, greedy with
  flips. Each is drawn as a bracket with rounded corners and a dead-straight run.
- **Two-way traffic** between neighbours runs face to face as two lanes. **A box that collects a
  fan** sits in the middle of it.
- **The choice between whole pictures** (`directedCost`): the linter's cost, crossings scaled by the
  priority, direction charged for. Several rankings are laid out in full and compared as drawn.

Results, over all 35 documents, as step 2 left it (the figures after the reviews are below):

| Arrangement | Score | Crossings | Lines on lines | Backward (unavoidable) | Ports |
|---|---|---|---|---|---|
| Best fit | 85.0 | 252 | 70 | 38 (11) | 0.85 |
| Directed, best | 89.3 | 222 | 39 | 30 (11) | 0.92 |
| Directed, ranked | 89.1 | 221 | 43 | 31 (11) | 0.92 |
| Directed, annealed | 88.9 | 231 | 43 | 31 (11) | 0.92 |

On the twelve flows: 15 crossings against Best fit's 42, and 0 lines on lines against 24. It loses
to Best fit on the two documents with no direction to them (a hub of twenty spokes, a mesh), which
Best fit draws as a ring and a mesh and this draws as ranks.

The Priority slider is monotone on all 35: crossings at the crossings end are never more than at
the direction end, and backward lines the other way round. It changes the picture on 8 of them.

Time (after the review changes): `best` 0.4 to 1.2 s on the documents of 30 to 60 boxes (Best
fit: 0.2 to 0.35 s); `layered` 0.2 to 0.8 s. That is over the 300 ms this plan set for 60 boxes.

**Step 5, three blind reviews.** Each round, three reviewers who knew nothing of how the pictures
were made scored all 35, words on, on one rubric (tangle, direction, order, lines, overall), from
shuffled copies with nothing in a file name to go by. In every round they agreed within one point
on every picture.

| | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| Median overall | 7 | 7 | 7 |
| Mean | 6.57 | 6.60 | 6.77 |
| At 8 or more | 13 of 35 | 11 | 14 |
| Below 6 | 9 of 35 | 8 | 8 |

**The bar this plan set (8 or more on 80% of documents) is not met, and three rounds moved the
median nowhere.** The simple flows score 8 to 10 (pipelines, branches, retries, loops, fans, a
tree, a ring). The dense documents score 2 to 5 and did not move: the four stress graphs, the large
system, two of the real documents. In the middle, at 6 and 7, are the flows where lines have to
skip or return.

What the reviewers said cost most, the same in all three rounds:
1. Connected boxes placed far apart in dense pictures, so long lines sweep across and cross.
2. Many lines sharing one spot or one track on a box, so ends can't be told apart.
3. Lines that aren't one clean curve: hooks, lumpy corners, and (once lines ran through channels)
   flat shelves.
4. Loose placement: near-miss rows, groups stepping sideways, a box in a column of its own, strays.
5. Crossings a different order within a rank would avoid, and labels on lines.

What was changed for them:
- **Round 1 → 2. Long lines run through their lanes** (1): a line that skips ranks is drawn level
  through the channel the layout kept for it, turning only in the gaps, which also makes the
  picture what the search's model said it would be. **Arc ends are placed to the pixel** (2, 3):
  each arc leaves its box dead level from a place of its own, in the order that keeps arcs from
  crossing at the box, and arcs that meet end to end at a box take different tracks. **An even fan
  stays centred** (4). **Four rankings are laid out in full at every priority** (the reader's, the
  searched, and the ones priced for crossings above all and for direction above all), so a picture
  found at one setting is there to be chosen at another; the per-piece chooser this replaces is
  gone.
- **Round 2 → 3.** Round 2 was flat: channels fixed some pictures and put shelves in others.
  So **a channel is used only where the straight line is blocked** (3). **A decision's branches
  leave by the diamond's own points** again (they had been sent through channels). **A tree is
  drawn as a tree**, every parent centred (4). **Arcs are shared between the two sides** when
  nothing else decides (2). And **Fit takes in the lines**: fitted to the boxes alone, a line that
  goes round was cut off at the edge of the view, in the editor as in the review pictures.

After all of it, by the numbers (best; ranked alone is 90.1, 196 and 38; annealed 89.4, 213 and
42): score 89.9 against Best fit's 85.0, 200 crossings against 252, 37 lines on lines against 70; on the twelve flows, 11 crossings against 42 and no lines on lines
against 24. The Priority slider is monotone on all 35, counting lines on lines with crossings as
the objective does. The linter's score rose more than the reviewers' did: it counts what is wrong,
and what holds the dense pictures down is how far apart their boxes are, which it doesn't.

**Best fit draws the same way since 2026-11-10** (asked for after the reviews): the nested
bracket arcs, two-lane traffic and centred fans are how every ranked layout is drawn, not this
mode's alone. Best fit over the 35 documents went from 85.0, 252 crossings and 70 lines on lines to
88.9, 235 and 45; on the twelve flows from 42 crossings to 17. What is still this mode's own: the
search, the priority, the four rankings compared as drawn, and lines through their channels.

**Engine C, placing by distance (2026-11-10), and what it showed.** `method: "stress"` ("By
distance" in the menu, `directed/stress.ts`): stress majorization on distances that know how big
the boxes are, with every line a reader follows forward held pointing that way, then boxes pushed
apart and near-misses lined up. No ranks at all. It was built because reviewers said connected
boxes sat too far apart in the dense pictures, and it was tested on exactly those: the twelve
lowest-scoring documents, each drawn ranked and by distance, the 24 pictures shuffled and scored
blind by three reviewers (within one point of each other on every picture).

| Document | Ranked | By distance | | Document | Ranked | By distance |
|---|---|---|---|---|---|---|
| bipartite | 8 | 4 | | real-platform | 5 | 3 |
| flow-mesh | 7 | 3 | | real-services | 4 | 3 |
| flow-tiers | 7 | **9** | | stress-dag | 6 | 3 |
| flow-wide | 7 | 5 | | stress-groups | 3 | 2 |
| largeSystem | 5 | 4 | | stress-hub | 8 | 4 |
| real-data-model | 6 | 5 | | stress-mesh | 5 | 4 |

Mean of medians: ranked 5.9, by distance 4.1. **Readers prefer ranks on eleven of twelve.** What
they marked the by-distance pictures down for is the thing ranks give for free: "boxes zig-zag
with no common column", "staggered boxes with no shared rows or columns", and the long loops round
the outside that follow from it. Boxes being nearer each other did not buy back a grid. So the
first item on the reviewers' list was read wrongly: what costs the dense pictures is not distance.

The one win, `flow-tiers`, was not the engine's doing. Its picture was three groups in a row with
every box in a grid; the ranked picture of the same document had the groups stepping sideways down
the page and a crossing more than it needed. Both were defects in how ranked layouts line groups
up, and both are fixed (item 4 below): drawn ranked again, `flow-tiers` scored 9 from all three,
which leaves by distance without a document it wins.

**"Best of all" does not try it.** With by distance among the pictures `best` compared, the
arrangement's own cost chose it on five documents. Those five pairs went to three more reviewers:

| Document | Ranked | By distance (what the cost chose) |
|---|---|---|
| flow-long-skip | 8 | 5 |
| flow-shortcuts | 7 | 5 |
| flowchart | 8 | 6 |
| mesh | 8 | 7 |
| roughlyPlaced | 7 | 5 |

Readers chose the ranks on all five ("boxes zigzag left and right down the page for no visible
reason, so nearly every link is an S-shaped swoop"; "the same boxes in a straight column or row
scored about 2 to 3 points higher"). The cost counts crossings, lengths and how small the words
come out, and has no charge for boxes that share no row or column, so it cannot be trusted to
choose between a ranked picture and one by distance. `stress` is therefore a method to ask for by
name, and `best` is the best of the ranked ones. Sixteen pairs of seventeen went to the ranks; the
scores are in `gallery/reviews/directed-flow-by-distance.json`.

By the numbers after this (35 documents; score, crossings, lines on lines): best 89.9, 201, 38;
ranked 90.1, 197, 39; annealed 89.3, 214, 43; by distance 86.1, 258, 41; Best fit 88.9, 235, 45.
That `best` measures a hair under what it did with by distance in it (90.2, 197, 37) is the point:
the five pictures it gave up were the ones readers marked down.

And after the price on ranks (item 2 below): best 90.5, 194, 30; ranked 89.9, 203, 39; annealed
89.9, 206, 35. What the reviews of this day say, three times over, is that **the linter's cost
and readers part company on order**: rows and columns that mean something outweigh a handful of
crossings, and the cost has no word for them. Each fix here put one such word in by hand.

**What would move the reviewers next, in the order they put it.**
1. *Dense documents.* Not placement by distance (above). What reviewers name in the ranked
   pictures of the same documents: lines that share a track or pass behind a box, so an end can't
   be followed; return lines that swing wide; one oversized box. Routing, not placement.
2. *A box in a column of its own.* **Done, 2026-11-10.** The search opened a rank for one box
   wherever that saved a crossing. Readers were shown the same flow both ways, blind:

   | `flow-wide` (five sources, five steps, five sinks) | Overall |
   |---|---|
   | Three columns, five crossings | 7, then 8 on a second showing |
   | Four columns, no crossings, one source alone in a column | 7 |
   | Four columns, three crossings, a step standing among the sinks | 6 |
   | Five columns, no crossings, a source and a sink each alone | 6 |

   Every reviewer in both rounds chose the three columns ("its strict Sources | Steps | Sinks
   columns read at a glance despite five crossings"; a box alone "wrongly suggests it sits
   upstream of the others"). `flow-ends` the same: three columns and two crossings, 7; four
   columns and one, 6. A rank is a stage to a reader, and a crossing in a gap is cheap by
   comparison. So **a rank more than the reader's ranking has now costs** (`RANK_COST`), in the
   search and in the comparison of whole pictures: about six crossings at the default priority,
   three and a half at *Crossings above all*, where `best` still takes the fourth column and
   nothing crosses. `measureFlow` reports `ranks`. It changes three documents: the two above, and
   `real-services`, where `best` now finds 29 crossings and 3 lines on lines against 42 and 11
   (reviewers scored an earlier version of that picture 4 against 3; the one that ships was not
   shown again). Directed flow now crosses 16 times on the twelve flows, up from 11, on purpose.
   Scores: `gallery/reviews/directed-flow-columns.json`.
3. *Bunched ends.* A fan of twelve leaves as one trunk. Ends want spreading along the face, and a
   wider gap after a big fan.
4. *Groups stepping sideways.* **Done, 2026-11-10.** Two groups joined by several lines were lined
   up on the average of where those lines leave and land, which puts no line straight and steps
   each group sideways from the last. They now line up on the line in the middle (the weighted
   median), where the most lines run straight; and frames that follow one another on one axis are
   made one width, so a longer name doesn't make a wider tier. `flow-tiers` went from a staircase
   with two crossings to a grid with the one it can't avoid.
5. *Unconnected boxes* parked in a corner, and one box its author drew far larger than what it
   holds (`real-platform`): neither is this mode's doing, both cost every arrangement.
6. *Text* (step 6): labels on lines and on line ends.

Found on the way, and not fixed: **the passes that order a group's boxes against what they join
outside it all move at once**, so two groups facing each other can each answer the order the other
has just left, and trade places every pass without settling (`flow-tiers` did, until the alignment
above happened to hold it still). Taking turns, the way the ranks of a layered drawing are swept,
settles it; but on the gallery it bought nothing the alignment hadn't, and moved one large
document (`real-services`) for the worse or the better depending on which pass it stopped at. Left
as it is until there is a document that needs it.

**Departures from the plan below, and why.**
- **The search prices a model, and the model is not the drawing.** It counts crossings between
  lanes threaded through the ranks; the picture draws a long line straight between its boxes and
  routes it round what's in the way. A ranking the model likes can draw worse. So no single ranking
  is trusted: several are laid out in full and compared as drawn. Since the first review long
  lines follow their lanes, which closes most of the gap; return lines still go round the outside
  as arcs, which the model doesn't know about.
- **Network simplex and Brandes–Köpf were not needed**: the existing ranking and coordinate passes
  are kept, and the search works on top of them.
- **No engine falls back to a ring or a mesh.** A directed flow that comes out as a circle isn't
  one; Best fit is there for those.
- **Engine B (embedding first) is not built.** Engine C (stress with direction) is, as the
  `stress` method; see "Engine C" above for why it is offered by name and not chosen for anyone.
- The measures are a function of their own, not fields of `LayoutReport.metrics`: stress and
  symmetry look at every pair of boxes, and `lintLayout` runs inside the placer's loop.
- Engine B is "embedding first", not upward planarization: positions that cross little are found
  with no ranks at all (stress), and ranks are read off them. A true planarization needs a planar
  embedding and a dual-graph router, which is a project of its own.
- The engines are families of the existing placer, so groups, zones, locks, routing and text all
  work as they do for every other arrangement.

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
