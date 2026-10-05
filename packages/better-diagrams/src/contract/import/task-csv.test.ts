/** A tracker's CSV export as a task graph — read by its columns, whichever tracker wrote it. */
import { describe, expect, it } from "vitest";
import { importTaskCsv, looksLikeTaskCsv, parseCsv } from "./task-csv";

const JIRA = [
  "Summary,Issue key,Issue Type,Status,Priority,Assignee,Due date,Sprint,Custom field (Story Points),Inward issue link (Blocks),Inward issue link (Blocks),Description",
  'Write spec,WEB-1,Story,Done,Medium,Ana Silva,01/Jun/26 12:00 AM,Sprint 1,3,,,"Scope, metrics"',
  "Build API,WEB-2,Story,In Progress,High,Ravi,15/Jun/26 12:00 AM,Sprint 1,8,WEB-1,,",
  'Build UI,WEB-3,Story,To Do,Highest,"Mo",,Sprint 2,5,WEB-1,,',
  "QA pass,WEB-4,Task,In Review,Low,,,Sprint 2,2,WEB-2,WEB-3,",
].join("\n");

const LINEAR = [
  "ID,Title,Status,Priority,Assignee,Estimate,Cycle,Blocked by",
  "ENG-10,Set up CI,Completed,Urgent,ana@acme.dev,2,Cycle 4,",
  "ENG-11,Deploy staging,Backlog,No priority,,3,Cycle 4,ENG-10",
].join("\n");

const GITHUB = ["number\ttitle\tstate\tassignees\tlabels", "12\tFix login\topen\tana, ravi\tbug, auth", "13\tUpdate docs\tclosed\t\tdocs"].join("\n");

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, line breaks in quotes, and tabs", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("looksLikeTaskCsv", () => {
  it("recognises a tracker export, and not JSON, SQL or prose", () => {
    expect(looksLikeTaskCsv(JIRA)).toBe(true);
    expect(looksLikeTaskCsv(LINEAR)).toBe(true);
    expect(looksLikeTaskCsv(GITHUB)).toBe(true);
    expect(looksLikeTaskCsv('{"nodes":[]}')).toBe(false);
    expect(looksLikeTaskCsv("CREATE TABLE users (id int);")).toBe(false);
    expect(looksLikeTaskCsv("just some words, really")).toBe(false);
  });
});

describe("importTaskCsv", () => {
  it("reads a Jira export: status, priority, points, due dates, sprints and blocking links", () => {
    const { template, stats } = importTaskCsv(JIRA, { title: "Web" });
    const byId = new Map(template.nodes.map((n) => [n.id, n]));
    expect(stats).toEqual({ tasks: 4, links: 4, groups: 2, skipped: 0 });
    expect(byId.get("web-1")).toMatchObject({ label: "Write spec", done: true, storyPoints: 3, priority: "p2", date: "2026-06-01", assignees: ["Ana Silva"], description: "Scope, metrics" });
    expect(byId.get("web-2")).toMatchObject({ stage: "in-progress", priority: "p1", date: "2026-06-15" });
    expect(byId.get("web-3")).toMatchObject({ priority: "p0", assignees: ["Mo"] });
    expect(byId.get("web-4")).toMatchObject({ stage: "in-review", priority: "p3" });
    expect(byId.get("web-1")!.parentId).toBe("group-sprint-1");
    expect(byId.get("group-sprint-2")).toMatchObject({ kind: "group", label: "Sprint 2" });
    // QA is blocked by both WEB-2 and WEB-3 (Jira repeats the column).
    expect(template.edges.filter((e) => e.target === "web-4").map((e) => e.source).sort()).toEqual(["web-2", "web-3"]);
  });

  it("reads a Linear export, including 'Blocked by' and a done status", () => {
    const { template } = importTaskCsv(LINEAR);
    expect(template.nodes.find((n) => n.id === "eng-10")).toMatchObject({ done: true, priority: "p0", storyPoints: 2 });
    expect(template.nodes.find((n) => n.id === "eng-11")!.priority).toBeUndefined();
    expect(template.edges.map((e) => [e.source, e.target])).toEqual([["eng-10", "eng-11"]]);
  });

  it("reads a tab-separated GitHub export with several assignees and labels", () => {
    const { template } = importTaskCsv(GITHUB);
    expect(template.nodes.find((n) => n.id === "12")).toMatchObject({ label: "Fix login", assignees: ["ana", "ravi"], tags: ["bug", "auth"] });
    expect(template.nodes.find((n) => n.id === "13")!.done).toBe(true);
  });

  it("notes a link to an issue that isn't in the export, and a row with no title", () => {
    const { warnings, stats } = importTaskCsv("Summary,Key,Blocked by\nA,K-1,K-99\n,K-2,\n");
    expect(stats.skipped).toBe(1);
    expect(warnings.map((w) => w.message)).toEqual(["Row has no title — skipped", '"K-99" isn\'t in this export — that link was left out']);
  });
});
