/**
 * data-model-lint.ts — schema-quality checks for data models.
 *
 * The architecture rules in lint.ts ask whether a system is wired sensibly;
 * these ask what a data reviewer asks of a schema: does every table have a
 * key, does every `*_id` that looks like a reference declare one, do the two
 * halves of a join agree on a type, does a reference point at anything, is a
 * composed child required to name its parent.
 *
 * Every rule considers TABLES only (`storesFields`), so an architecture
 * document gets no noise from them, and names the columns it is about
 * (`fields`), so the editor marks the rows when it goes to a finding. The
 * `lint-ignore` tag works on a table and on a row. Everything reads one
 * cached pass of field records, so the whole set is linear in fields + edges
 * — it runs on every committed edit.
 *
 * Zero dependencies, like every contract module.
 */
import type { DiagramTemplate } from "./schema";
import type { LintFix, LintIssue, LintRuleDef, LintSeverity } from "./lint";
import { lintIgnored } from "./lint-ignore";
import { cachedFieldRecords, keyResolver, tableProfile, type FieldRecord, type FieldTarget } from "./fields";
import { storesFields } from "./coverage";
import { fieldUsage, inconsistencySummary } from "./key-usage";
import { DEFAULT_TYPE_ALIASES, normalizeType } from "./type-families";
import { sensitivityHints } from "./sensitivity";

type Node = DiagramTemplate["nodes"][number];

export interface DataModelLintOptions {
  /**
   * What a reference's name looks like: the first capture group is the stem
   * naming the table (`customer` in `customer_id`, `Customer` in `CustomerId`).
   */
  referencePatterns?: RegExp[];
  /** Spelling → family for type comparison; see type-families.ts. */
  typeAliases?: Readonly<Record<string, string>>;
  /**
   * Naming convention, off unless given: patterns a table and a column name
   * must match, or `"majority"` — the model's own majority case style.
   */
  naming?: { table?: RegExp; column?: RegExp } | "majority";
  /** Change a rule's severity, or switch it off. */
  severity?: Partial<Record<string, LintSeverity | "off">>;
}

export const DEFAULT_REFERENCE_PATTERNS: readonly RegExp[] = [/^(.+?)_id$/i, /^(.+[a-z0-9])Id$/, /^(.+?)_fk$/i];

const modelOf = (node: Node): Record<string, unknown> | undefined => {
  const m = node.data?.model;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
};
/** "2.5%", "<0.1%" — an observed share in a message. */
const percent = (rate: number) => (rate < 0.001 ? "<0.1%" : `${Math.round(rate * 1000) / 10}%`);
/** Letters and digits only, lowercased — how names are compared. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The singular forms a table name may take ("categories" → "category", "orders" → "order"). */
function singulars(name: string): string[] {
  const out = [name];
  if (name.endsWith("ies")) out.push(`${name.slice(0, -3)}y`);
  if (name.endsWith("es")) out.push(name.slice(0, -2));
  if (name.endsWith("s")) out.push(name.slice(0, -1));
  return out;
}
const isKeyRecord = (r: FieldRecord) => r.key === "pk" || r.key === "pfk";

/** Everything a pass of the rules shares: the tables, their records, labels. */
function context(t: DiagramTemplate) {
  const tables = t.nodes.filter(storesFields);
  const records = cachedFieldRecords(t);
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const label = (id: string) => byId.get(id)?.label ?? id;
  const fieldIgnored = (record: FieldRecord, rule: string) => lintIgnored({ tags: record.tags }, rule);
  // Indexed on first use: only the rules that follow references pay for it.
  let resolve: ((target: FieldTarget) => ReturnType<ReturnType<typeof keyResolver>>) | undefined;
  const keyOf = (target: FieldTarget) => (resolve ??= keyResolver(t))(target);
  return { tables, records, byId, label, fieldIgnored, keyOf };
}

