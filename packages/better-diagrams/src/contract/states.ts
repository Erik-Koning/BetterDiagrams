/**
 * states.ts — enumerating a document's visual states.
 *
 * A diagram is one document but potentially many pictures: each zone can be
 * switched between providers, and dated elements make the document look
 * different at every timeline stop. This module names that state space so an
 * exporter can walk it — "every combination of zone providers × timeline
 * stops" — without the studio improvising the product logic inline.
 *
 * Two deliberate simplifications:
 *
 * - The date axis is exactly the stop list. A hide-mode slice at the LAST
 *   stop shows everything (nothing can be dated after the latest date), so
 *   "timeline off" is not a distinct state and earns no extra entry.
 * - A combination always slices in `hide` mode. `dim` needs renderer-side
 *   future-sets the static emitters don't take; a frozen export of a state
 *   should simply not contain what isn't there yet.
 *
 * Everything here is pure `document → value`; materializing a combo never
 * touches the input template.
 */

import { setZoneProvider, type DiagramTemplate } from "./schema";
import type { SequenceTemplate } from "./sequence";
import {
  formatDiagramDate,
  sequenceTimeline,
  sequenceTimelineView,
  templateTimeline,
  timelineView,
  type DiagramDate,
} from "./timeline";

/** One switchable zone — an axis of the state space. */
export interface ZoneAxis {
  zoneId: string;
  /** The zone's display label, for UI copy. */
  label: string;
  /** Filename-safe identifier, unique across the axes of one document. */
  slug: string;
  /** The providers this zone can show, in the zone's declared order. */
  providers: string[];
  /** The provider the document currently sits on. */
  current: string;
}

/** The full state space of one document. */
export interface StateAxes {
  /** Zones that actually vary — a single-provider zone is scenery, not an axis. */
  zones: ZoneAxis[];
  /** Every distinct date in the document, ascending. Empty = no date axis. */
  stops: DiagramDate[];
}

/** One point in the state space — everything needed to materialize a picture. */
export interface StateCombo {
  /** zoneId → provider to force. Empty when the document has no zone axes. */
  providers: Record<string, string>;
  /** Timeline slice date; null when the document has no date axis. */
  at: DiagramDate | null;
}

/** A subset of the space. An omitted key means "all of that axis". */
export interface StateSelection {
  providers?: Record<string, string[]>;
  stops?: DiagramDate[];
}

/** Lowercase, runs of anything unsafe collapsed to `-`. May come out empty. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function zoneAxes(zones: DiagramTemplate["zones"]): ZoneAxis[] {
  const axes = (zones ?? [])
    .filter((z) => z.providers.length >= 2)
    .map((z) => ({
      zoneId: z.id,
      label: z.label,
      slug: slugify(z.label) || slugify(z.id) || "zone",
      providers: [...z.providers],
      current: z.provider,
    }));
  // Two zones labelled "Region" must not merge in filenames — suffix the
  // later ones rather than silently colliding.
  const seen = new Map<string, number>();
  for (const axis of axes) {
    const count = seen.get(axis.slug) ?? 0;
    seen.set(axis.slug, count + 1);
    if (count > 0) axis.slug = `${axis.slug}-${count + 1}`;
  }
  return axes;
}

/** The state space of an architecture document. */
export function templateStateAxes(template: DiagramTemplate): StateAxes {
  return { zones: zoneAxes(template.zones), stops: templateTimeline(template).stops };
}

/** The state space of a sequence document — dates only, sequences have no zones. */
export function sequenceStateAxes(template: SequenceTemplate): StateAxes {
  return { zones: [], stops: sequenceTimeline(template).stops };
}

/**
 * Filter a selection through the axis's canonical order. Checkbox click order
 * must not leak into export order, and unknown ids must not smuggle in states
 * the document doesn't have.
 */
function selectedProviders(axis: ZoneAxis, selection?: StateSelection): string[] {
  const wanted = selection?.providers?.[axis.zoneId];
  return wanted ? axis.providers.filter((p) => wanted.includes(p)) : axis.providers;
}

function selectedStops(axes: StateAxes, selection?: StateSelection): DiagramDate[] {
  const wanted = selection?.stops;
  return wanted ? axes.stops.filter((s) => wanted.includes(s)) : axes.stops;
}

/**
 * How many combos a selection produces, without allocating them — this drives
 * a live count label. Any existing axis emptied by the selection collapses the
 * product to 0 (there is nothing coherent to export).
 */
export function countStateCombos(axes: StateAxes, selection?: StateSelection): number {
  let count = axes.stops.length === 0 ? 1 : selectedStops(axes, selection).length;
  for (const axis of axes.zones) count *= selectedProviders(axis, selection).length;
  return count;
}

/**
 * Every combo of a selection, in the canonical order: zone axes in document
 * order vary slowest, timeline stops ascending vary fastest — "the whole Azure
 * roadmap, then the whole AWS roadmap".
 */
export function enumerateStateCombos(axes: StateAxes, selection?: StateSelection): StateCombo[] {
  const dates: (DiagramDate | null)[] =
    axes.stops.length === 0 ? [null] : selectedStops(axes, selection);

  let partials: Record<string, string>[] = [{}];
  for (const axis of axes.zones) {
    const providers = selectedProviders(axis, selection);
    const next: Record<string, string>[] = [];
    for (const partial of partials) {
      for (const provider of providers) next.push({ ...partial, [axis.zoneId]: provider });
    }
    partials = next;
  }

  const combos: StateCombo[] = [];
  for (const providers of partials) {
    for (const at of dates) combos.push({ providers, at });
  }
  return combos;
}

/** Human-readable name for a combo: `Region: aws · Jun 15 ’26`. */
export function comboLabel(axes: StateAxes, combo: StateCombo): string {
  const parts: string[] = [];
  for (const axis of axes.zones) {
    const provider = combo.providers[axis.zoneId];
    if (provider) parts.push(`${axis.label}: ${provider}`);
  }
  if (combo.at) parts.push(formatDiagramDate(combo.at, { year: "always" }));
  return parts.join(" · ");
}

/**
 * Filename suffix for a combo: `--region-aws--2026-06-15`. Empty for the
 * null combo, so single-state filenames stay exactly what they always were.
 */
export function comboSlug(axes: StateAxes, combo: StateCombo): string {
  const parts: string[] = [];
  for (const axis of axes.zones) {
    const provider = combo.providers[axis.zoneId];
    if (provider) parts.push(`--${axis.slug}-${slugify(provider) || provider}`);
  }
  if (combo.at) parts.push(`--${combo.at}`);
  return parts.join("");
}

/**
 * The architecture document AS that combo: providers forced, future elements
 * genuinely removed. A view document, never something to save — and the input
 * is never mutated, so the live editor state is safe to materialize from.
 */
export function materializeCombo(template: DiagramTemplate, combo: StateCombo): DiagramTemplate {
  let doc = template;
  for (const [zoneId, provider] of Object.entries(combo.providers)) {
    doc = setZoneProvider(doc, zoneId, provider);
  }
  return timelineView(doc, combo.at, "hide").template;
}

/** Sequence twin of `materializeCombo` — the date axis is the only axis. */
export function materializeSequenceCombo(
  template: SequenceTemplate,
  combo: StateCombo,
): SequenceTemplate {
  return sequenceTimelineView(template, combo.at, "hide").template;
}
