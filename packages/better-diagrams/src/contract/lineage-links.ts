/**
 * lineage-links.ts — the shape of a document's `lineage` list and its
 * repair, apart from the analyses in lineage.ts so the schema can validate
 * it without importing anything at runtime.
 */
import type { FieldRef } from "./fields";

export interface LineageLink {
  id: string;
  /** The column the values come from. */
  from: FieldRef;
  /** The column they are written to. */
  to: FieldRef;
  /** How ("amount * fx_rate", "IDENTITY", "SUM"). */
  transform?: string;
  /** What did it (a job, a dbt model, a pipeline step). */
  job?: string;
}

export const MAX_LINEAGE = 50_000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function refOf(v: unknown, nodeIds: ReadonlySet<string> | null): FieldRef | null {
  if (!isRecord(v) || typeof v.nodeId !== "string" || typeof v.fieldId !== "string" || !v.nodeId || !v.fieldId) return null;
  if (nodeIds && !nodeIds.has(v.nodeId)) return null;
  return { nodeId: v.nodeId, fieldId: v.fieldId };
}

/**
 * Repair a lineage list: a link needs an id and two column references; a
 * link to a table the document no longer has is dropped (`nodeIds`), and so
 * is a column feeding itself or a repeated id.
 */
export function validateLineage(raw: unknown, ctx: { nodeIds?: ReadonlySet<string> } = {}): LineageLink[] {
  if (!Array.isArray(raw)) return [];
  const out: LineageLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_LINEAGE) break;
    if (!isRecord(item)) continue;
    const id = text(item.id, 200);
    const from = refOf(item.from, ctx.nodeIds ?? null);
    const to = refOf(item.to, ctx.nodeIds ?? null);
    if (!id || seen.has(id) || !from || !to || (from.nodeId === to.nodeId && from.fieldId === to.fieldId)) continue;
    seen.add(id);
    const transform = text(item.transform, 1000);
    const job = text(item.job, 300);
    out.push({ id, from, to, ...(transform ? { transform } : {}), ...(job ? { job } : {}) });
  }
  return out;
}

