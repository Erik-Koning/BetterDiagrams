/**
 * task-csv.ts — a tracker's CSV export as a task graph.
 *
 * Jira ("Issue key, Summary, Assignee, Status, Custom field (Story Points),
 * Inward issue link (Blocks)…"), Linear ("ID, Title, Status, Assignee,
 * Estimate, Blocked by…") and GitHub ("number, title, state, assignees,
 * labels…") all export issues as a spreadsheet with their own column names.
 * This reads any of them by recognising the columns, not the tracker:
 *
 *   id, title, description, assignees, story points, status, priority, due
 *   date, labels, url, a sprint / epic / parent to group by, and links —
 *   "blocked by" / "depends on" (this waits on those) and "blocks" (those
 *   wait on this), which become prerequisite arrows.
 *
 * A status that reads finished becomes the done check, one that reads under
 * way becomes a stage. Nodes come back unplaced; the caller lays them out.
 * Zero dependencies, like every contract module.
 */
import { normalizeDate } from "../timeline";
import { validateTemplate, type DiagramTemplate, type TaskPriority, type TaskStage } from "../schema";

export interface TaskCsvWarning {
  message: string;
  line?: number;
}

export interface TaskCsvImport {
  template: DiagramTemplate;
  warnings: TaskCsvWarning[];
  stats: { tasks: number; links: number; groups: number; skipped: number };
}

/** RFC 4180 reading — quoted fields, doubled quotes, line breaks in quotes — comma or tab separated. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, "");
  const firstLine = body.slice(0, body.search(/\r?\n/) >= 0 ? body.search(/\r?\n/) : body.length);
  const sep = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");
const COLUMNS: Record<string, RegExp> = {
  id: /^(issue key|key|id|issue id|identifier|number|#|ticket|issue)$/,
  title: /^(summary|title|name|task|issue title)$/,
  description: /^(description|body|details|notes)$/,
  assignees: /^(assignee|assignees|owner|owners|assigned to)$/,
  points: /^(story points?|story point estimate|custom field \(story points?\)|custom field \(story point estimate\)|estimate|points|sp)$/,
  status: /^(status|state|status category)$/,
  priority: /^(priority)$/,
  due: /^(due date|due|due on|target date|deadline)$/,
  labels: /^(labels?|tags?)$/,
  url: /^(url|link|html url|issue url)$/,
  group: /^(sprint|cycle|epic|epic link|epic name|parent|parent summary|milestone|phase|project milestone|custom field \(epic link\)|custom field \(epic name\))$/,
  blockedBy: /^(blocked by|depends on|dependencies|inward issue link \(blocks\)|predecessors?)$/,
  blocks: /^(blocks|blocking|outward issue link \(blocks\)|successors?)$/,
};

/** Which known role each header plays; Jira repeats columns, so a role may own several. */
function mapHeader(header: string[]): Map<string, number[]> {
  const roles = new Map<string, number[]>();
  header.forEach((h, i) => {
    const key = norm(h);
    for (const [role, pattern] of Object.entries(COLUMNS)) {
      if (!pattern.test(key)) continue;
      if (!roles.has(role)) roles.set(role, []);
      roles.get(role)!.push(i);
      break;
    }
  });
  return roles;
}

/** Whether text reads as a tracker export: a header with a title column and one other known role. */
export function looksLikeTaskCsv(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  const rows = parseCsv(trimmed.slice(0, 20_000));
  if (rows.length < 2 || rows[0]!.length < 2) return false;
  const roles = mapHeader(rows[0]!);
  return roles.has("title") && ["id", "status", "assignees", "points", "blockedBy", "blocks", "priority"].some((r) => roles.has(r));
}

const STAGE_OF = (status: string): { done?: true; stage?: TaskStage } => {
  const s = status.toLowerCase();
  if (/\b(done|closed|complete|completed|resolved|finished|shipped|merged|released|cancel+ed|won'?t (do|fix)|duplicate)\b/.test(s)) return { done: true };
  if (/\b(review|in qa|qa|testing|verify|verification|approval)\b/.test(s)) return { stage: "in-review" };
  if (/\b(progress|doing|started|active|development|developing|working|wip)\b/.test(s)) return { stage: "in-progress" };
  return {};
};

const PRIORITY_OF = (raw: string): TaskPriority | undefined => {
  const s = raw.trim().toLowerCase();
  if (!s || /^(no priority|none|-)$/.test(s)) return undefined;
  if (/(highest|urgent|critical|blocker|^p0$|^0$|^1 ?- ?urgent)/.test(s)) return "p0";
  if (/(^high$|major|^p1$|^1$|^2 ?- ?high)/.test(s)) return "p1";
  if (/(medium|normal|^p2$|^2$|^3 ?- ?medium)/.test(s)) return "p2";
  if (/(low|lowest|minor|trivial|^p3$|^p4$|^3$|^4$|^4 ?- ?low)/.test(s)) return "p3";
  return undefined;
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A tracker's date: ISO, Jira's "15/Jun/26 12:00 AM", or "Jun 15, 2026". */
function dateOf(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const jira = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2,4})/.exec(s);
  if (jira) {
    const month = MONTHS[jira[2]!.toLowerCase()];
    const year = jira[3]!.length === 2 ? 2000 + Number(jira[3]) : Number(jira[3]);
    if (month) return normalizeDate(`${year}-${month}-${jira[1]}`);
  }
  const worded = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s);
  if (worded) {
    const month = MONTHS[worded[1]!.toLowerCase()];
    if (month) return normalizeDate(`${worded[3]}-${month}-${worded[2]}`);
  }
  return normalizeDate(s);
}