/**
 * The data-model rule set. The defaults are part of `BUILTIN_LINT_RULES`;
 * call this with options to tune them, and pass the result through
 * `registry.lintRules` as with any rule.
 */
export function dataModelLintRules(opts: DataModelLintOptions = {}): Record<string, LintRuleDef> {
  const patterns = opts.referencePatterns ?? DEFAULT_REFERENCE_PATTERNS;
  const aliases = opts.typeAliases ?? DEFAULT_TYPE_ALIASES;
  const rules: Record<string, LintRuleDef> = {
    "dm-no-primary-key": {
      label: "Table without a primary key",
      description: "A table no row identifies: joins, updates and deduplication have nothing to hold on to.",
      severity: "warning",
      check(t) {
        const { tables, records } = context(t);
        return tables
          .filter((n) => !lintIgnored(n, "dm-no-primary-key") && !(records.get(n.id) ?? []).some(isKeyRecord))
          .map((n) => ({ message: `"${n.label}" has no primary key`, nodeIds: [n.id] }));
      },
    },

    "dm-undeclared-reference": {
      label: "Undeclared reference",
      description: "A column named like a reference to another table, with nothing declaring it.",
      severity: "warning",
      check(t) {
        const { tables, records, label, fieldIgnored } = context(t);
        // Every name a table answers to, squashed, singular and plural.
        const tableByName = new Map<string, string>();
        for (const n of tables) {
          const names = [modelOf(n)?.name, n.label, n.id].filter((x): x is string => typeof x === "string" && !!x);
          for (const name of names) for (const form of singulars(squash(name))) if (!tableByName.has(form)) tableByName.set(form, n.id);
        }
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-undeclared-reference")) continue;
          for (const r of records.get(n.id) ?? []) {
            if (r.fk.length || isKeyRecord(r) || fieldIgnored(r, "dm-undeclared-reference")) continue;
            let target: string | undefined;
            for (const p of patterns) {
              const stem = p.exec(r.name)?.[1];
              if (!stem) continue;
              target = tableByName.get(squash(stem));
              if (target) break;
            }
            if (!target || target === n.id) continue;
            out.push({
              message: `"${label(n.id)}.${r.name}" looks like a reference to ${label(target)}, but nothing declares it`,
              nodeIds: [n.id, target],
              fields: [{ nodeId: n.id, fieldId: r.id }],
              ...(r.row ? { fix: { kind: "draw-reference", label: `Draw the reference to ${label(target)}`, from: { nodeId: n.id, fieldId: r.id }, to: target } satisfies LintFix } : {}),
            });
          }
        }
        return out;
      },
    },

    "dm-key-type-mismatch": {
      label: "Key type mismatch",
      description: "A reference stored as a different type from the key it points at.",
      severity: "error",
      check(t) {
        const { tables, records, label, fieldIgnored, keyOf } = context(t);
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-key-type-mismatch")) continue;
          for (const r of records.get(n.id) ?? []) {
            if (!r.storageType || fieldIgnored(r, "dm-key-type-mismatch")) continue;
            const mine = normalizeType(r.storageType, aliases).family;
            const seen = new Set<string>();
            for (const target of r.fk) {
              if (!target.nodeId || seen.has(target.nodeId)) continue;
              seen.add(target.nodeId);
              const key = keyOf(target);
              const landing = key ? records.get(key.nodeId)?.find((x) => x.id === key.fieldId) : undefined;
              if (!landing?.storageType) continue;
              const theirs = normalizeType(landing.storageType, aliases).family;
              if (mine === theirs) continue;
              out.push({
                message: `"${label(n.id)}.${r.name}" is ${r.storageType} but points at ${label(target.nodeId)}.${landing.name}, which is ${landing.storageType}`,
                nodeIds: [n.id, target.nodeId],
                fields: [{ nodeId: n.id, fieldId: r.id }, { nodeId: target.nodeId, fieldId: landing.id }],
              });
            }
          }
        }
        return out;
      },
    },

    "dm-unresolved-reference": {
      label: "Reference to nothing in the model",
      description: "A reference naming a table the model doesn't have.",
      severity: "warning",
      check(t) {
        const { tables, records, byId, label, fieldIgnored } = context(t);
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-unresolved-reference")) continue;
          for (const r of records.get(n.id) ?? []) {
            if (fieldIgnored(r, "dm-unresolved-reference")) continue;
            for (const target of r.fk) {
              if (!target.nodeId) {
                out.push({
                  message: `"${label(n.id)}.${r.name}" references "${target.label}", which is not in the model`,
                  nodeIds: [n.id],
                  fields: [{ nodeId: n.id, fieldId: r.id }],
                });
              } else if (modelOf(byId.get(target.nodeId)!)?.shape === "external") {
                out.push({
                  message: `"${label(n.id)}.${r.name}" points outside the model, at ${label(target.nodeId)}`,
                  nodeIds: [n.id],
                  fields: [{ nodeId: n.id, fieldId: r.id }],
                  severity: "info",
                });
              }
            }
          }
        }
        return out;
      },
    },

    "dm-optional-composition": {
      label: "Composition with an optional key",
      description: "A composed child must name its parent: its key cannot be nullable.",
      severity: "warning",
      check(t) {
        const { records, byId, label } = context(t);
        const out: LintIssue[] = [];
        for (const e of t.edges) {
          const model = (e.data?.model && typeof e.data.model === "object" ? e.data.model : {}) as Record<string, unknown>;
          if (e.relation !== "composition" && model.kind !== "composition") continue;
          const source = byId.get(e.source);
          if (!source || lintIgnored(source, "dm-optional-composition")) continue;
          const fieldId = e.startField ?? (typeof model.field === "string" ? model.field : undefined);
          const record = fieldId ? records.get(e.source)?.find((r) => r.id === fieldId) : undefined;
          const optional = model.required === false || record?.nullable === true;
          if (!optional) continue;
          out.push({
            message: `${label(e.source)} is composed into ${label(e.target)}, but its key${record ? ` ${record.name}` : ""} may be empty`,
            nodeIds: [e.source, e.target],
            edgeIds: [e.id],
            ...(record ? { fields: [{ nodeId: e.source, fieldId: record.id }] } : {}),
          });
        }
        return out;
      },
    },

    "dm-duplicate-name": {
      label: "Near-duplicate column names",
      description: "Two columns in one table whose names differ only by case or underscores.",
      severity: "warning",
      check(t) {
        const { tables, records, label } = context(t);
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-duplicate-name")) continue;
          const seen = new Map<string, FieldRecord>();
          for (const r of records.get(n.id) ?? []) {
            const key = squash(r.name);
            const first = seen.get(key);
            if (!first) {
              seen.set(key, r);
              continue;
            }
            if (first.name === r.name) continue;
            out.push({
              message: `"${label(n.id)}" has both ${first.name} and ${r.name}`,
              nodeIds: [n.id],
              fields: [{ nodeId: n.id, fieldId: first.id }, { nodeId: n.id, fieldId: r.id }],
            });
          }
        }
        return out;
      },
    },

    "dm-inconsistent-type": {
      label: "Column stored inconsistently",
      description: "One column name stored as different types, or nullable in some tables and required in others.",
      severity: "info",
      check(t) {
        const index = fieldUsage(t, { typeAliases: aliases });
        const out: LintIssue[] = [];
        for (const f of index.fields) {
          if (f.consistent) continue;
          // The deviating tables: every variant but the most common one.
          const deviating = f.variants.slice(1).flatMap((v) => v.tables);
          const tables = deviating.length ? deviating : f.variants.flatMap((v) => v.tables);
          out.push({
            message: `${f.name}: ${inconsistencySummary(f)} (${f.tables.length} tables)`,
            nodeIds: [...new Set(tables.map((x) => x.nodeId))],
            fields: tables,
          });
        }
        return out;
      },
    },

    "dm-polymorphic-reference": {
      label: "Polymorphic reference",
      description: "A reference that can point at more than one table: a join needs to check the target's type.",
      severity: "info",
      check(t) {
        const { tables, records, label, fieldIgnored } = context(t);
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-polymorphic-reference")) continue;
          for (const r of records.get(n.id) ?? []) {
            if (r.fk.length < 2 || fieldIgnored(r, "dm-polymorphic-reference")) continue;
            out.push({
              message: `"${label(n.id)}.${r.name}" can point at ${r.fk.length} tables (${r.fk.map((x) => x.label).slice(0, 4).join(", ")}${r.fk.length > 4 ? ", …" : ""})`,
              nodeIds: [n.id],
              fields: [{ nodeId: n.id, fieldId: r.id }],
            });
          }
        }
        return out;
      },
    },

    "dm-truncated-fields": {
      label: "Field list cut short",
      description: "The import kept only the first fields of this table; every analysis sees only those.",
      severity: "info",
      check(t) {
        return context(t)
          .tables.filter((n) => modelOf(n)?.fieldsTruncated === true && !lintIgnored(n, "dm-truncated-fields"))
          .map((n) => ({ message: `"${n.label}" lists only its first fields; checks and counts see only those`, nodeIds: [n.id] }));
      },
    },

    "dm-untagged-sensitive": {
      label: "Looks sensitive, not tagged",
      description: "A column whose name says it holds personal data — an email, a phone number, a date of birth — carries no sensitive tag, so governance doesn't count it.",
      severity: "info",
      check(t) {
        const { records, label } = context(t);
        return sensitivityHints(t).map((h) => {
          const r = records.get(h.ref.nodeId)?.find((x) => x.id === h.ref.fieldId);
          return {
            message: `"${label(h.ref.nodeId)}.${r?.name ?? h.ref.fieldId}" looks like ${h.what} but carries no sensitive tag`,
            nodeIds: [h.ref.nodeId],
            fields: [h.ref],
            // A drawn row can take the tag; a column only the data knows has no row to carry it.
            ...(r?.row ? { fix: { kind: "tag-field", label: `Tag ${h.tag}`, field: h.ref, tag: h.tag } satisfies LintFix } : {}),
          };
        });
      },
    },

    // ── Declared against observed: these read a profiling run's numbers
    //    (`FieldRecord.profile`, the table's `data.model.profile`) and say
    //    nothing about a table nobody profiled. ──

    "dm-required-has-nulls": {
      label: "Required column with nulls",
      description: "Declared NOT NULL (or a key), yet profiling found null values.",
      severity: "warning",
      check(t) {
        const { tables, records, fieldIgnored } = context(t);
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-required-has-nulls")) continue;
          for (const r of records.get(n.id) ?? []) {
            const rate = r.profile?.nullRate;
            if (!rate || fieldIgnored(r, "dm-required-has-nulls")) continue;
            const declared = r.required || r.nullable === false || r.key === "pk" || r.key === "pfk";
            if (!declared) continue;
            out.push({
              message: `"${n.label}.${r.name}" is declared required, but ${percent(rate)} of rows are null`,
              nodeIds: [n.id],
              fields: [{ nodeId: n.id, fieldId: r.id }],
            });
          }
        }
        return out;
      },
    },

    "dm-unique-has-duplicates": {
      label: "Unique column with duplicates",
      description: "Declared unique (or the table's one-column key), yet profiling found fewer distinct values than rows.",
      severity: "warning",
      check(t) {
        const { tables, records, fieldIgnored } = context(t);
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-unique-has-duplicates")) continue;
          const list = records.get(n.id) ?? [];
          const rows = tableProfile(n)?.rowCount ?? (typeof modelOf(n)?.recordCount === "number" ? (modelOf(n)!.recordCount as number) : undefined);
          if (rows === undefined) continue;
          const keyColumns = list.filter((r) => r.key === "pk" || r.key === "pfk");
          for (const r of list) {
            const distinct = r.profile?.distinct;
            if (distinct === undefined || fieldIgnored(r, "dm-unique-has-duplicates")) continue;
            // One column of a composite key repeats by design.
            const declared = r.unique || (keyColumns.length === 1 && keyColumns[0] === r);
            if (!declared) continue;
            const nonNull = Math.round(rows * (1 - (r.profile?.nullRate ?? 0)));
            if (distinct >= nonNull) continue;
            out.push({
              message: `"${n.label}.${r.name}" is declared unique, but has ${distinct.toLocaleString("en-US")} distinct values in ${nonNull.toLocaleString("en-US")} rows`,
              nodeIds: [n.id],
              fields: [{ nodeId: n.id, fieldId: r.id }],
            });
          }
        }
        return out;
      },
    },

    "dm-orphaned-references": {
      label: "References to missing rows",
      description: "Profiling found foreign-key values that match no row of the table they reference.",
      severity: "warning",
      check(t) {
        const { tables, records, label, fieldIgnored } = context(t);
        const out: LintIssue[] = [];
        for (const n of tables) {
          if (lintIgnored(n, "dm-orphaned-references")) continue;
          for (const r of records.get(n.id) ?? []) {
            const rate = r.profile?.orphanRate;
            if (!rate || fieldIgnored(r, "dm-orphaned-references")) continue;
            const target = r.fk[0];
            out.push({
              message: `"${n.label}.${r.name}": ${percent(rate)} of values match no row${target ? ` of ${target.nodeId ? label(target.nodeId) : target.label}` : ""}`,
              nodeIds: [n.id, ...(target?.nodeId ? [target.nodeId] : [])],
              fields: [{ nodeId: n.id, fieldId: r.id }],
            });
          }
        }
        return out;
      },
    },
  };

  if (opts.naming) {
    const naming = opts.naming;
    rules["dm-naming"] = {
      label: "Naming convention",
      description: naming === "majority" ? "Columns cased unlike most of the model's." : "Names that break the configured convention.",
      severity: "info",
      check(t) {
        const { tables, records, fieldIgnored } = context(t);
        const out: LintIssue[] = [];
        const style = (name: string) =>
          /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name) ? "snake_case"
          : /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(name) ? "camelCase"
          : /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(name) ? "PascalCase"
          : null;
        let majority: string | null = null;
        if (naming === "majority") {
          const counts = new Map<string, number>();
          for (const n of tables) for (const r of records.get(n.id) ?? []) {
            const s = style(r.name);
            if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
          }
          majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        }
        for (const n of tables) {
          if (lintIgnored(n, "dm-naming")) continue;
          if (naming !== "majority" && naming.table && !naming.table.test(n.label)) {
            out.push({ message: `Table "${n.label}" breaks the naming convention`, nodeIds: [n.id] });
          }
          const bad = (records.get(n.id) ?? []).filter((r) => {
            if (fieldIgnored(r, "dm-naming")) return false;
            if (naming === "majority") {
              const s = style(r.name);
              return !!majority && !!s && s !== majority;
            }
            return !!naming.column && !naming.column.test(r.name);
          });
          if (bad.length) {
            out.push({
              message: `"${n.label}": ${bad.map((r) => r.name).slice(0, 5).join(", ")}${bad.length > 5 ? ", …" : ""} ${naming === "majority" ? `not ${majority}` : "break the convention"}`,
              nodeIds: [n.id],
              fields: bad.map((r) => ({ nodeId: n.id, fieldId: r.id })),
            });
          }
        }
        return out;
      },
    };
  }

  for (const [id, sev] of Object.entries(opts.severity ?? {})) {
    if (sev === "off") delete rules[id];
    else if (sev && rules[id]) rules[id] = { ...rules[id]!, severity: sev };
  }
  return rules;
}