const listOf = (raw: string) =>
  raw
    .split(/[;,|\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";

export interface TaskCsvOptions {
  /** The diagram's title; "Imported tasks" by default. */
  title?: string;
}

/** Read a tracker's CSV export as a task graph, unplaced. */
export function importTaskCsv(text: string, opts: TaskCsvOptions = {}): TaskCsvImport {
  const rows = parseCsv(text);
  const warnings: TaskCsvWarning[] = [];
  const header = rows[0] ?? [];
  const roles = mapHeader(header);
  const cells = (row: string[], role: string) => (roles.get(role) ?? []).map((i) => (row[i] ?? "").trim()).filter(Boolean);
  const first = (row: string[], role: string) => cells(row, role)[0] ?? "";

  if (!roles.has("title")) {
    warnings.push({ message: "No title or summary column — nothing to import" });
    return { template: validateTemplate({ version: 1, nodes: [], edges: [] }), warnings, stats: { tasks: 0, links: 0, groups: 0, skipped: rows.length - 1 } };
  }

  const nodes: Array<Record<string, unknown>> = [];
  const groups = new Map<string, string>();
  const used = new Set<string>();
  const idOfKey = new Map<string, string>();
  const pending: Array<{ id: string; blockedBy: string[]; blocks: string[]; line: number }> = [];
  let skipped = 0;

  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    const title = first(row, "title");
    if (!title) {
      skipped += 1;
      warnings.push({ message: "Row has no title — skipped", line });
      return;
    }
    const key = first(row, "id");
    let id = slug(key || title);
    for (let n = 2; used.has(id); n++) id = `${slug(key || title)}-${n}`;
    used.add(id);
    if (key) idOfKey.set(key.toLowerCase(), id);
    idOfKey.set(title.toLowerCase(), idOfKey.get(title.toLowerCase()) ?? id);

    const groupName = first(row, "group");
    let parentId: string | null = null;
    if (groupName) {
      if (!groups.has(groupName)) {
        let gid = `group-${slug(groupName)}`;
        for (let n = 2; used.has(gid); n++) gid = `group-${slug(groupName)}-${n}`;
        used.add(gid);
        groups.set(groupName, gid);
        nodes.push({ id: gid, label: groupName, kind: "group", x: 0, y: 0 });
      }
      parentId = groups.get(groupName)!;
    }

    const pointsRaw = first(row, "points");
    const points = pointsRaw ? Number(pointsRaw) : NaN;
    const status = first(row, "status");
    const due = dateOf(first(row, "due"));
    if (first(row, "due") && !due) warnings.push({ message: `Couldn't read the due date "${first(row, "due")}"`, line });
    nodes.push({
      id,
      label: title,
      kind: "task",
      x: 0,
      y: 0,
      parentId,
      ...(first(row, "description") ? { description: first(row, "description") } : {}),
      ...(cells(row, "assignees").length ? { assignees: cells(row, "assignees").flatMap(listOf) } : {}),
      ...(Number.isFinite(points) && points >= 0 ? { storyPoints: points } : {}),
      ...STAGE_OF(status),
      ...(PRIORITY_OF(first(row, "priority")) ? { priority: PRIORITY_OF(first(row, "priority")) } : {}),
      ...(due ? { date: due } : {}),
      ...(cells(row, "labels").length ? { tags: cells(row, "labels").flatMap(listOf) } : {}),
      ...(first(row, "url") ? { url: first(row, "url") } : {}),
    });
    pending.push({ id, blockedBy: cells(row, "blockedBy").flatMap(listOf), blocks: cells(row, "blocks").flatMap(listOf), line });
  });

  // Links last, once every key is known: "blocked by X" is X → this, "blocks Y" is this → Y.
  const edges: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const link = (source: string, target: string) => {
    const pair = `${source}\u0000${target}`;
    if (source === target || seen.has(pair)) return;
    seen.add(pair);
    edges.push({ id: `${source}--${target}`, source, target });
  };
  for (const p of pending) {
    for (const ref of p.blockedBy) {
      const from = idOfKey.get(ref.toLowerCase());
      if (from) link(from, p.id);
      else warnings.push({ message: `"${ref}" isn't in this export — that link was left out`, line: p.line });
    }
    for (const ref of p.blocks) {
      const to = idOfKey.get(ref.toLowerCase());
      if (to) link(p.id, to);
      else warnings.push({ message: `"${ref}" isn't in this export — that link was left out`, line: p.line });
    }
  }

  const template = validateTemplate({ version: 1, meta: { title: opts.title ?? "Imported tasks" }, nodes, edges });
  return {
    template,
    warnings,
    stats: { tasks: template.nodes.filter((n) => n.kind === "task").length, links: template.edges.length, groups: groups.size, skipped },
  };
}
